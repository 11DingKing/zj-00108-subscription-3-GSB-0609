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

        const couponPlanApplicable =
          !!globalCoupon &&
          (globalCoupon.applicablePlans.length === 0 ||
            globalCoupon.applicablePlans.some(
              (p) => p.id === subscription.plan.id,
            ));

        // Pre-check using best-case (discounted) amount; final amount is
        // recomputed inside the transaction once we know whether the shared
        // coupon could actually be reserved (maxUses may have been hit).
        const optimisticDiscount =
          couponPlanApplicable && globalCoupon!.isUsable()
            ? globalCoupon!.calculateDiscount(planPrice)
            : 0;
        const optimisticAmount = Number(
          (planPrice - optimisticDiscount).toFixed(2),
        );

        const GRACE_FALLBACK = Symbol("graceFallback");
        let renewed = false;
        let graceFallbackAmount = 0;

        if (user.balance >= optimisticAmount) {
          try {
            await AppDataSource.transaction(async (manager) => {
              let coupon: Coupon | null = null;
              let actualDiscount = 0;

              if (couponPlanApplicable) {
                // Atomic conditional reservation: only succeeds while
                // maxUses hasn't been exhausted, preventing oversell even
                // across concurrent runs.
                const reserveResult = await manager
                  .createQueryBuilder()
                  .update(Coupon)
                  .set({ usedCount: () => `"usedCount" + 1` })
                  .where(
                    `"id" = :id
                     AND "isActive" = 1
                     AND ("expiresAt" IS NULL OR "expiresAt" > :now)
                     AND ("maxUses" = 0 OR "usedCount" < "maxUses")`,
                    { id: globalCoupon!.id, now },
                  )
                  .execute();

                if (reserveResult.affected && reserveResult.affected > 0) {
                  coupon = globalCoupon;
                  // Keep the in-memory shared coupon in sync so the next
                  // iteration's isUsable() check reflects the new count.
                  globalCoupon!.usedCount++;
                  actualDiscount = globalCoupon!.calculateDiscount(planPrice);
                }
                // If reservation failed, coupon is exhausted -> fall back
                // to renewing at full price without a discount.
              }

              const actualAmount = Number(
                (planPrice - actualDiscount).toFixed(2),
              );

              // Coupon may have failed to reserve; re-check balance against
              // the real amount before charging the user.
              if (user.balance < actualAmount) {
                graceFallbackAmount = actualAmount;
                throw GRACE_FALLBACK;
              }

              user.balance = Number((user.balance - actualAmount).toFixed(2));
              await manager.save(User, user);

              const bill = billRepository.create({
                user,
                subscription,
                plan: subscription.plan,
                amount: actualAmount,
                discountAmount: actualDiscount,
                coupon,
                status: BillStatus.PAID,
                description: `Renewal of ${subscription.plan.name}${actualDiscount > 0 ? ` (discount: ${actualDiscount})` : ""}`,
                paidAt: now,
              });
              await manager.save(bill);

              // Extend the new end date using the CURRENT (paid) plan's
              // duration first, so users don't get a high-tier period
              // priced as a low-tier renewal.
              const renewalBase =
                subscription.endDate.getTime() > now.getTime()
                  ? new Date(subscription.endDate)
                  : new Date(now);
              renewalBase.setDate(
                renewalBase.getDate() + subscription.plan.getDurationDays(),
              );
              subscription.endDate = renewalBase;

              // Apply any pending downgrade AFTER computing the new end
              // date; the downgrade only takes effect for the next cycle.
              if (subscription.pendingDowngradePlanId) {
                const newPlan = await manager.findOne(Plan, {
                  where: { id: subscription.pendingDowngradePlanId },
                });
                if (newPlan) {
                  subscription.plan = newPlan;
                  subscription.pendingDowngradePlanId = null as any;
                }
              }

              subscription.status = SubscriptionStatus.ACTIVE;
              subscription.gracePeriodEnd = null as any;
              await manager.save(subscription);

              renewed = true;
            });
          } catch (err) {
            if (err !== GRACE_FALLBACK) {
              throw err;
            }
          }
        }

        if (renewed) {
          results.renewed++;
        } else {
          subscription.status = SubscriptionStatus.GRACE_PERIOD;
          const graceEnd = new Date(now);
          graceEnd.setDate(graceEnd.getDate() + gracePeriodDays);
          subscription.gracePeriodEnd = graceEnd;

          await subscriptionRepository.save(subscription);

          const failedAmount =
            graceFallbackAmount > 0 ? graceFallbackAmount : optimisticAmount;
          const bill = billRepository.create({
            user,
            subscription,
            plan: subscription.plan,
            amount: failedAmount,
            discountAmount: 0,
            coupon: null,
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
