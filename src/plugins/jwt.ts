import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { Env } from "../env.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; typ: "access" };
    user: { sub: string; typ: "access" };
  }
}

export const jwtPlugin: FastifyPluginAsync<{ env: Env }> = fp(
  async (app: FastifyInstance, opts: { env: Env }) => {
    app.register(fastifyJwt, {
      secret: opts.env.JWT_ACCESS_SECRET,
      sign: { expiresIn: opts.env.JWT_ACCESS_TTL_SECONDS }
    });
  }
);