import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "../data-source";
import { User } from "../entities/User";

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/login",
    {
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string" },
            password: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              user: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  username: { type: "string" },
                  role: { type: "string" },
                  balance: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { username: string; password: string } }>,
      reply: FastifyReply
    ) => {
      const { username, password } = request.body;
      const userRepository = AppDataSource.getRepository(User);
      const user = await userRepository.findOne({ where: { username } });

      if (!user || user.password !== password) {
        return reply.status(401).send({ message: "Invalid credentials" });
      }

      const token = fastify.jwt.sign({ userId: user.id });
      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          balance: user.balance,
        },
      };
    }
  );

  fastify.get(
    "/me",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "number" },
              username: { type: "string" },
              role: { type: "string" },
              balance: { type: "number" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest) => {
      return {
        id: request.user.id,
        username: request.user.username,
        role: request.user.role,
        balance: request.user.balance,
      };
    }
  );
}
