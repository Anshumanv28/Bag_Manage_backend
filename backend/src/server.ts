import "dotenv/config";

import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";

import { loadEnv } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { apiV1Routes } from "./routes/api_v1.js";
import { syncRoutes } from "./routes/sync.js";
import { jwtPlugin } from "./plugins/jwt.js";

const env = loadEnv();

const pretty = env.LOG_PRETTY || env.NODE_ENV === "development";

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL === "silent" ? "fatal" : env.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.x-admin-key",
        "request.headers.authorization",
        "request.headers.x-admin-key"
      ],
      censor: "[REDACTED]"
    },
    transport: pretty
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname"
          }
        }
      : undefined
  },
  requestIdHeader: "x-request-id",
  genReqId: (req) => {
    const header = req.headers["x-request-id"];
    if (typeof header === "string" && header.length > 0) return header;
    return cryptoRandomId();
  }
});

function cryptoRandomId(): string {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

// BigInt-safe JSON responses (Prisma uses BigInt for versions)
app.setReplySerializer((payload) =>
  JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
);

app.setErrorHandler((err, req, reply) => {
  // Zod validation errors => 400 (avoid leaking internal stack as 500)
  if (err instanceof ZodError) {
    req.log.info({ reqId: req.id, issues: err.issues }, "validation:error");
    return reply.code(400).send({
      error: "VALIDATION_ERROR",
      issues: err.issues
    });
  }

  const statusCode = (err as any)?.statusCode;
  const code = typeof statusCode === "number" ? statusCode : 500;

  if (code >= 500) {
    req.log.error({ reqId: req.id, err }, "request:error");
    return reply.code(500).send({ error: "INTERNAL" });
  }

  req.log.info({ reqId: req.id, err }, "request:error");
  return reply.code(code).send({ error: (err as any)?.message ?? "ERROR" });
});

app.addHook("onResponse", async (req, reply) => {
  req.log.info(
    {
      reqId: req.id,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode
    },
    "request:done"
  );
});

await app.register(helmet);
await app.register(cors, { origin: true });
await app.register(formbody);
await app.register(rateLimit, {
  max: 300,
  timeWindow: "1 minute"
});

await app.register(jwtPlugin, { env });

await app.register(healthRoutes);
await app.register(
  async (sub) => {
    await sub.register(apiV1Routes);
  },
  { prefix: "/api/v1" }
);

await app.register(syncRoutes, { prefix: "/sync" });

await app.listen({ port: env.PORT, host: env.HOST });