import type { FastifyPluginAsync } from "fastify";

import { authRoutes } from "./auth.js";
import { operatorRoutes } from "./operators.js";
import { bookingRoutes } from "./bookings.js";
import { analyticsRoutes } from "./analytics.js";

export const apiV1Routes: FastifyPluginAsync = async (app) => {
  app.get("/ping", async () => ({ pong: true }));

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(operatorRoutes, { prefix: "/operators" });
  await app.register(bookingRoutes, { prefix: "/bookings" });
  await app.register(analyticsRoutes, { prefix: "/analytics" });
};