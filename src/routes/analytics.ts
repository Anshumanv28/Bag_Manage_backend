import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
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

const BucketSchema = z.enum(["hour", "day"]);

type SyncEventsCursor = { createdAt: string; id: string };

function encodeSyncEventsCursor(v: { createdAt: Date; id: string }): string {
  const payload: SyncEventsCursor = {
    createdAt: v.createdAt.toISOString(),
    id: v.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSyncEventsCursor(
  cursor: string,
): { createdAt: Date; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as SyncEventsCursor;
  if (!parsed?.createdAt || !parsed?.id) throw new Error("INVALID_CURSOR");
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error("INVALID_CURSOR");
  return { createdAt, id: parsed.id };
}

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req) => {
    requireAdmin(req);
  });

  app.get("/sync/events", async (req, reply) => {
    let query: {
      from: Date;
      to: Date;
      operatorId?: string;
      deviceId?: string;
      limit?: number;
      cursor?: string;
    };
    try {
      query = z
        .object({
          from: z.coerce.date(),
          to: z.coerce.date(),
          operatorId: z.string().min(3).optional(),
          deviceId: z.string().min(1).optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
          cursor: z.string().min(1).optional(),
        })
        .parse(req.query);
    } catch {
      return reply.code(400).send({ error: "INVALID_QUERY" });
    }

    const limit = query.limit ?? 200;

    const clauses: string[] = [`se.created_at >= $1`, `se.created_at < $2`];
    const params: any[] = [query.from, query.to];
    let i = params.length;
    const add = (clause: string, value: any) => {
      i += 1;
      params.push(value);
      clauses.push(clause.replace("?", `$${i}`));
    };
    if (query.operatorId) add(`se.operator_id = ?`, query.operatorId);
    if (query.deviceId) add(`se.device_id = ?`, query.deviceId);

    if (query.cursor) {
      try {
        const c = decodeSyncEventsCursor(query.cursor);
        // Desc pagination: fetch rows strictly "before" cursor.
        params.push(c.createdAt);
        params.push(c.id);
        const createdAtParam = `$${params.length - 1}`;
        const idParam = `$${params.length}`;
        clauses.push(
          `(se.created_at < ${createdAtParam} or (se.created_at = ${createdAtParam} and se.id < ${idParam}))`,
        );
      } catch {
        return reply.code(400).send({ error: "INVALID_CURSOR" });
      }
    }

    const rows = await prisma.$queryRawUnsafe<
      {
        id: string;
        operatorId: string;
        deviceId: string;
        createdAt: string;
        mutationCount: number;
        okCount: number;
        errorCount: number;
      }[]
    >(
      `
      select
        se.id::text as "id",
        se.operator_id::text as "operatorId",
        se.device_id::text as "deviceId",
        se.created_at::text as "createdAt",
        se.mutation_count::int as "mutationCount",
        se.ok_count::int as "okCount",
        se.error_count::int as "errorCount"
      from sync_events se
      where ${clauses.join(" and ")}
      order by se.created_at desc, se.id desc
      limit ${limit + 1}
      `,
      ...params,
    );

    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit
        ? encodeSyncEventsCursor({
            createdAt: new Date(page[page.length - 1]!.createdAt),
            id: page[page.length - 1]!.id,
          })
        : null;

    return { rows: page, nextCursor };
  });

  app.get("/sync/latest", async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
        operatorId: z.string().min(3).optional(),
        activeOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query);

    const limit = query.limit ?? 100;

    const clauses: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: any) => {
      params.push(value);
      clauses.push(clause.replace("?", `$${params.length}`));
    };
    if (query.operatorId) add(`se.operator_id = ?`, query.operatorId);
    if (query.activeOnly) {
      clauses.push(
        `exists (select 1 from bookings b where b.status = 'active' and b.operator_id = se.operator_id)`,
      );
    }

    const whereSql = clauses.length ? `where ${clauses.join(" and ")}` : "";

    const rows = await prisma.$queryRawUnsafe<
      {
        operatorId: string;
        deviceId: string;
        createdAt: string;
        mutationCount: number;
        okCount: number;
        errorCount: number;
      }[]
    >(
      `
      select distinct on (se.operator_id)
        se.operator_id::text as "operatorId",
        se.device_id::text as "deviceId",
        se.created_at::text as "createdAt",
        se.mutation_count::int as "mutationCount",
        se.ok_count::int as "okCount",
        se.error_count::int as "errorCount"
      from sync_events se
      ${whereSql}
      order by se.operator_id asc, se.created_at desc
      `,
      ...params,
    );

    // Now sort newest-first for display and apply limit.
    const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = sorted.slice(0, limit);

    return { rows: page };
  });

  app.get("/activities/summary", async (req) => {
    const query = z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        operatorId: z.string().min(3).optional(),
        deviceId: z.string().min(1).optional(),
      })
      .parse(req.query);

    // Scan events: candidate_scanned, rack_scanned
    const scanClauses: string[] = [`se.occurred_at >= $1`, `se.occurred_at < $2`];
    const scanParams: any[] = [query.from, query.to];
    let si = scanParams.length;
    const addScan = (clause: string, value: any) => {
      si += 1;
      scanParams.push(value);
      scanClauses.push(clause.replace("?", `$${si}`));
    };
    if (query.operatorId) addScan(`se.operator_id = ?`, query.operatorId);
    if (query.deviceId) addScan(`se.device_id = ?`, query.deviceId);

    const scanRows = await prisma.$queryRawUnsafe<
      { eventType: string; count: number }[]
    >(
      `
      select
        se.event_type::text as "eventType",
        count(*)::int as "count"
      from scan_events se
      where ${scanClauses.join(" and ")}
      group by 1
      order by 1 asc
      `,
      ...scanParams,
    );

    const scanByType: Record<string, number> = {};
    for (const r of scanRows) scanByType[r.eventType] = r.count;

    // Booking transitions approximation:
    // - deposit_confirmed ~= bookings created in window
    // - return_confirmed  ~= bookings completed in window (status=complete)
    const depositClauses: string[] = [`b.created_at >= $1`, `b.created_at < $2`];
    const depositParams: any[] = [query.from, query.to];
    let di = depositParams.length;
    const addDeposit = (clause: string, value: any) => {
      di += 1;
      depositParams.push(value);
      depositClauses.push(clause.replace("?", `$${di}`));
    };
    if (query.operatorId) addDeposit(`b.operator_id = ?`, query.operatorId);

    const depositRes = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `
      select count(*)::int as "count"
      from bookings b
      where ${depositClauses.join(" and ")}
      `,
      ...depositParams,
    );

    const returnClauses: string[] = [
      `b.completed_at >= $1`,
      `b.completed_at < $2`,
      `b.status = 'complete'`,
    ];
    const returnParams: any[] = [query.from, query.to];
    let ri = returnParams.length;
    const addReturn = (clause: string, value: any) => {
      ri += 1;
      returnParams.push(value);
      returnClauses.push(clause.replace("?", `$${ri}`));
    };
    if (query.operatorId) addReturn(`b.return_operator_id = ?`, query.operatorId);

    const returnRes = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `
      select count(*)::int as "count"
      from bookings b
      where ${returnClauses.join(" and ")}
      `,
      ...returnParams,
    );

    return {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      operatorId: query.operatorId ?? null,
      deviceId: query.deviceId ?? null,
      counts: {
        candidate_scanned: scanByType["candidate_scanned"] ?? 0,
        rack_scanned: scanByType["rack_scanned"] ?? 0,
        deposit_confirmed: depositRes?.[0]?.count ?? 0,
        return_confirmed: returnRes?.[0]?.count ?? 0,
      },
    };
  });

  app.get("/bookings/summary", async (req) => {
    const query = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        status: z.enum(["active", "complete"]).optional(),
        operatorId: z.string().min(3).optional(),
        returnOperatorId: z.string().min(3).optional()
      })
      .parse(req.query);

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.operatorId) where.operatorId = query.operatorId;
    if (query.returnOperatorId) where.returnOperatorId = query.returnOperatorId;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lt: query.to } : {})
      };
    }

    const [total, active, complete] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.count({ where: { ...where, status: "active" } }),
      prisma.booking.count({ where: { ...where, status: "complete" } })
    ]);

    // Accurate avg completion time in minutes via SQL, using the same filters.
    const sqlFilters: string[] = [];
    const params: any[] = [];
    const push = (clause: string, value: any) => {
      params.push(value);
      sqlFilters.push(clause.replace("?", `$${params.length}`));
    };

    if (query.status) push(`status = ?`, query.status);
    if (query.operatorId) push(`operator_id = ?`, query.operatorId);
    if (query.returnOperatorId) push(`return_operator_id = ?`, query.returnOperatorId);
    if (query.from) push(`created_at >= ?`, query.from);
    if (query.to) push(`created_at < ?`, query.to);

    // Always only consider completed rows for avg.
    sqlFilters.push(`status = 'complete'`);
    sqlFilters.push(`completed_at is not null`);

    const whereSql = sqlFilters.length ? `where ${sqlFilters.join(" and ")}` : "";

    const avgRes = await prisma.$queryRawUnsafe<
      { avg_completion_minutes: number | null }[]
    >(
      `
      select avg(extract(epoch from (completed_at - created_at)) / 60.0)::float as avg_completion_minutes
      from bookings
      ${whereSql}
      `,
      ...params
    );

    return {
      total,
      active,
      complete,
      avgCompletionMinutes: avgRes?.[0]?.avg_completion_minutes ?? null
    };
  });

  app.get("/bookings/timeseries", async (req) => {
    const query = z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        bucket: BucketSchema.default("day"),
        timezone: z.string().min(1).default("UTC"),
        status: z.enum(["active", "complete"]).optional(),
        operatorId: z.string().min(3).optional(),
        returnOperatorId: z.string().min(3).optional()
      })
      .parse(req.query);

    // We intentionally use raw SQL for time-bucketing performance/accuracy.
    // Note: we DO NOT interpolate user strings except via parameters.
    const bucket = query.bucket; // validated enum
    const tz = query.timezone;

    const baseClauses: string[] = [
      `created_at >= $1`,
      `created_at < $2`
    ];
    const baseParams: any[] = [query.from, query.to];

    let i = baseParams.length;
    const add = (clause: string, value: any) => {
      i += 1;
      baseParams.push(value);
      baseClauses.push(clause.replace("?", `$${i}`));
    };

    if (query.status) add(`status = ?`, query.status);
    if (query.operatorId) add(`operator_id = ?`, query.operatorId);
    if (query.returnOperatorId) add(`return_operator_id = ?`, query.returnOperatorId);

    // created series
    const created = await prisma.$queryRawUnsafe<{ bucket: string; count: number }[]>(
      `
      select
        date_trunc('${bucket}', timezone($${i + 1}, created_at))::text as bucket,
        count(*)::int as count
      from bookings
      where ${baseClauses.join(" and ")}
      group by 1
      order by 1 asc
      `,
      ...baseParams,
      tz
    );

    // completed series (bucket on completed_at, and only completed rows)
    const completedWhere = [...baseClauses, `status = 'complete'`, `completed_at is not null`];
    const completed = await prisma.$queryRawUnsafe<{ bucket: string; count: number }[]>(
      `
      select
        date_trunc('${bucket}', timezone($${i + 1}, completed_at))::text as bucket,
        count(*)::int as count
      from bookings
      where ${completedWhere.join(" and ")}
      group by 1
      order by 1 asc
      `,
      ...baseParams,
      tz
    );

    return {
      bucket,
      timezone: tz,
      created,
      completed
    };
  });

  app.get("/sync/timeseries", async (req) => {
    const query = z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        bucket: BucketSchema.default("day"),
        timezone: z.string().min(1).default("UTC"),
        operatorId: z.string().min(3).optional(),
        deviceId: z.string().min(1).optional()
      })
      .parse(req.query);

    const bucket = query.bucket;
    const tz = query.timezone;

    const clauses: string[] = [`created_at >= $1`, `created_at < $2`];
    const params: any[] = [query.from, query.to];
    let i = params.length;
    const add = (clause: string, value: any) => {
      i += 1;
      params.push(value);
      clauses.push(clause.replace("?", `$${i}`));
    };
    if (query.operatorId) add(`operator_id = ?`, query.operatorId);
    if (query.deviceId) add(`device_id = ?`, query.deviceId);

    const rows = await prisma.$queryRawUnsafe<
      {
        bucket: string;
        eventCount: number;
        mutationCount: number;
        okCount: number;
        errorCount: number;
      }[]
    >(
      `
      select
        date_trunc('${bucket}', timezone($${i + 1}, created_at))::text as bucket,
        count(*)::int as "eventCount",
        coalesce(sum(mutation_count), 0)::int as "mutationCount",
        coalesce(sum(ok_count), 0)::int as "okCount",
        coalesce(sum(error_count), 0)::int as "errorCount"
      from sync_events
      where ${clauses.join(" and ")}
      group by 1
      order by 1 asc
      `,
      ...params,
      tz
    );

    return { bucket, timezone: tz, series: rows };
  });
};

