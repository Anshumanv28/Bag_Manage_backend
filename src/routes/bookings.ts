import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { BookingStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { refreshDuplicateFlagsForKeys } from "../duplicate_flags.js";
import { loadEnv } from "../env.js";

const env = loadEnv();

function bearerToken(header?: string): string | null {
  if (!header) return null;
  const [typ, token] = header.split(" ");
  if (typ?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function requireAccess(
  app: { jwt: { verify: (token: string) => Promise<unknown> } },
  authorization?: string,
): Promise<string> {
  const token = bearerToken(authorization);
  if (!token)
    throw Object.assign(new Error("MISSING_ACCESS_TOKEN"), { statusCode: 401 });
  try {
    const payload = (await app.jwt.verify(token)) as unknown;
    if (!payload || typeof payload !== "object") throw new Error();
    const p = payload as Record<string, unknown>;
    if (p.typ !== "access" || typeof p.sub !== "string") throw new Error();
    return p.sub;
  } catch {
    throw Object.assign(new Error("INVALID_ACCESS_TOKEN"), { statusCode: 401 });
  }
}

function isAdmin(req: FastifyRequest): boolean {
  if (!env.ADMIN_API_KEY) return false;
  const key = req.headers["x-admin-key"];
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
  const payload: BookingCursor = {
    createdAt: v.createdAt.toISOString(),
    id: v.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

type BookingIdCursor = { updatedAt: string; id: string };

function decodeIdCursor(cursor: string): { updatedAt: Date; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as BookingIdCursor;
  if (!parsed?.updatedAt || !parsed?.id) throw new Error("INVALID_CURSOR");
  const updatedAt = new Date(parsed.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) throw new Error("INVALID_CURSOR");
  return { updatedAt, id: parsed.id };
}

function encodeIdCursor(v: { updatedAt: Date; id: string }): string {
  const payload: BookingIdCursor = { updatedAt: v.updatedAt.toISOString(), id: v.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

type FlaggedBookingsCursor = { updatedAt: string; id: string };

function decodeFlaggedCursor(cursor: string): { updatedAt: Date; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as FlaggedBookingsCursor;
  if (!parsed?.updatedAt || !parsed?.id) throw new Error("INVALID_CURSOR");
  const updatedAt = new Date(parsed.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) throw new Error("INVALID_CURSOR");
  return { updatedAt, id: parsed.id };
}

function encodeFlaggedCursor(v: { updatedAt: Date; id: string }): string {
  const payload: FlaggedBookingsCursor = { updatedAt: v.updatedAt.toISOString(), id: v.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function statusCodeOf(e: unknown): number | undefined {
  if (!e || typeof e !== "object") return undefined;
  const v = e as { statusCode?: unknown };
  return typeof v.statusCode === "number" ? v.statusCode : undefined;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function fixIstSkewForBooking<T extends { createdAt: Date; updatedAt: Date; completedAt: Date | null }>(
  b: T,
): T {
  // Some older device sync payloads sent naive local timestamps (IST) which were
  // parsed on a UTC server as UTC, making createdAt/completedAt appear ~5h30m
  // ahead and even after updatedAt (which should never happen).
  const SHIFT_MS = 330 * 60 * 1000;
  const needsFix = b.createdAt.getTime() > b.updatedAt.getTime() + 60 * 1000;
  if (!needsFix) return b;

  const createdAt = new Date(b.createdAt.getTime() - SHIFT_MS);
  const completedAt =
    b.completedAt != null ? new Date(b.completedAt.getTime() - SHIFT_MS) : null;
  return { ...b, createdAt, completedAt };
}

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req) => {
    if (isAdmin(req)) {
      (req as { operatorPhone?: string | null }).operatorPhone = null;
      return;
    }
    (req as { operatorPhone?: string | null }).operatorPhone = await requireAccess(
      app,
      req.headers.authorization,
    );
  });

  // Admin-only: list flagged bookings with computed reasons.
  app.get("/flagged", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: "FORBIDDEN" });

    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
        cursor: z.string().min(1).optional(),
      })
      .parse(req.query);

    const limit = query.limit ?? 200;

    let cursorWhere: Prisma.BookingWhereInput = {};
    if (query.cursor) {
      try {
        const c = decodeFlaggedCursor(query.cursor);
        cursorWhere = {
          OR: [
            { updatedAt: { lt: c.updatedAt } },
            { AND: [{ updatedAt: c.updatedAt }, { id: { lt: c.id } }] },
          ],
        };
      } catch {
        return reply.code(400).send({ error: "INVALID_CURSOR" });
      }
    }

    const rows = await prisma.booking.findMany({
      where: {
        AND: [
          { deletedAt: null },
          { status: "flagged" },
          cursorWhere,
        ],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        candidateId: true,
        rackId: true,
        operatorId: true,
        returnOperatorId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        deletedAt: true,
      },
    });

    const page = rows.slice(0, limit).map(fixIstSkewForBooking);
    const nextCursor =
      rows.length > limit
        ? encodeFlaggedCursor({
            updatedAt: page[page.length - 1]!.updatedAt,
            id: page[page.length - 1]!.id,
          })
        : null;

    const candidateIds = Array.from(
      new Set(page.map((b) => b.candidateId).filter((x) => x.length > 0)),
    );
    const rackIds = Array.from(
      new Set(page.map((b) => b.rackId).filter((x) => x.length > 0)),
    );

    const [candGroups, rackGroups] = await Promise.all([
      candidateIds.length
        ? prisma.booking.groupBy({
            by: ["candidateId"],
            where: {
              deletedAt: null,
              status: { in: ["active", "flagged"] },
              candidateId: { in: candidateIds },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      rackIds.length
        ? prisma.booking.groupBy({
            by: ["rackId"],
            where: {
              deletedAt: null,
              status: { in: ["active", "flagged"] },
              rackId: { in: rackIds },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const candidateDup = new Set(
      candGroups
        .filter((g) => (g._count?._all ?? 0) > 1)
        .map((g) => g.candidateId),
    );
    const rackDup = new Set(
      rackGroups.filter((g) => (g._count?._all ?? 0) > 1).map((g) => g.rackId),
    );

    return {
      rows: page.map((b) => {
        const reasons: string[] = [];
        if (candidateDup.has(b.candidateId)) reasons.push("candidate_duplicate_active");
        if (rackDup.has(b.rackId)) reasons.push("rack_duplicate_active");
        return { booking: b, reasons };
      }),
      nextCursor,
    };
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
        cursor: z.string().min(1).optional(),
      })
      .parse(req.query);

    const limit = query.limit ?? 200;

    const where: Prisma.BookingWhereInput = {
      status: { not: "deleted" as unknown as BookingStatus },
    };
    if (query.status) where.status = query.status as BookingStatus;
    if (query.operatorId) where.operatorId = query.operatorId;
    if (query.returnOperatorId) where.returnOperatorId = query.returnOperatorId;
    if (query.rackId) where.rackId = query.rackId;
    if (query.candidateId) where.candidateId = query.candidateId;

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lt: query.to } : {}),
      };
    }

    if (query.completedFrom || query.completedTo) {
      where.completedAt = {
        ...(query.completedFrom ? { gte: query.completedFrom } : {}),
        ...(query.completedTo ? { lt: query.completedTo } : {}),
      };
    }

    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      where.AND = [
        ...(where.AND
          ? Array.isArray(where.AND)
            ? where.AND
            : [where.AND]
          : []),
        {
          OR: [
            { createdAt: { lt: c.createdAt } },
            { createdAt: c.createdAt, id: { lt: c.id } },
          ],
        },
      ];
    }

    const rows = await prisma.booking.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const bookings = rows.slice(0, limit).map(fixIstSkewForBooking);
    const nextCursor =
      rows.length > limit
        ? encodeCursor({
            createdAt: bookings[bookings.length - 1]!.createdAt,
            id: bookings[bookings.length - 1]!.id,
          })
        : null;

    return { bookings, nextCursor };
  });

  // Booking id index for device reconciliation. Excludes deleted bookings.
  app.get("/ids", async (req, reply) => {
    // Allow both admin and operator sessions.
    if (!isAdmin(req)) {
      await requireAccess(app, req.headers.authorization);
    }

    const query = z
      .object({
        updatedSince: z.coerce.date().optional(),
        limit: z.coerce.number().int().positive().max(2000).optional(),
        cursor: z.string().min(1).optional(),
      })
      .parse(req.query);

    const limit = query.limit ?? 1000;

    const where: Prisma.BookingWhereInput = {
      status: { not: "deleted" as unknown as BookingStatus },
    };
    if (query.updatedSince) {
      where.updatedAt = { gte: query.updatedSince };
    }
    if (query.cursor) {
      const c = decodeIdCursor(query.cursor);
      where.AND = [
        ...(where.AND
          ? Array.isArray(where.AND)
            ? where.AND
            : [where.AND]
          : []),
        {
          OR: [
            { updatedAt: { gt: c.updatedAt } },
            { updatedAt: c.updatedAt, id: { gt: c.id } },
          ],
        },
      ];
    }

    const rows = await prisma.booking.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: { id: true, updatedAt: true },
    });

    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit
        ? encodeIdCursor({
            updatedAt: page[page.length - 1]!.updatedAt,
            id: page[page.length - 1]!.id,
          })
        : null;

    return reply.send({ ids: page.map((r) => r.id), nextCursor });
  });

  app.delete("/:id", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: "FORBIDDEN" });
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await prisma.booking.update({
        where: { id: params.id },
        data: { status: "deleted" as unknown as BookingStatus },
      });
      return reply.code(204).send();
    } catch (e: unknown) {
      const status = statusCodeOf(e) ?? 500;
      if (status !== 500) return reply.code(status).send({ error: messageOf(e) });
      return reply.code(500).send({ error: "INTERNAL" });
    }
  });

  app.post("/start", async (req, reply) => {
    const operatorPhone = (req as { operatorPhone?: string | null }).operatorPhone;
    if (!operatorPhone) return reply.code(401).send({ error: "UNAUTHORIZED" });

    const body = z
      .object({
        rackId: z.string().min(1),
        candidateId: z.string().min(1),
      })
      .parse(req.body);

    try {
      const booking = await prisma.$transaction(async (tx) => {
        const created = await tx.booking.create({
          data: {
            rackId: body.rackId,
            candidateId: body.candidateId,
            operatorId: operatorPhone,
            status: "active",
          },
        });

        await refreshDuplicateFlagsForKeys(
          tx,
          [body.candidateId],
          [body.rackId],
        );

        return created;
      });

      return reply.code(201).send({ booking });
    } catch (e: unknown) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        return reply.code(409).send({ error: "RACK_OR_CANDIDATE_CONFLICT" });
      }
      const status = statusCodeOf(e) ?? 500;
      if (status !== 500) return reply.code(status).send({ error: messageOf(e) });
      return reply.code(500).send({ error: "INTERNAL" });
    }
  });

  app.post("/:id/finish", async (req, reply) => {
    const operatorPhone = (req as { operatorPhone?: string | null }).operatorPhone;
    if (!operatorPhone) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const params = z.object({ id: z.string().uuid() }).parse(req.params);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUnique({
          where: { id: params.id },
        });
        if (!booking)
          throw Object.assign(new Error("BOOKING_NOT_FOUND"), {
            statusCode: 404,
          });
        if (booking.status === "flagged") {
          throw Object.assign(new Error("FLAGGED_BOOKING"), {
            statusCode: 409,
          });
        }
        if (booking.status !== "active")
          throw Object.assign(new Error("BOOKING_NOT_ACTIVE"), {
            statusCode: 409,
          });

        const updatedBooking = await tx.booking.update({
          where: { id: params.id },
          data: {
            status: "complete",
            completedAt: new Date(),
            returnOperatorId: operatorPhone,
          },
        });

        return updatedBooking;
      });

      return reply.send({ booking: result });
    } catch (e: unknown) {
      const status = statusCodeOf(e) ?? 500;
      if (status !== 500) return reply.code(status).send({ error: messageOf(e) });
      return reply.code(500).send({ error: "INTERNAL" });
    }
  });
};
