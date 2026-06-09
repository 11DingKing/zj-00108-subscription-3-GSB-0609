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

      let globalCoupon: Coupon | null = null;
      if (request.body.couponCode) {
        globalCoupon = await couponRepository.findOne({
          where: { code: request.body.couponCode.toUpperCase() },
          relations: ["applicablePlans"],
        });
      }

      for (const subscription of expiredSubscriptions) {
        if (subscription.status === SubscriptionStatus.GRACE_PERIOD) {
          if (
            subscription.gracePeriodEnd &&
            now > subscription.gracePeriodEnd
          ) {
            if (freePlan) {
              subscription.plan = freePlan;
              subscription.status = SubscriptionStatus.ACTIVE;
              subscription.autoRenew = false;
            } else {
              subscription.status = SubscriptionStatus.EXPIRED;
            }
            subscription.gracePeriodEnd = null as any;
            await subscriptionRepository.save(subscription);
            results.downgraded++;
          }
          continue;
        }

        const planPrice = subscription.plan.getActualPrice();
        const user = subscription.user;

        let discountAmount = 0;
        let coupon: Coupon | null = null;

        if (globalCoupon && globalCoupon.isUsable()) {
          if (
            globalCoupon.applicablePlans.length === 0 ||
            globalCoupon.applicablePlans.some(
              (p) => p.id === subscription.plan.id,
            )
          ) {
            coupon = globalCoupon;
            discountAmount = coupon.calculateDiscount(planPrice);
          }
        }

        const amount = Number((planPrice - discountAmount).toFixed(2));

        if (user.balance >= amount) {
          await AppDataSource.transaction(async (manager) => {
            if (coupon) {
              const freshCoupon = await manager.findOne(Coupon, {
                where: { id: coupon.id },
                relations: ["applicablePlans"],
              });
              if (!freshCoupon || !freshCoupon.isUsable()) {
                throw new Error("Coupon is no longer usable");
              }
              freshCoupon.usedCount++;
              await manager.save(freshCoupon);
            }

            user.balance = Number((user.balance - amount).toFixed(2));
            await manager.save(User, user);

            const bill = billRepository.create({
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

            if (subscription.pendingDowngradePlanId) {
              const newPlan = await manager.findOne(Plan, {
                where: { id: subscription.pendingDowngradePlanId },
              });
              if (newPlan) {
                subscription.plan = newPlan;
                subscription.pendingDowngradePlanId = null as any;
              }
            }

            const renewalBase =
              subscription.endDate.getTime() > now.getTime()
                ? new Date(subscription.endDate)
                : new Date(now);
            renewalBase.setDate(
              renewalBase.getDate() + subscription.plan.getDurationDays(),
            );
            subscription.endDate = renewalBase;
            subscription.status = SubscriptionStatus.ACTIVE;
            subscription.gracePeriodEnd = null as any;
            await manager.save(subscription);
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
