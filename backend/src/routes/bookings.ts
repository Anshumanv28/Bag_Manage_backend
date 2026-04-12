import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { loadEnv } from "../env.js";

const env = loadEnv();

function bearerToken(header?: string): string | null {
  if (!header) return null;
  const [typ, token] = header.split(" ");
  if (typ?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function requireAccess(app: any, authorization?: string): Promise<string> {
  const token = bearerToken(authorization);
  if (!token) throw Object.assign(new Error("MISSING_ACCESS_TOKEN"), { statusCode: 401 });
  try {
    const payload = (await app.jwt.verify(token)) as any;
    if (payload.typ !== "access") throw new Error();
    return payload.sub as string;
  } catch {
    throw Object.assign(new Error("INVALID_ACCESS_TOKEN"), { statusCode: 401 });
  }
}

function isAdmin(req: any): boolean {
  if (!env.ADMIN_API_KEY) return false;
  const key = req.headers?.["x-admin-key"];
  return typeof key === "string" && key === env.ADMIN_API_KEY;
}

type BookingCursor = { createdAt: string; id: string };

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as BookingCursor;
  if (!parsed?.createdAt || !parsed?.id) throw new Error("INVALID_CURSOR");
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error("INVALID_CURSOR");
  return { createdAt, id: parsed.id };
}

function encodeCursor(v: { createdAt: Date; id: string }): string {
  const payload: BookingCursor = { createdAt: v.createdAt.toISOString(), id: v.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req) => {
    if (isAdmin(req)) {
      (req as any).operatorPhone = null;
      return;
    }
    (req as any).operatorPhone = await requireAccess(app, req.headers.authorization);
  });

  app.get("/", async (req) => {
    const query = z
      .object({
        status: z.enum(["active", "complete"]).optional(),
        operatorId: z.string().min(3).optional(),
        returnOperatorId: z.string().min(3).optional(),
        rackId: z.string().min(1).optional(),
        candidateId: z.string().min(1).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        completedFrom: z.coerce.date().optional(),
        completedTo: z.coerce.date().optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
        cursor: z.string().min(1).optional()
      })
      .parse(req.query);

    const limit = query.limit ?? 200;

    const where: Prisma.BookingWhereInput = {};
    if (query.status) where.status = query.status as any;
    if (query.operatorId) where.operatorId = query.operatorId;
    if (query.returnOperatorId) where.returnOperatorId = query.returnOperatorId;
    if (query.rackId) where.rackId = query.rackId;
    if (query.candidateId) where.candidateId = query.candidateId;

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lt: query.to } : {})
      };
    }

    if (query.completedFrom || query.completedTo) {
      where.completedAt = {
        ...(query.completedFrom ? { gte: query.completedFrom } : {}),
        ...(query.completedTo ? { lt: query.completedTo } : {})
      };
    }

    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      where.AND = [
        ...(where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : []),
        {
          OR: [
            { createdAt: { lt: c.createdAt } },
            { createdAt: c.createdAt, id: { lt: c.id } }
          ]
        }
      ];
    }

    const rows = await prisma.booking.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1
    });

    const bookings = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit
        ? encodeCursor({
            createdAt: bookings[bookings.length - 1]!.createdAt,
            id: bookings[bookings.length - 1]!.id
          })
        : null;

    return { bookings, nextCursor };
  });

  app.post("/start", async (req, reply) => {
    const operatorPhone = (req as any).operatorPhone as string;

    const body = z
      .object({
        rackId: z.string().min(1),
        candidateId: z.string().min(1)
      })
      .parse(req.body);

    try {
      const booking = await prisma.$transaction(async (tx) => {
        const existingCandidate = await tx.booking.findFirst({
          where: { candidateId: body.candidateId, status: "active" }
        });
        if (existingCandidate) {
          throw Object.assign(new Error("CANDIDATE_ALREADY_ACTIVE"), { statusCode: 409 });
        }

        const existingRack = await tx.booking.findFirst({
          where: { rackId: body.rackId, status: "active" }
        });
        if (existingRack) {
          throw Object.assign(new Error("RACK_IN_USE"), { statusCode: 409 });
        }

        const created = await tx.booking.create({
          data: {
            rackId: body.rackId,
            candidateId: body.candidateId,
            operatorId: operatorPhone,
            status: "active"
          }
        });

        return created;
      });

      return reply.code(201).send({ booking });
    } catch (e: any) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.code(409).send({ error: "RACK_OR_CANDIDATE_CONFLICT" });
      }
      const status = e?.statusCode ?? 500;
      if (status !== 500) return reply.code(status).send({ error: e.message });
      return reply.code(500).send({ error: "INTERNAL" });
    }
  });

  app.post("/:id/finish", async (req, reply) => {
    const operatorPhone = (req as any).operatorPhone as string;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUnique({ where: { id: params.id } });
        if (!booking) throw Object.assign(new Error("BOOKING_NOT_FOUND"), { statusCode: 404 });
        if (booking.status !== "active") throw Object.assign(new Error("BOOKING_NOT_ACTIVE"), { statusCode: 409 });

        const updatedBooking = await tx.booking.update({
          where: { id: params.id },
          data: {
            status: "complete",
            completedAt: new Date(),
            returnOperatorId: operatorPhone
          }
        });

        return updatedBooking;
      });

      return reply.send({ booking: result });
    } catch (e: any) {
      const status = e?.statusCode ?? 500;
      if (status !== 500) return reply.code(status).send({ error: e.message });
      return reply.code(500).send({ error: "INTERNAL" });
    }
  });
};