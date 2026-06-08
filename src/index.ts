import fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { AppDataSource } from "./data-source";
import authPlugin from "./plugins/auth";
import authRoutes from "./routes/auth";
import planRoutes from "./routes/plans";
import subscriptionRoutes from "./routes/subscriptions";
import billingRoutes from "./routes/billing";
import statsRoutes from "./routes/stats";
import couponRoutes from "./routes/coupons";
import referralRoutes from "./routes/referrals";

const server = fastify({ logger: true });

server.register(fastifyJwt, {
  secret: "subscription-billing-secret-key-change-in-production",
});

server.register(fastifySwagger, {
  openapi: {
    info: {
      title: "Subscription Billing API",
      description: "Subscription billing and periodic deduction system",
      version: "1.0.0",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
});

server.register(fastifySwaggerUi, {
  routePrefix: "/api/docs",
});

server.register(authPlugin);

server.get("/api/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

server.register(authRoutes, { prefix: "/api/auth" });
server.register(planRoutes, { prefix: "/api/plans" });
server.register(subscriptionRoutes, { prefix: "/api/subscriptions" });
server.register(billingRoutes, { prefix: "/api/billing" });
server.register(statsRoutes, { prefix: "/api/stats" });
server.register(couponRoutes, { prefix: "/api/coupons" });
server.register(referralRoutes, { prefix: "/api/referrals" });

const start = async () => {
  try {
    await AppDataSource.initialize();
    await server.listen({ port: 3000, host: "0.0.0.0" });
    console.log("Server running on http://localhost:3000");
    console.log("Swagger docs: http://localhost:3000/api/docs");
    console.log("Health check: http://localhost:3000/api/health");
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
