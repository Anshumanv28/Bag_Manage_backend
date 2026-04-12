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

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req) => {
    requireAdmin(req);
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

