import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";

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
]);

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

export const syncRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req) => {
    (req as { operatorPhone?: string }).operatorPhone = await requireAccess(
      app,
      req.headers.authorization,
    );
  });

  app.post("/pull", async (req) => {
    z.object({
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }).parse(req.body ?? {});
    return { nextCursor: null as string | null, changes: [] as unknown[] };
  });

  app.post("/push", async (req) => {
    const operatorPhone = (req as { operatorPhone?: string }).operatorPhone as string;

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

    const results: Record<string, unknown>[] = [];
    let okCount = 0;
    let errorCount = 0;

    for (const m of body.mutations) {
      try {
        if (m.type === "booking_start") {
          const r = await applyBookingStart(operatorPhone, m);
          results.push(r);
          if ((r as { ok?: unknown }).ok === true) okCount += 1;
          else errorCount += 1;
          continue;
        }
        const r = await applyBookingFinish(operatorPhone, m);
        results.push(r);
        if ((r as { ok?: unknown }).ok === true) okCount += 1;
        else errorCount += 1;
      } catch (e) {
        if (isUniqueViolation(e)) {
          results.push({
            ok: false,
            type: m.type,
            error: "RACK_OR_CANDIDATE_CONFLICT",
          });
          errorCount += 1;
          continue;
        }
        req.log.error({ err: e, type: m.type }, "sync:push:mutation_error");
        results.push({
          ok: false,
          type: m.type,
          error: e instanceof Error ? e.message : "INTERNAL",
        });
        errorCount += 1;
      }
    }

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
      // Do not fail the sync request if analytics write fails.
    }

    return { cursor: null as string | null, results };
  });
};

async function applyBookingStart(
  operatorPhone: string,
  m: z.infer<typeof MutationSchema> & { type: "booking_start" },
) {
  return prisma.$transaction(async (tx) => {
    const byId = await tx.booking.findUnique({ where: { id: m.bookingId } });
    if (byId) {
      const same =
        byId.status === "active" &&
        byId.candidateId === m.candidateId &&
        byId.rackId === m.rackId;
      if (same) {
        return { ok: true, type: "booking_start" as const, booking: byId };
      }
      return {
        ok: false,
        type: "booking_start" as const,
        error: "BOOKING_ID_CONFLICT",
      };
    }

    const activeCandidate = await tx.booking.findFirst({
      where: { candidateId: m.candidateId, status: "active" },
    });
    if (activeCandidate) {
      return {
        ok: false,
        type: "booking_start" as const,
        error: "CANDIDATE_ALREADY_ACTIVE",
      };
    }

    const activeRack = await tx.booking.findFirst({
      where: { rackId: m.rackId, status: "active" },
    });
    if (activeRack) {
      return {
        ok: false,
        type: "booking_start" as const,
        error: "RACK_IN_USE",
      };
    }

    const booking = await tx.booking.create({
      data: {
        id: m.bookingId,
        rackId: m.rackId,
        candidateId: m.candidateId,
        operatorId: operatorPhone,
        status: "active",
        createdAt: m.startedAt ?? new Date(),
      },
    });

    return { ok: true, type: "booking_start" as const, booking };
  });
}

async function applyBookingFinish(
  operatorPhone: string,
  m: z.infer<typeof MutationSchema> & { type: "booking_finish" },
) {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: m.bookingId } });
    if (!booking) {
      return {
        ok: false,
        type: "booking_finish" as const,
        error: "BOOKING_NOT_FOUND",
      };
    }
    if (booking.status === "complete") {
      return { ok: true, type: "booking_finish" as const, booking };
    }
    if (booking.status !== "active") {
      return {
        ok: false,
        type: "booking_finish" as const,
        error: "BOOKING_NOT_ACTIVE",
      };
    }

    const updated = await tx.booking.update({
      where: { id: m.bookingId },
      data: {
        status: "complete",
        completedAt: m.endedAt ?? new Date(),
        returnOperatorId: operatorPhone,
      },
    });

    return { ok: true, type: "booking_finish" as const, booking: updated };
  });
}
