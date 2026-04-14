import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import argon2 from "argon2";

import { prisma } from "../db.js";
import { loadEnv } from "../env.js";

const env = loadEnv();

function requireAdmin(req: FastifyRequest): void {
  if (!env.ADMIN_API_KEY) throw new Error("ADMIN_API_KEY not set");
  const key = req.headers["x-admin-key"];
  if (typeof key !== "string" || key !== env.ADMIN_API_KEY) {
    const err: any = new Error("FORBIDDEN");
    err.statusCode = 403;
    throw err;
  }
}

export const operatorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req) => {
    requireAdmin(req);
  });

  app.get("/", async () => {
    const operators = await prisma.operator.findMany({
      select: {
        phone: true,
        name: true,
        depositEnabled: true,
        retrieveEnabled: true,
      },
      orderBy: { phone: "asc" },
    });
    return { operators };
  });

  app.post("/", async (req, reply) => {
    const body = z
      .object({
        phone: z.string().min(3),
        name: z.string().min(1),
        password: z.string().min(6)
      })
      .parse(req.body);

    const passwordHash = await argon2.hash(body.password);

    try {
      const operator = await prisma.$transaction(async (tx) => {
        const created = await tx.operator.create({
          data: {
            phone: body.phone,
            name: body.name,
            passwordHash,
          },
          select: {
            phone: true,
            name: true,
            depositEnabled: true,
            retrieveEnabled: true,
          },
        });

        return created;
      });

      return reply.code(201).send({ operator });
    } catch {
      return reply.code(409).send({ error: "OPERATOR_EXISTS" });
    }
  });

  app.patch("/:phone", async (req, reply) => {
    const params = z.object({ phone: z.string().min(3) }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        password: z.string().min(6).optional(),
        depositEnabled: z.boolean().optional(),
        retrieveEnabled: z.boolean().optional(),
      })
      .refine((v) => v.name || v.password || v.depositEnabled !== undefined || v.retrieveEnabled !== undefined, {
        message: "No updates",
      })
      .parse(req.body);

    const data: Record<string, unknown> = {};
    if (body.name) data.name = body.name;
    if (body.password) data.passwordHash = await argon2.hash(body.password);
    if (body.depositEnabled !== undefined) data.depositEnabled = body.depositEnabled;
    if (body.retrieveEnabled !== undefined) data.retrieveEnabled = body.retrieveEnabled;

    try {
      const operator = await prisma.$transaction(async (tx) => {
        const current = await tx.operator.findUnique({ where: { phone: params.phone } });
        if (!current) throw Object.assign(new Error("OPERATOR_NOT_FOUND"), { statusCode: 404 });

        const updated = await tx.operator.update({
          where: { phone: params.phone },
          data,
          select: {
            phone: true,
            name: true,
            depositEnabled: true,
            retrieveEnabled: true,
          },
        });

        return updated;
      });

      return reply.send({ operator });
    } catch (e: any) {
      const status = e?.statusCode ?? 500;
      if (status !== 500) return reply.code(status).send({ error: e.message });
      return reply.code(500).send({ error: "INTERNAL" });
    }
  });
};