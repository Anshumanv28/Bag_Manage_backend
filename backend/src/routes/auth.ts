import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import argon2 from "argon2";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import { prisma } from "../db.js";
import { loadEnv } from "../env.js";

const env = loadEnv();

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function bearerToken(header?: string): string | null {
  if (!header) return null;
  const [typ, token] = header.split(" ");
  if (typ?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function signRefreshToken(operatorPhone: string): { token: string; expiresAt: Date } {
  const token = jwt.sign({ sub: operatorPhone, typ: "refresh" }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL_SECONDS
  });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
  return { token, expiresAt };
}

function verifyRefreshToken(token: string): { sub: string; typ: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as any;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/login", async (req, reply) => {
    const body = z
      .object({
        phone: z.string().min(3),
        password: z.string().min(1)
      })
      .parse(req.body);

    const operator = await prisma.operator.findUnique({ where: { phone: body.phone } });
    if (!operator) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });

    const ok = await argon2.verify(operator.passwordHash, body.password);
    if (!ok) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });

    const accessToken = await app.jwt.sign({ sub: operator.phone, typ: "access" });

    const { token: refreshToken, expiresAt } = signRefreshToken(operator.phone);
    await prisma.refreshToken.create({
      data: {
        operatorId: operator.phone,
        tokenHash: sha256Hex(refreshToken),
        expiresAt
      }
    });

    return reply.send({
      accessToken,
      refreshToken,
      operator: { phone: operator.phone, name: operator.name }
    });
  });

  app.post("/refresh", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return reply.code(401).send({ error: "MISSING_REFRESH_TOKEN" });

    let payload: { sub: string; typ: string };
    try {
      payload = verifyRefreshToken(token);
    } catch {
      return reply.code(401).send({ error: "INVALID_REFRESH_TOKEN" });
    }

    if (payload.typ !== "refresh") return reply.code(401).send({ error: "INVALID_REFRESH_TOKEN" });

    const row = await prisma.refreshToken.findFirst({
      where: {
        operatorId: payload.sub,
        tokenHash: sha256Hex(token),
        revokedAt: null,
        expiresAt: { gt: new Date() }
      }
    });
    if (!row) return reply.code(401).send({ error: "REFRESH_TOKEN_REVOKED" });

    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), lastUsedAt: new Date() }
    });

    const operator = await prisma.operator.findUnique({ where: { phone: payload.sub } });
    if (!operator) return reply.code(401).send({ error: "OPERATOR_NOT_FOUND" });

    const accessToken = await app.jwt.sign({ sub: operator.phone, typ: "access" });

    const { token: refreshToken, expiresAt } = signRefreshToken(operator.phone);
    await prisma.refreshToken.create({
      data: {
        operatorId: operator.phone,
        tokenHash: sha256Hex(refreshToken),
        expiresAt
      }
    });

    return reply.send({ accessToken, refreshToken });
  });

  app.post("/logout", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return reply.code(204).send();

    try {
      const payload = verifyRefreshToken(token);
      if (payload.typ !== "refresh") return reply.code(204).send();

      await prisma.refreshToken.updateMany({
        where: {
          operatorId: payload.sub,
          tokenHash: sha256Hex(token),
          revokedAt: null
        },
        data: {
          revokedAt: new Date(),
          lastUsedAt: new Date()
        }
      });
    } catch {
      // ignore
    }

    return reply.code(204).send();
  });

  app.get("/me", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return reply.code(401).send({ error: "MISSING_ACCESS_TOKEN" });

    let payload: { sub: string; typ: string };
    try {
      payload = (await app.jwt.verify(token)) as any;
    } catch {
      return reply.code(401).send({ error: "INVALID_ACCESS_TOKEN" });
    }

    if (payload.typ !== "access") return reply.code(401).send({ error: "INVALID_ACCESS_TOKEN" });

    const operator = await prisma.operator.findUnique({ where: { phone: payload.sub } });
    if (!operator) return reply.code(404).send({ error: "OPERATOR_NOT_FOUND" });

    return reply.send({ operator: { phone: operator.phone, name: operator.name } });
  });
};