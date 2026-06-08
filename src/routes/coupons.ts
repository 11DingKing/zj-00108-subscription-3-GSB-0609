import { FastifyInstance, FastifyRequest } from "fastify";
import { AppDataSource } from "../data-source";
import { Coupon, CouponType } from "../entities/Coupon";
import { Plan } from "../entities/Plan";
import { In } from "typeorm";

export default async function couponRoutes(fastify: FastifyInstance) {
  const couponRepository = AppDataSource.getRepository(Coupon);
  const planRepository = AppDataSource.getRepository(Plan);

  fastify.post(
    "/",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Coupons"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["code", "type", "value"],
          properties: {
            code: { type: "string" },
            type: { type: "string", enum: ["fixed", "percentage"] },
            value: { type: "number" },
            maxUses: { type: "number" },
            expiresAt: { type: "string", format: "date-time" },
            applicablePlanIds: { type: "array", items: { type: "number" } },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: {
          code: string;
          type: CouponType;
          value: number;
          maxUses?: number;
          expiresAt?: string;
          applicablePlanIds?: number[];
        };
      }>
    ) => {
      const existingCoupon = await couponRepository.findOne({
        where: { code: request.body.code.toUpperCase() },
      });
      if (existingCoupon) {
        throw new Error("Coupon code already exists");
      }

      let applicablePlans: Plan[] = [];
      if (request.body.applicablePlanIds && request.body.applicablePlanIds.length > 0) {
        applicablePlans = await planRepository.find({
          where: { id: In(request.body.applicablePlanIds) },
        });
      }

      const coupon = couponRepository.create({
        code: request.body.code.toUpperCase(),
        type: request.body.type,
        value: request.body.value,
        maxUses: request.body.maxUses || 0,
        expiresAt: request.body.expiresAt ? new Date(request.body.expiresAt) : null,
        applicablePlans,
      });

      await couponRepository.save(coupon);

      return couponRepository.findOne({
        where: { id: coupon.id },
        relations: ["applicablePlans"],
      });
    }
  );

  fastify.get(
    "/",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Coupons"],
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      return couponRepository.find({
        relations: ["applicablePlans"],
        order: { createdAt: "DESC" },
      });
    }
  );

  fastify.get(
    "/:code",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Coupons"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { code: string } }>) => {
      const coupon = await couponRepository.findOne({
        where: { code: request.params.code.toUpperCase() },
        relations: ["applicablePlans"],
      });

      if (!coupon) {
        throw new Error("Coupon not found");
      }

      return {
        ...coupon,
        isUsable: coupon.isUsable(),
      };
    }
  );

  fastify.post(
    "/:code/validate",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Coupons"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["planId", "amount"],
          properties: {
            planId: { type: "number" },
            amount: { type: "number" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { code: string };
        Body: { planId: number; amount: number };
      }>
    ) => {
      const coupon = await couponRepository.findOne({
        where: { code: request.params.code.toUpperCase() },
        relations: ["applicablePlans"],
      });

      if (!coupon) {
        throw new Error("Coupon not found");
      }

      if (!coupon.isUsable()) {
        throw new Error("Coupon is not usable");
      }

      if (coupon.applicablePlans.length > 0) {
        const planApplicable = coupon.applicablePlans.some(
          (plan) => plan.id === request.body.planId
        );
        if (!planApplicable) {
          throw new Error("Coupon is not applicable to this plan");
        }
      }

      const discountAmount = coupon.calculateDiscount(request.body.amount);

      return {
        valid: true,
        coupon,
        discountAmount,
        finalAmount: Number((request.body.amount - discountAmount).toFixed(2)),
      };
    }
  );

  fastify.put(
    "/:id",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Coupons"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "number" },
          },
        },
        body: {
          type: "object",
          properties: {
            code: { type: "string" },
            type: { type: "string", enum: ["fixed", "percentage"] },
            value: { type: "number" },
            maxUses: { type: "number" },
            expiresAt: { type: "string", format: "date-time" },
            isActive: { type: "boolean" },
            applicablePlanIds: { type: "array", items: { type: "number" } },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: number };
        Body: {
          code?: string;
          type?: CouponType;
          value?: number;
          maxUses?: number;
          expiresAt?: string;
          isActive?: boolean;
          applicablePlanIds?: number[];
        };
      }>
    ) => {
      const coupon = await couponRepository.findOne({
        where: { id: request.params.id },
        relations: ["applicablePlans"],
      });

      if (!coupon) {
        throw new Error("Coupon not found");
      }

      if (request.body.code) {
        const existingCoupon = await couponRepository.findOne({
          where: { code: request.body.code.toUpperCase() },
        });
        if (existingCoupon && existingCoupon.id !== coupon.id) {
          throw new Error("Coupon code already exists");
        }
        coupon.code = request.body.code.toUpperCase();
      }

      if (request.body.type !== undefined) coupon.type = request.body.type;
      if (request.body.value !== undefined) coupon.value = request.body.value;
      if (request.body.maxUses !== undefined) coupon.maxUses = request.body.maxUses;
      if (request.body.expiresAt !== undefined) {
        coupon.expiresAt = request.body.expiresAt ? new Date(request.body.expiresAt) : null;
      }
      if (request.body.isActive !== undefined) coupon.isActive = request.body.isActive;

      if (request.body.applicablePlanIds) {
        if (request.body.applicablePlanIds.length > 0) {
          coupon.applicablePlans = await planRepository.find({
            where: { id: In(request.body.applicablePlanIds) },
          });
        } else {
          coupon.applicablePlans = [];
        }
      }

      await couponRepository.save(coupon);

      return couponRepository.findOne({
        where: { id: coupon.id },
        relations: ["applicablePlans"],
      });
    }
  );

  fastify.delete(
    "/:id",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Coupons"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "number" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: number } }>) => {
      const coupon = await couponRepository.findOne({
        where: { id: request.params.id },
      });

      if (!coupon) {
        throw new Error("Coupon not found");
      }

      await couponRepository.delete(coupon.id);

      return { message: "Coupon deleted successfully" };
    }
  );
}
