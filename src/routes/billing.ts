import { FastifyInstance, FastifyRequest } from "fastify";
import { AppDataSource } from "../data-source";
import { Subscription, SubscriptionStatus } from "../entities/Subscription";
import { Bill, BillStatus } from "../entities/Bill";
import { Plan, PlanType } from "../entities/Plan";
import { Coupon } from "../entities/Coupon";
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

        const originalPlan = subscription.plan;
        const planPrice = originalPlan.getActualPrice();
        const user = subscription.user;

        let discountAmount = 0;
        let coupon: Coupon | null = null;

        if (globalCoupon) {
          if (
            globalCoupon.applicablePlans.length === 0 ||
            globalCoupon.applicablePlans.some((p) => p.id === originalPlan.id)
          ) {
            coupon = globalCoupon;
            discountAmount = coupon.calculateDiscount(planPrice);
          }
        }

        const amount = Number((planPrice - discountAmount).toFixed(2));

        if (user.balance >= amount) {
          try {
            await AppDataSource.transaction(async (manager) => {
              const userRepo = manager.getRepository("User");
              const couponRepo = manager.getRepository(Coupon);
              const subRepo = manager.getRepository(Subscription);
              const billRepo = manager.getRepository(Bill);

              const dbUser = await userRepo.findOne({ where: { id: user.id } });
              if (!dbUser || dbUser.balance < amount) {
                throw new Error("Insufficient balance");
              }

              let dbCoupon: Coupon | null = null;
              let actualDiscount = 0;
              if (coupon) {
                dbCoupon = await couponRepo.findOne({
                  where: { id: coupon.id },
                  relations: ["applicablePlans"],
                });
                if (dbCoupon && dbCoupon.isUsable()) {
                  if (
                    dbCoupon.applicablePlans.length === 0 ||
                    dbCoupon.applicablePlans.some(
                      (p) => p.id === originalPlan.id,
                    )
                  ) {
                    actualDiscount = dbCoupon.calculateDiscount(planPrice);
                    dbCoupon.usedCount++;
                    await couponRepo.save(dbCoupon);
                  } else {
                    dbCoupon = null;
                  }
                } else {
                  dbCoupon = null;
                }
              }

              const finalAmount = Number(
                (planPrice - actualDiscount).toFixed(2),
              );
              if (dbUser.balance < finalAmount) {
                throw new Error("Insufficient balance after discount");
              }

              dbUser.balance = Number(
                (dbUser.balance - finalAmount).toFixed(2),
              );
              await userRepo.save(dbUser);

              const bill = billRepo.create({
                user: dbUser,
                subscription,
                plan: originalPlan,
                amount: finalAmount,
                discountAmount: actualDiscount,
                coupon: dbCoupon,
                status: BillStatus.PAID,
                description: `Renewal of ${originalPlan.name}${actualDiscount > 0 ? ` (discount: ${actualDiscount})` : ""}`,
                paidAt: now,
              });
              await billRepo.save(bill);

              let newPlan = originalPlan;
              if (subscription.pendingDowngradePlanId) {
                const foundPlan = await manager.getRepository(Plan).findOne({
                  where: { id: subscription.pendingDowngradePlanId },
                });
                if (foundPlan) {
                  newPlan = foundPlan;
                  subscription.pendingDowngradePlanId = null as any;
                }
              }

              const baseDate = new Date(
                Math.max(now.getTime(), subscription.endDate.getTime()),
              );
              const newEndDate = new Date(baseDate);
              newEndDate.setDate(
                newEndDate.getDate() + newPlan.getDurationDays(),
              );

              subscription.plan = newPlan;
              subscription.endDate = newEndDate;
              subscription.status = SubscriptionStatus.ACTIVE;
              subscription.gracePeriodEnd = null as any;
              await subRepo.save(subscription);
            });
            results.renewed++;
          } catch (e) {
            results.failed++;
          }
        } else {
          subscription.status = SubscriptionStatus.GRACE_PERIOD;
          const graceEnd = new Date(now);
          graceEnd.setDate(graceEnd.getDate() + gracePeriodDays);
          subscription.gracePeriodEnd = graceEnd;

          await subscriptionRepository.save(subscription);

          const bill = billRepository.create({
            user,
            subscription,
            plan: originalPlan,
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
