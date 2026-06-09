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
          status: In([
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.GRACE_PERIOD,
          ]),
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

      const globalCouponCode = request.body.couponCode
        ? request.body.couponCode.toUpperCase()
        : null;

      for (const subscription of expiredSubscriptions) {
        if (subscription.status === SubscriptionStatus.GRACE_PERIOD) {
          if (
            subscription.gracePeriodEnd &&
            now > subscription.gracePeriodEnd
          ) {
            await AppDataSource.transaction(async (manager) => {
              const subToUpdate = await manager.findOne(Subscription, {
                where: { id: subscription.id },
                relations: ["plan"],
              });
              if (subToUpdate) {
                if (freePlan) {
                  subToUpdate.plan = freePlan;
                  subToUpdate.status = SubscriptionStatus.ACTIVE;
                  subToUpdate.autoRenew = false;
                } else {
                  subToUpdate.status = SubscriptionStatus.EXPIRED;
                }
                subToUpdate.gracePeriodEnd = null as any;
                await manager.save(subToUpdate);
              }
            });
            results.downgraded++;
          }
          continue;
        }

        const currentPlan = subscription.plan;
        const planPrice = currentPlan.getActualPrice();
        const planDurationDays = currentPlan.getDurationDays();
        const user = subscription.user;

        let discountAmount = 0;
        let coupon: Coupon | null = null;

        if (globalCouponCode) {
          const freshCoupon = await couponRepository.findOne({
            where: { code: globalCouponCode },
            relations: ["applicablePlans"],
          });
          if (freshCoupon && freshCoupon.isUsable()) {
            if (
              freshCoupon.applicablePlans.length === 0 ||
              freshCoupon.applicablePlans.some(
                (p) => p.id === currentPlan.id,
              )
            ) {
              coupon = freshCoupon;
              discountAmount = coupon.calculateDiscount(planPrice);
            }
          }
        }

        const amount = Number((planPrice - discountAmount).toFixed(2));

        if (user.balance >= amount) {
          await AppDataSource.transaction(async (manager) => {
            const managedUser = await manager.findOne(User, {
              where: { id: user.id },
            });
            if (!managedUser) {
              throw new Error(`User ${user.id} not found during renewal`);
            }
            if (Number(managedUser.balance) < amount) {
              throw new Error(`Insufficient balance for user ${user.id}`);
            }

            managedUser.balance = Number(
              (Number(managedUser.balance) - amount).toFixed(2)
            );
            await manager.save(managedUser);

            let renewalPlan = currentPlan;
            if (subscription.pendingDowngradePlanId) {
              const downgradePlan = await manager.findOne(Plan, {
                where: { id: subscription.pendingDowngradePlanId },
              });
              if (downgradePlan) {
                renewalPlan = downgradePlan;
              }
            }

            const bill = billRepository.create({
              user: managedUser,
              subscription,
              plan: renewalPlan,
              amount,
              discountAmount,
              coupon,
              status: BillStatus.PAID,
              description: `Renewal of ${renewalPlan.name}${discountAmount > 0 ? ` (discount: ${discountAmount})` : ""}`,
              paidAt: now,
            });
            await manager.save(bill);

            if (coupon) {
              coupon.usedCount++;
              await manager.save(coupon);
            }

            const managedSub = await manager.findOne(Subscription, {
              where: { id: subscription.id },
              relations: ["plan"],
            });
            if (managedSub) {
              const baseDate = new Date(
                Math.max(now.getTime(), managedSub.endDate.getTime())
              );
              const newEndDate = new Date(baseDate);
              newEndDate.setDate(newEndDate.getDate() + planDurationDays);
              managedSub.endDate = newEndDate;
              managedSub.status = SubscriptionStatus.ACTIVE;
              managedSub.gracePeriodEnd = null as any;
              if (subscription.pendingDowngradePlanId && renewalPlan !== currentPlan) {
                managedSub.plan = renewalPlan;
                managedSub.pendingDowngradePlanId = null as any;
              }
              await manager.save(managedSub);
            }
          });
          results.renewed++;
        } else {
          subscription.status = SubscriptionStatus.GRACE_PERIOD;
          const graceEnd = new Date(now);
          graceEnd.setDate(graceEnd.getDate() + gracePeriodDays);
          subscription.gracePeriodEnd = graceEnd;

          await subscriptionRepository.save(subscription);

          const bill = billRepository.create({
            user,
            subscription,
            plan: subscription.plan,
            amount,
            discountAmount,
            coupon,
            status: BillStatus.FAILED,
            description: `Renewal failed - insufficient balance. Grace period until ${graceEnd.toISOString()}`,
          });
          await billRepository.save(bill);

          results.failed++;
          results.gracePeriod++;
        }
      }

      return results;
    },
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
      }>,
    ) => {
      const where: any = { user: { id: request.user.id } };

      if (request.query.status) {
        where.status = request.query.status;
      }

      if (request.query.startDate && request.query.endDate) {
        where.createdAt = Between(
          new Date(request.query.startDate),
          new Date(request.query.endDate),
        );
      }

      return billRepository.find({
        where,
        relations: ["plan"],
        order: { createdAt: "DESC" },
      });
    },
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
      }>,
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
          new Date(request.query.endDate),
        );
      }

      return billRepository.find({
        where,
        relations: ["user", "plan"],
        order: { createdAt: "DESC" },
      });
    },
  );
}
