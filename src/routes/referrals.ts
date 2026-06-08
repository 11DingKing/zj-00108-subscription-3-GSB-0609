import { FastifyInstance, FastifyRequest } from "fastify";
import { AppDataSource } from "../data-source";
import { User } from "../entities/User";
import { Referral } from "../entities/Referral";
import { ReferralReward } from "../entities/ReferralReward";

export default async function referralRoutes(fastify: FastifyInstance) {
  const userRepository = AppDataSource.getRepository(User);
  const referralRepository = AppDataSource.getRepository(Referral);
  const referralRewardRepository = AppDataSource.getRepository(ReferralReward);

  fastify.get(
    "/my-referral-code",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Referrals"],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest) => {
      const user = await userRepository.findOne({
        where: { id: request.user.id },
      });

      if (!user) {
        throw new Error("User not found");
      }

      if (!user.referralCode) {
        user.referralCode = Math.random().toString(36).substring(2, 10).toUpperCase();
        await userRepository.save(user);
      }

      return {
        referralCode: user.referralCode,
      };
    }
  );

  fastify.post(
    "/bind-referrer",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Referrals"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["referralCode"],
          properties: {
            referralCode: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { referralCode: string } }>
    ) => {
      const user = await userRepository.findOne({
        where: { id: request.user.id },
        relations: ["referredBy"],
      });

      if (!user) {
        throw new Error("User not found");
      }

      if (user.referredBy) {
        throw new Error("You already have a referrer");
      }

      const referrer = await userRepository.findOne({
        where: { referralCode: request.body.referralCode.toUpperCase() },
      });

      if (!referrer) {
        throw new Error("Invalid referral code");
      }

      if (referrer.id === user.id) {
        throw new Error("You cannot refer yourself");
      }

      await AppDataSource.transaction(async (manager) => {
        user.referredBy = referrer;
        await manager.save(user);

        const referral = referralRepository.create({
          referrer,
          referredUser: user,
        });
        await manager.save(referral);
      });

      return {
        message: "Referrer bound successfully",
        referrer: {
          id: referrer.id,
          username: referrer.username,
        },
      };
    }
  );

  fastify.get(
    "/my-referrals",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Referrals"],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest) => {
      const referrals = await referralRepository.find({
        where: { referrer: { id: request.user.id } },
        relations: ["referredUser"],
        order: { createdAt: "DESC" },
      });

      return referrals.map((referral) => ({
        id: referral.id,
        referredUser: {
          id: referral.referredUser.id,
          username: referral.referredUser.username,
          hasReceivedFirstReward: referral.referredUser.hasReceivedFirstReward,
        },
        createdAt: referral.createdAt,
      }));
    }
  );

  fastify.get(
    "/my-rewards",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Referrals"],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest) => {
      const rewards = await referralRewardRepository.find({
        where: { referrer: { id: request.user.id } },
        relations: ["referredUser", "bill"],
        order: { createdAt: "DESC" },
      });

      const totalEarnings = rewards.reduce((sum, reward) => sum + Number(reward.amount), 0);

      return {
        totalEarnings: Number(totalEarnings.toFixed(2)),
        rewards: rewards.map((reward) => ({
          id: reward.id,
          referredUser: {
            id: reward.referredUser.id,
            username: reward.referredUser.username,
          },
          billId: reward.bill.id,
          amount: reward.amount,
          percentage: reward.percentage,
          createdAt: reward.createdAt,
        })),
      };
    }
  );

  fastify.get(
    "/stats",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Referrals"],
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const totalReferrals = await referralRepository.count();
      const totalRewards = await referralRewardRepository
        .createQueryBuilder("reward")
        .select("SUM(reward.amount)", "total")
        .getRawOne();

      const referralStats = await referralRepository
        .createQueryBuilder("referral")
        .leftJoinAndSelect("referral.referrer", "referrer")
        .select("referrer.id", "referrerId")
        .addSelect("referrer.username", "referrerUsername")
        .addSelect("COUNT(referral.id)", "referralCount")
        .groupBy("referrer.id")
        .orderBy("referralCount", "DESC")
        .limit(10)
        .getRawMany();

      return {
        totalReferrals,
        totalRewardsPaid: Number(totalRewards.total || 0),
        topReferrers: referralStats.map((stat) => ({
          referrerId: stat.referrerId,
          referrerUsername: stat.referrerUsername,
          referralCount: Number(stat.referralCount),
        })),
      };
    }
  );
}
