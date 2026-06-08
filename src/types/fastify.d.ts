import { User } from "../entities/User";
import { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: any;
    isAdmin: any;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: number };
    user: User;
  }
}
