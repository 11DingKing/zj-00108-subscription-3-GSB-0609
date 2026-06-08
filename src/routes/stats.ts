import { FastifyInstance } from "fastify";
import { AppDataSource } from "../data-source";
import { Subscription, SubscriptionStatus } from "../entities/Subscription";
import { Bill, BillStatus } from "../entities/Bill";
import { PlanType } from "../entities/Plan";
import { Coupon } from "../entities/Coupon";
import { ReferralReward } from "../entities/ReferralReward";
import { In, Between, Raw } from "typeorm";

export default async function statsRoutes(fastify: FastifyInstance) {
  const subscriptionRepository = AppDataSource.getRepository(Subscription);
  const billRepository = AppDataSource.getRepository(Bill);
  const couponRepository = AppDataSource.getRepository(Coupon);
  const referralRewardRepository = AppDataSource.getRepository(ReferralReward);

  fastify.get(
    "/",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Stats"],
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      const activeSubscriptions = await subscriptionRepository.find({
        where: {
          status: SubscriptionStatus.ACTIVE,
        },
        relations: ["plan"],
      });

      let mrr = 0;
      for (const sub of activeSubscriptions) {
        const dailyRate = sub.plan.getActualPrice() / sub.plan.getDurationDays();
        mrr += dailyRate * 30;
      }
      mrr = Number(mrr.toFixed(2));

      const arr = Number((mrr * 12).toFixed(2));

      const currentMonthRevenue = await billRepository
        .createQueryBuilder("bill")
        .select("SUM(bill.amount)", "total")
        .where("bill.status = :status", { status: BillStatus.PAID })
        .andWhere("bill.createdAt >= :start", { start: currentMonthStart })
        .getRawOne();

      const lastMonthRevenue = await billRepository
        .createQueryBuilder("bill")
        .select("SUM(bill.amount)", "total")
        .where("bill.status = :status", { status: BillStatus.PAID })
        .andWhere("bill.createdAt >= :start", { start: lastMonthStart })
        .andWhere("bill.createdAt < :end", { end: currentMonthStart })
        .getRawOne();

      const churnRate =
        lastMonthRevenue.total > 0
          ? Number(
              (
                ((Number(lastMonthRevenue.total || 0) - Number(currentMonthRevenue.total || 0)) /
                  Number(lastMonthRevenue.total || 1)) *
                100
              ).toFixed(2)
            )
          : 0;

      const planDistribution: Record<string, number> = {
        [PlanType.MONTHLY]: 0,
        [PlanType.QUARTERLY]: 0,
        [PlanType.YEARLY]: 0,
      };

      for (const sub of activeSubscriptions) {
        planDistribution[sub.plan.type]++;
      }

      const couponUsageStats = await billRepository
        .createQueryBuilder("bill")
        .leftJoinAndSelect("bill.coupon", "coupon")
        .select("coupon.code", "code")
        .addSelect("COUNT(bill.id)", "usageCount")
        .addSelect("SUM(bill.discountAmount)", "totalDiscount")
        .where("bill.coupon IS NOT NULL")
        .groupBy("coupon.id")
        .addGroupBy("coupon.code")
        .getRawMany();

      const totalDiscountGiven = await billRepository
        .createQueryBuilder("bill")
        .select("SUM(bill.discountAmount)", "total")
        .where("bill.discountAmount > 0")
        .getRawOne();

      const totalReferralRewards = await referralRewardRepository
        .createQueryBuilder("reward")
        .select("SUM(reward.amount)", "total")
        .getRawOne();

      const currentMonthReferralRewards = await referralRewardRepository
        .createQueryBuilder("reward")
        .select("SUM(reward.amount)", "total")
        .where("reward.createdAt >= :start", { start: currentMonthStart })
        .getRawOne();

      const activeCouponsCount = await couponRepository.count({
        where: { isActive: true },
      });

      return {
        mrr,
        arr,
        churnRate: Math.max(0, churnRate),
        activeSubscriptions: activeSubscriptions.length,
        planDistribution,
        currentMonthRevenue: Number(currentMonthRevenue.total || 0),
        couponStats: {
          activeCouponsCount,
          totalDiscountGiven: Number(totalDiscountGiven.total || 0),
          couponUsageBreakdown: couponUsageStats.map((stat) => ({
            code: stat.code,
            usageCount: Number(stat.usageCount),
            totalDiscount: Number(stat.totalDiscount),
          })),
        },
        referralStats: {
          totalReferralRewardsPaid: Number(totalReferralRewards.total || 0),
          currentMonthReferralRewards: Number(currentMonthReferralRewards.total || 0),
        },
      };
    }
  );
}
