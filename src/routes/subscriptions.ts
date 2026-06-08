import { FastifyInstance, FastifyRequest } from "fastify";
import { AppDataSource } from "../data-source";
import { Subscription, SubscriptionStatus } from "../entities/Subscription";
import { Plan } from "../entities/Plan";
import { Bill, BillStatus } from "../entities/Bill";
import { Coupon } from "../entities/Coupon";
import { User } from "../entities/User";
import { ReferralReward } from "../entities/ReferralReward";
import { In, LessThan, MoreThan } from "typeorm";

export default async function subscriptionRoutes(fastify: FastifyInstance) {
  const subscriptionRepository = AppDataSource.getRepository(Subscription);
  const planRepository = AppDataSource.getRepository(Plan);
  const billRepository = AppDataSource.getRepository(Bill);
  const couponRepository = AppDataSource.getRepository(Coupon);
  const userRepository = AppDataSource.getRepository(User);
  const referralRewardRepository = AppDataSource.getRepository(ReferralReward);

  fastify.get(
    "/my",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Subscriptions"],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest) => {
      return subscriptionRepository.find({
        where: { user: { id: request.user.id } },
        relations: ["plan"],
        order: { createdAt: "DESC" },
      });
    }
  );

  fastify.post(
    "/subscribe",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Subscriptions"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["planId"],
          properties: {
            planId: { type: "number" },
            autoRenew: { type: "boolean" },
            couponCode: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { planId: number; autoRenew?: boolean; couponCode?: string };
      }>
    ) => {
      const { planId, autoRenew = true, couponCode } = request.body;
      const plan = await planRepository.findOne({ where: { id: planId } });

      if (!plan || !plan.isActive) {
        throw new Error("Invalid plan");
      }

      const activeSubscription = await subscriptionRepository.findOne({
        where: {
          user: { id: request.user.id },
          status: In([
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.TRIAL,
            SubscriptionStatus.GRACE_PERIOD,
          ]),
        },
      });

      if (activeSubscription) {
        throw new Error("Already have an active subscription");
      }

      let discountAmount = 0;
      let coupon: Coupon | null = null;

      if (couponCode) {
        coupon = await couponRepository.findOne({
          where: { code: couponCode.toUpperCase() },
          relations: ["applicablePlans"],
        });

        if (!coupon) {
          throw new Error("Invalid coupon code");
        }

        if (!coupon.isUsable()) {
          throw new Error("Coupon is not usable");
        }

        if (coupon.applicablePlans.length > 0) {
          const planApplicable = coupon.applicablePlans.some(
            (p) => p.id === planId
          );
          if (!planApplicable) {
            throw new Error("Coupon is not applicable to this plan");
          }
        }

        discountAmount = coupon.calculateDiscount(plan.getActualPrice());
      }

      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + plan.getDurationDays());

      const subscription = subscriptionRepository.create({
        user: request.user,
        plan,
        startDate,
        endDate,
        autoRenew,
        status: SubscriptionStatus.ACTIVE,
      });

      await subscriptionRepository.save(subscription);

      const finalAmount = Number((plan.getActualPrice() - discountAmount).toFixed(2));

      const bill = billRepository.create({
        user: request.user,
        subscription,
        plan,
        amount: finalAmount,
        discountAmount,
        coupon,
        status: BillStatus.PAID,
        description: `Subscription to ${plan.name}${discountAmount > 0 ? ` (discount: ${discountAmount})` : ""}`,
        paidAt: new Date(),
      });

      await AppDataSource.transaction(async (manager) => {
        if (coupon) {
          coupon.usedCount++;
          await manager.save(coupon);
        }

        await manager.save(bill);

        const user = await userRepository.findOne({
          where: { id: request.user.id },
          relations: ["referredBy"],
        });

        if (user && user.referredBy && !user.hasReceivedFirstReward) {
          const referralPercentage = 10;
          const rewardAmount = Number(((finalAmount * referralPercentage) / 100).toFixed(2));

          const referralReward = referralRewardRepository.create({
            referrer: user.referredBy,
            referredUser: user,
            bill,
            amount: rewardAmount,
            percentage: referralPercentage,
          });
          await manager.save(referralReward);

          user.referredBy.balance = Number(
            (Number(user.referredBy.balance) + rewardAmount).toFixed(2)
          );
          await manager.save(user.referredBy);

          user.hasReceivedFirstReward = true;
          await manager.save(user);
        }
      });

      return subscriptionRepository.findOne({
        where: { id: subscription.id },
        relations: ["plan"],
      });
    }
  );

  fastify.post(
    "/:id/upgrade",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Subscriptions"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" } },
        },
        body: {
          type: "object",
          required: ["newPlanId"],
          properties: {
            newPlanId: { type: "number" },
            couponCode: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: number };
        Body: { newPlanId: number; couponCode?: string };
      }>
    ) => {
      const subscription = await subscriptionRepository.findOne({
        where: { id: request.params.id, user: { id: request.user.id } },
        relations: ["plan"],
      });

      if (!subscription) {
        throw new Error("Subscription not found");
      }

      const newPlan = await planRepository.findOne({
        where: { id: request.body.newPlanId },
      });

      if (!newPlan || !newPlan.isActive) {
        throw new Error("Invalid plan");
      }

      if (newPlan.getDurationDays() <= subscription.plan.getDurationDays()) {
        throw new Error("Use downgrade endpoint for downgrading");
      }

      const now = new Date();
      const remainingDays = Math.max(
        0,
        Math.ceil(
          (subscription.endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        )
      );

      const oldPlanPrice = subscription.plan.getActualPrice();
      const oldPlanDays = subscription.plan.getDurationDays();
      const remainingValue = oldPlanPrice * (remainingDays / oldPlanDays);
      const priceDiff = newPlan.getActualPrice() - remainingValue;

      if (priceDiff > 0) {
        let discountAmount = 0;
        let coupon: Coupon | null = null;

        if (request.body.couponCode) {
          coupon = await couponRepository.findOne({
            where: { code: request.body.couponCode.toUpperCase() },
            relations: ["applicablePlans"],
          });

          if (!coupon) {
            throw new Error("Invalid coupon code");
          }

          if (!coupon.isUsable()) {
            throw new Error("Coupon is not usable");
          }

          if (coupon.applicablePlans.length > 0) {
            const planApplicable = coupon.applicablePlans.some(
              (p) => p.id === newPlan.id
            );
            if (!planApplicable) {
              throw new Error("Coupon is not applicable to this plan");
            }
          }

          discountAmount = coupon.calculateDiscount(priceDiff);
        }

        const finalAmount = Number((priceDiff - discountAmount).toFixed(2));

        const bill = billRepository.create({
          user: request.user,
          subscription,
          plan: newPlan,
          amount: Math.max(0, finalAmount),
          discountAmount,
          coupon,
          status: BillStatus.PAID,
          description: `Upgrade from ${subscription.plan.name} to ${newPlan.name}${discountAmount > 0 ? ` (discount: ${discountAmount})` : ""}`,
          paidAt: new Date(),
        });

        await AppDataSource.transaction(async (manager) => {
          if (coupon) {
            coupon.usedCount++;
            await manager.save(coupon);
          }
          await manager.save(bill);
        });
      }

      subscription.plan = newPlan;
      subscription.endDate = new Date(
        now.getTime() + newPlan.getDurationDays() * 24 * 60 * 60 * 1000
      );

      await subscriptionRepository.save(subscription);

      return subscriptionRepository.findOne({
        where: { id: subscription.id },
        relations: ["plan"],
      });
    }
  );

  fastify.post(
    "/:id/downgrade",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Subscriptions"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" } },
        },
        body: {
          type: "object",
          required: ["newPlanId"],
          properties: { newPlanId: { type: "number" } },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: number };
        Body: { newPlanId: number };
      }>
    ) => {
      const subscription = await subscriptionRepository.findOne({
        where: { id: request.params.id, user: { id: request.user.id } },
        relations: ["plan"],
      });

      if (!subscription) {
        throw new Error("Subscription not found");
      }

      const newPlan = await planRepository.findOne({
        where: { id: request.body.newPlanId },
      });

      if (!newPlan || !newPlan.isActive) {
        throw new Error("Invalid plan");
      }

      subscription.pendingDowngradePlanId = newPlan.id;
      await subscriptionRepository.save(subscription);

      return {
        message: `Downgrade scheduled. Will take effect on ${subscription.endDate.toISOString()}`,
      };
    }
  );

  fastify.post(
    "/:id/cancel",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Subscriptions"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: number } }>
    ) => {
      const subscription = await subscriptionRepository.findOne({
        where: { id: request.params.id, user: { id: request.user.id } },
      });

      if (!subscription) {
        throw new Error("Subscription not found");
      }

      subscription.autoRenew = false;
      await subscriptionRepository.save(subscription);

      return { message: "Auto-renew cancelled" };
    }
  );
}
