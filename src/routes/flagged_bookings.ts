import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { loadEnv } from "../env.js";

const env = loadEnv();

function requireAdmin(req: FastifyRequest): void {
  if (!env.ADMIN_API_KEY) throw new Error("ADMIN_API_KEY not set");
  const key = req.headers["x-admin-key"];
  if (typeof key !== "string" || key !== env.ADMIN_API_KEY) {
    const err: Error & { statusCode?: number } = new Error("FORBIDDEN");
    err.statusCode = 403;
    throw err;
  }
}

export const flaggedBookingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req) => {
    requireAdmin(req);
  });

  app.get("/", async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
        cursor: z.string().min(1).optional(),
      })
      .parse(req.query);

    const limit = query.limit ?? 100;

    type Cursor = { createdAt: string; id: string };
    let cursorWhere = {};
    if (query.cursor) {
      const json = Buffer.from(query.cursor, "base64url").toString("utf8");
      const c = JSON.parse(json) as Cursor;
      const createdAt = new Date(c.createdAt);
      if (Number.isNaN(createdAt.getTime()) || !c.id) {
        throw Object.assign(new Error("INVALID_CURSOR"), { statusCode: 400 });
      }
      cursorWhere = {
        OR: [
          { createdAt: { lt: createdAt } },
          { AND: [{ createdAt }, { id: { lt: c.id } }] },
        ],
      };
    }

    // Use raw SQL to avoid coupling this endpoint to Prisma relation typing.
    // (Flagged bookings are intentionally denormalized and do not join bookings.)
    const params: any[] = [];
    const clauses: string[] = [];
    const add = (clause: string, value: any) => {
      params.push(value);
      clauses.push(clause.replace("?", `$${params.length}`));
    };

    if (query.cursor) {
      const json = Buffer.from(query.cursor, "base64url").toString("utf8");
      const c = JSON.parse(json) as Cursor;
      const createdAt = new Date(c.createdAt);
      if (Number.isNaN(createdAt.getTime()) || !c.id) {
        throw Object.assign(new Error("INVALID_CURSOR"), { statusCode: 400 });
      }
      add(`created_at < ?`, createdAt);
      add(`id < ?`, c.id);
      // Implement DESC pagination: (created_at, id) < (cursor.created_at, cursor.id)
      clauses.pop(); // remove id clause (we'll add combined)
      clauses.pop(); // remove created_at clause (we'll add combined)
      params.pop();
      params.pop();
      params.push(createdAt);
      params.push(c.id);
      clauses.push(
        `(created_at < $${params.length - 1} or (created_at = $${params.length - 1} and id < $${params.length}))`,
      );
    }

    const whereSql = clauses.length ? `where ${clauses.join(" and ")}` : "";

    const rows = await prisma.$queryRawUnsafe<
      {
        id: string;
        bookingId: string;
        reason: string;
        createdAt: Date;
        candidateId: string;
        rackId: string;
        operatorId: string;
      }[]
    >(
      `
      select
        id::text as "id",
        booking_id::text as "bookingId",
        reason::text as "reason",
        created_at as "createdAt",
        candidate_id::text as "candidateId",
        rack_id::text as "rackId",
        operator_id::text as "operatorId"
      from flagged_bookings
      ${whereSql}
      order by created_at desc, id desc
      limit ${limit + 1}
      `,
      ...params,
    );

    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({
              createdAt: page[page.length - 1]!.createdAt.toISOString(),
              id: page[page.length - 1]!.id,
            } satisfies Cursor),
            "utf8",
          ).toString("base64url")
        : null;

    return {
      flagged: page.map((f) => ({
        id: f.id,
        bookingId: f.bookingId,
        reason: f.reason,
        createdAt: f.createdAt.toISOString(),
        booking: {
          id: f.bookingId,
          candidateId: f.candidateId,
          rackId: f.rackId,
          operatorId: f.operatorId,
          status: "active",
          createdAt: f.createdAt.toISOString(),
          completedAt: null,
        },
      })),
      nextCursor,
    };
  });
};
