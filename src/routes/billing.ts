import { FastifyInstance, FastifyRequest } from "fastify";
import { AppDataSource } from "../data-source";
import { Subscription, SubscriptionStatus } from "../entities/Subscription";
import { Bill, BillStatus } from "../entities/Bill";
import { Plan, PlanType } from "../entities/Plan";
import { Coupon } from "../entities/Coupon";
import { User } from "../entities/User";
import { In, LessThan, MoreThan, Between } from "typeorm";

export default async function billingRoutes(fastify: FastifyInstance) {
  const subscriptionRepository = AppDataSource.getRepository(Subscription);
  const billRepository = AppDataSource.getRepository(Bill);
  const planRepository = AppDataSource.getRepository(Plan);
  const couponRepository = AppDataSource.getRepository(Coupon);

  fastify.post(
    "/execute-deduction",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Billing"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          properties: {
            couponCode: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { couponCode?: string } }>) => {
      const now = new Date();
      const gracePeriodDays = 3;

      const expiredSubscriptions = await subscriptionRepository.find({
        where: {
          endDate: LessThan(now),
          autoRenew: true,
          status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE_PERIOD]),
        },
        relations: ["user", "plan"],
      });

      const results = {
        renewed: 0,
        failed: 0,
        gracePeriod: 0,
        downgraded: 0,
      };

      const freePlan = await planRepository.findOne({
        where: { type: PlanType.FREE },
      });

      let globalCoupon: Coupon | null = null;
      if (request.body.couponCode) {
        globalCoupon = await couponRepository.findOne({
          where: { code: request.body.couponCode.toUpperCase() },
          relations: ["applicablePlans"],
        });
      }

      for (const subscription of expiredSubscriptions) {
        if (subscription.status === SubscriptionStatus.GRACE_PERIOD) {
          if (subscription.gracePeriodEnd && now > subscription.gracePeriodEnd) {
            await AppDataSource.transaction(async (manager) => {
              if (freePlan) {
                subscription.plan = freePlan;
                subscription.status = SubscriptionStatus.ACTIVE;
                subscription.autoRenew = false;
              } else {
                subscription.status = SubscriptionStatus.EXPIRED;
              }
              subscription.gracePeriodEnd = null as any;
              await manager.save(subscription);
            });
            results.downgraded++;
          }
          continue;
        }

        const planPrice = subscription.plan.getActualPrice();

        await AppDataSource.transaction(async (manager) => {
          const user = await manager.findOne(User, {
            where: { id: subscription.user.id },
          });
          if (!user) return;

          let discountAmount = 0;
          let coupon: Coupon | null = null;

          if (globalCoupon) {
            const freshCoupon = await manager.findOne(Coupon, {
              where: { id: globalCoupon.id },
              relations: ["applicablePlans"],
            });
            if (freshCoupon && freshCoupon.isUsable()) {
              if (
                freshCoupon.applicablePlans.length === 0 ||
                freshCoupon.applicablePlans.some(
                  (p) => p.id === subscription.plan.id
                )
              ) {
                coupon = freshCoupon;
                discountAmount = coupon.calculateDiscount(planPrice);
              }
            }
          }

          const amount = Number((planPrice - discountAmount).toFixed(2));

          if (user.balance >= amount) {
            user.balance = Number((user.balance - amount).toFixed(2));
            await manager.save(user);

            if (coupon) {
              coupon.usedCount++;
              await manager.save(coupon);
              globalCoupon!.usedCount = coupon.usedCount;
            }

            const bill = manager.create(Bill, {
              user,
              subscription,
              plan: subscription.plan,
              amount,
              discountAmount,
              coupon,
              status: BillStatus.PAID,
              description: `Renewal of ${subscription.plan.name}${discountAmount > 0 ? ` (discount: ${discountAmount})` : ""}`,
              paidAt: now,
            });
            await manager.save(bill);

            const baseDate = new Date(
              Math.max(now.getTime(), subscription.endDate.getTime())
            );
            const newEndDate = new Date(baseDate);
            newEndDate.setDate(
              newEndDate.getDate() + subscription.plan.getDurationDays()
            );

            if (subscription.pendingDowngradePlanId) {
              const newPlan = await manager.findOne(Plan, {
                where: { id: subscription.pendingDowngradePlanId },
              });
              if (newPlan) {
                subscription.plan = newPlan;
                subscription.pendingDowngradePlanId = null as any;
              }
            }

            subscription.endDate = newEndDate;
            subscription.status = SubscriptionStatus.ACTIVE;
            subscription.gracePeriodEnd = null as any;
            await manager.save(subscription);
            results.renewed++;
          } else {
            subscription.status = SubscriptionStatus.GRACE_PERIOD;
            const graceEnd = new Date(now);
            graceEnd.setDate(graceEnd.getDate() + gracePeriodDays);
            subscription.gracePeriodEnd = graceEnd;
            await manager.save(subscription);

            const bill = manager.create(Bill, {
              user,
              subscription,
              plan: subscription.plan,
              amount,
              discountAmount,
              status: BillStatus.FAILED,
              description: `Renewal failed - insufficient balance. Grace period until ${graceEnd.toISOString()}`,
            });
            await manager.save(bill);
            results.failed++;
            results.gracePeriod++;
          }
        });
      }

      return results;
    }
  );

  fastify.get(
    "/bills",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Billing"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            startDate: { type: "string" },
            endDate: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: { status?: string; startDate?: string; endDate?: string };
      }>
    ) => {
      const where: any = { user: { id: request.user.id } };

      if (request.query.status) {
        where.status = request.query.status;
      }

      if (request.query.startDate && request.query.endDate) {
        where.createdAt = Between(
          new Date(request.query.startDate),
          new Date(request.query.endDate)
        );
      }

      return billRepository.find({
        where,
        relations: ["plan"],
        order: { createdAt: "DESC" },
      });
    }
  );

  fastify.get(
    "/bills/all",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Billing"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            userId: { type: "number" },
            status: { type: "string" },
            startDate: { type: "string" },
            endDate: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: {
          userId?: number;
          status?: string;
          startDate?: string;
          endDate?: string;
        };
      }>
    ) => {
      const where: any = {};

      if (request.query.userId) {
        where.user = { id: request.query.userId };
      }

      if (request.query.status) {
        where.status = request.query.status;
      }

      if (request.query.startDate && request.query.endDate) {
        where.createdAt = Between(
          new Date(request.query.startDate),
          new Date(request.query.endDate)
        );
      }

      return billRepository.find({
        where,
        relations: ["user", "plan"],
        order: { createdAt: "DESC" },
      });
    }
  );
}
