import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { User, UserRole } from "../entities/User";
import { AppDataSource } from "../data-source";



export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const decoded = await request.jwtVerify<{ userId: number }>();
        const userRepository = AppDataSource.getRepository(User);
        const user = await userRepository.findOne({
          where: { id: decoded.userId },
        });

        if (!user) {
          return reply.status(401).send({ message: "User not found" });
        }

        request.user = user;
      } catch (err) {
        reply.status(401).send({ message: "Invalid token" });
      }
    }
  );

  fastify.decorate(
    "isAdmin",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.user.role !== UserRole.ADMIN) {
        return reply.status(403).send({ message: "Admin access required" });
      }
    }
  );
});
