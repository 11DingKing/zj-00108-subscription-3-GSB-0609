import { FastifyInstance, FastifyRequest } from "fastify";
import { AppDataSource } from "../data-source";
import { Plan } from "../entities/Plan";

export default async function planRoutes(fastify: FastifyInstance) {
  const planRepository = AppDataSource.getRepository(Plan);

  fastify.get(
    "/",
    {
      schema: {
        tags: ["Plans"],
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
                type: { type: "string" },
                price: { type: "number" },
                discount: { type: "number" },
                description: { type: "string" },
                isActive: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    async () => {
      return planRepository.find({ where: { isActive: true } });
    }
  );

  fastify.post(
    "/",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Plans"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["name", "type", "price"],
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["monthly", "quarterly", "yearly"] },
            price: { type: "number" },
            discount: { type: "number" },
            description: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: Partial<Plan> }>) => {
      const plan = planRepository.create(request.body);
      return planRepository.save(plan);
    }
  );

  fastify.put(
    "/:id",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Plans"],
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
            name: { type: "string" },
            type: { type: "string", enum: ["monthly", "quarterly", "yearly"] },
            price: { type: "number" },
            discount: { type: "number" },
            description: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: number }; Body: Partial<Plan> }>
    ) => {
      await planRepository.update(request.params.id, request.body);
      return planRepository.findOne({ where: { id: request.params.id } });
    }
  );

  fastify.delete(
    "/:id",
    {
      onRequest: [fastify.authenticate, fastify.isAdmin],
      schema: {
        tags: ["Plans"],
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
    async (
      request: FastifyRequest<{ Params: { id: number } }>,
      reply
    ) => {
      await planRepository.update(request.params.id, { isActive: false });
      return reply.status(204).send();
    }
  );
}
