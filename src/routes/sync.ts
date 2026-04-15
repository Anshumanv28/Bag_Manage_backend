import type { FastifyPluginAsync } from "fastify";
import { BookingStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { refreshDuplicateFlagsForKeys } from "../duplicate_flags.js";

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

const MutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("booking_start"),
    bookingId: z.string().uuid(),
    rackId: z.string().min(1),
    candidateId: z.string().min(1),
    startedAt: z.coerce.date().optional(),
  }),
  z.object({
    type: z.literal("booking_finish"),
    bookingId: z.string().uuid(),
    endedAt: z.coerce.date().optional(),
  }),
  z.object({
    type: z.literal("scan_event"),
    scanEventId: z.string().uuid(),
    operation: z.enum(["deposit", "retrieve"]),
    eventType: z.enum([
      "candidate_scanned",
      "rack_scanned",
      "deposit_cancelled",
      "retrieve_cancelled",
    ]),
    candidateId: z.string().min(1).optional(),
    rackId: z.string().min(1).optional(),
    occurredAt: z.coerce.date().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }),
]);

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

type PullCursor = { updatedAt: string; id: string };

function decodePullCursor(cursor: string): { updatedAt: Date; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as PullCursor;
  if (!parsed?.updatedAt || !parsed?.id) throw new Error("INVALID_CURSOR");
  const updatedAt = new Date(parsed.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) throw new Error("INVALID_CURSOR");
  return { updatedAt, id: parsed.id };
}

function encodePullCursor(v: { updatedAt: Date; id: string }): string {
  const payload: PullCursor = {
    updatedAt: v.updatedAt.toISOString(),
    id: v.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function bookingToPullPayload(b: {
  id: string;
  candidateId: string;
  rackId: string;
  operatorId: string;
  returnOperatorId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  deletedAt: Date | null;
}) {
  return {
    id: b.id,
    candidateId: b.candidateId,
    rackId: b.rackId,
    operatorId: b.operatorId,
    returnOperatorId: b.returnOperatorId,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    completedAt: b.completedAt ? b.completedAt.toISOString() : null,
    deletedAt: b.deletedAt ? b.deletedAt.toISOString() : null,
  };
}

export const syncRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req) => {
    (req as { operatorPhone?: string }).operatorPhone = await requireAccess(
      app,
      req.headers.authorization,
    );
  });

  app.post("/pull", async (req, reply) => {
    let body: { cursor?: string; limit?: number };
    try {
      body = z
        .object({
          cursor: z.string().min(1).optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        })
        .parse(req.body ?? {});
    } catch {
      return reply.code(400).send({ error: "INVALID_BODY" });
    }

    const limit = body.limit ?? 200;

    // Full snapshot model: return ALL current (non-deleted) bookings to devices so
    // clients can infer server-side deletions by absence, without a separate ids endpoint.
    const visibility: Prisma.BookingWhereInput = { deletedAt: null };

    let cursorWhere: Prisma.BookingWhereInput = {};
    if (body.cursor) {
      try {
        const c = decodePullCursor(body.cursor);
        cursorWhere = {
          OR: [
            { updatedAt: { gt: c.updatedAt } },
            { AND: [{ updatedAt: c.updatedAt }, { id: { gt: c.id } }] },
          ],
        };
      } catch {
        return reply.code(400).send({ error: "INVALID_CURSOR" });
      }
    }

    type PullBookingRow = {
      id: string;
      candidateId: string;
      rackId: string;
      operatorId: string;
      returnOperatorId: string | null;
      status: string;
      createdAt: Date;
      updatedAt: Date;
      completedAt: Date | null;
      deletedAt: Date | null;
    };

    const rows = (await prisma.booking.findMany({
      where: { AND: [visibility, cursorWhere] },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
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
      } as unknown as Prisma.BookingSelect,
    })) as unknown as PullBookingRow[];

    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit
        ? encodePullCursor({
            updatedAt: page[page.length - 1]!.updatedAt,
            id: page[page.length - 1]!.id,
          })
        : null;

    const changes: unknown[] = [];
    for (const b of page) {
      changes.push({
        type: "booking_upsert",
        booking: bookingToPullPayload(b),
      });
    }

    return { nextCursor, changes };
  });

  app.post("/push", async (req) => {
    const operatorPhone = (req as { operatorPhone?: string })
      .operatorPhone as string;

    const body = z
      .object({
        deviceId: z.string().min(1),
        mutations: z.array(MutationSchema).max(500),
      })
      .parse(req.body);

    req.log.debug(
      {
        reqId: req.id,
        deviceId: body.deviceId,
        mutationCount: body.mutations.length,
      },
      "sync:push",
    );

    const results: Record<string, unknown>[] = Array.from(
      { length: body.mutations.length },
      (_, i) => ({
        ok: false,
        type: body.mutations[i]!.type,
        error: "NOT_PROCESSED",
      }),
    );
    let okCount = 0;
    let errorCount = 0;

    await prisma.$transaction(
      async (tx) => {
        const bookingIds = Array.from(
          new Set(
            body.mutations
              .map((m) => {
                if (m.type === "scan_event") return null;
                return m.bookingId;
              })
              .filter(
                (x): x is string => typeof x === "string" && x.length > 0,
              ),
          ),
        );

        const existingBookings = bookingIds.length
          ? await tx.booking.findMany({
              where: { id: { in: bookingIds } },
              select: {
                id: true,
                status: true,
                candidateId: true,
                rackId: true,
                operatorId: true,
              },
            })
          : [];

        const byId = new Map(existingBookings.map((b) => [b.id, b]));

        const startCreates: {
          id: string;
          rackId: string;
          candidateId: string;
          operatorId: string;
          status: "active";
          createdAt: Date;
        }[] = [];

        const stagedById = new Map<
          string,
          {
            id: string;
            status: "active" | "complete";
            candidateId: string;
            rackId: string;
            operatorId: string;
          }
        >();

        for (let i = 0; i < body.mutations.length; i++) {
          const m = body.mutations[i]!;
          if (m.type !== "booking_start") continue;

          try {
            const existing = byId.get(m.bookingId);
            if (existing) {
              const same =
                existing.status === "active" &&
                existing.candidateId === m.candidateId &&
                existing.rackId === m.rackId;
              if (same) {
                results[i] = { ok: true, type: "booking_start" };
                okCount += 1;
              } else {
                results[i] = {
                  ok: false,
                  type: "booking_start",
                  error: "BOOKING_ID_CONFLICT",
                };
                errorCount += 1;
              }
              continue;
            }

            startCreates.push({
              id: m.bookingId,
              rackId: m.rackId,
              candidateId: m.candidateId,
              operatorId: operatorPhone,
              status: "active",
              createdAt: m.startedAt ?? new Date(),
            });
            stagedById.set(m.bookingId, {
              id: m.bookingId,
              status: "active",
              candidateId: m.candidateId,
              rackId: m.rackId,
              operatorId: operatorPhone,
            });

            results[i] = { ok: true, type: "booking_start" };
            okCount += 1;
          } catch (e) {
            if (isUniqueViolation(e)) {
              results[i] = {
                ok: false,
                type: m.type,
                error: "RACK_OR_CANDIDATE_CONFLICT",
              };
              errorCount += 1;
              continue;
            }
            req.log.error({ err: e, type: m.type }, "sync:push:mutation_error");
            results[i] = {
              ok: false,
              type: m.type,
              error: e instanceof Error ? e.message : "INTERNAL",
            };
            errorCount += 1;
          }
        }

        if (startCreates.length) {
          await tx.booking.createMany({ data: startCreates });
          for (const [id, b] of stagedById) byId.set(id, b);

          await refreshDuplicateFlagsForKeys(
            tx,
            startCreates.map((s) => s.candidateId),
            startCreates.map((s) => s.rackId),
          );

          // Conflicts are handled by `refreshDuplicateFlagsForKeys` which marks bookings as `flagged`.
        }

        for (let i = 0; i < body.mutations.length; i++) {
          const m = body.mutations[i]!;
          if (m.type !== "scan_event") continue;

          try {
            const scanTx = tx as typeof tx & {
              scanEvent: {
                findUnique: (args: unknown) => Promise<unknown>;
                create: (args: unknown) => Promise<unknown>;
              };
            };

            const existing = await scanTx.scanEvent.findUnique({
              where: { id: m.scanEventId },
            });
            if (existing) {
              results[i] = { ok: true, type: "scan_event" };
              okCount += 1;
              continue;
            }

            await scanTx.scanEvent.create({
              data: {
                id: m.scanEventId,
                operatorId: operatorPhone,
                deviceId: body.deviceId,
                operation: m.operation,
                eventType: m.eventType,
                candidateId: m.candidateId ?? null,
                rackId: m.rackId ?? null,
                occurredAt: m.occurredAt ?? new Date(),
                metadata:
                  m.metadata === undefined
                    ? undefined
                    : (m.metadata as Prisma.InputJsonValue),
              },
            });

            results[i] = { ok: true, type: "scan_event" };
            okCount += 1;
          } catch (e) {
            if (isUniqueViolation(e)) {
              results[i] = { ok: true, type: "scan_event" };
              okCount += 1;
              continue;
            }
            req.log.error({ err: e, type: m.type }, "sync:push:mutation_error");
            results[i] = {
              ok: false,
              type: m.type,
              error: e instanceof Error ? e.message : "INTERNAL",
            };
            errorCount += 1;
          }
        }

        for (let i = 0; i < body.mutations.length; i++) {
          const m = body.mutations[i]!;
          if (m.type !== "booking_finish") continue;

          try {
            const existing = byId.get(m.bookingId);
            if (!existing) {
              results[i] = {
                ok: false,
                type: "booking_finish",
                error: "BOOKING_NOT_FOUND",
              };
              errorCount += 1;
              continue;
            }
            if (existing.status === "complete") {
              results[i] = { ok: true, type: "booking_finish" };
              okCount += 1;
              continue;
            }
            if (existing.status === "flagged") {
              results[i] = {
                ok: false,
                type: "booking_finish",
                error: "FLAGGED_BOOKING",
              };
              errorCount += 1;
              continue;
            }
            if (existing.status !== "active") {
              results[i] = {
                ok: false,
                type: "booking_finish",
                error: "BOOKING_NOT_ACTIVE",
              };
              errorCount += 1;
              continue;
            }

            await tx.booking.update({
              where: { id: m.bookingId },
              data: {
                status: "complete",
                completedAt: m.endedAt ?? new Date(),
                returnOperatorId: operatorPhone,
              },
            });
            byId.set(m.bookingId, { ...existing, status: "complete" });

            results[i] = { ok: true, type: "booking_finish" };
            okCount += 1;
          } catch (e) {
            if (isUniqueViolation(e)) {
              results[i] = {
                ok: false,
                type: m.type,
                error: "RACK_OR_CANDIDATE_CONFLICT",
              };
              errorCount += 1;
              continue;
            }
            req.log.error({ err: e, type: m.type }, "sync:push:mutation_error");
            results[i] = {
              ok: false,
              type: m.type,
              error: e instanceof Error ? e.message : "INTERNAL",
            };
            errorCount += 1;
          }
        }
      },
      {
        timeout: 60_000,
        maxWait: 60_000,
      },
    );

    try {
      await prisma.syncEvent.create({
        data: {
          operatorId: operatorPhone,
          deviceId: body.deviceId,
          mutationCount: body.mutations.length,
          okCount,
          errorCount,
        },
      });
    } catch (e) {
      req.log.error({ err: e }, "sync:push:sync_event_write_failed");
    }

    return { cursor: null as string | null, results };
  });
};
