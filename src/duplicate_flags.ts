import crypto from "node:crypto";

import type { Prisma } from "@prisma/client";
import { FlaggedBookingReason } from "@prisma/client";

/** When bookings share a candidate or rack, mark them flagged and record the flag (idempotent). */
export async function refreshDuplicateFlagsForKeys(
  tx: Prisma.TransactionClient,
  candidateIds: string[],
  rackIds: string[],
): Promise<void> {
  const uniqC = [...new Set(candidateIds)];
  const uniqR = [...new Set(rackIds)];

  for (const candidateId of uniqC) {
    const rows = await tx.booking.findMany({
      where: { status: { in: ["active", "flagged"] }, candidateId },
      select: { id: true, rackId: true, operatorId: true },
    });
    if (rows.length <= 1) continue;
    await tx.booking.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: "flagged" },
    });
    await tx.flaggedBooking.createMany({
      data: rows.map((r) => ({
        id: crypto.randomUUID(),
        bookingId: r.id,
        reason: FlaggedBookingReason.candidate_duplicate_active,
        candidateId,
        rackId: r.rackId,
        operatorId: r.operatorId,
      })),
      skipDuplicates: true,
    });
  }

  for (const rackId of uniqR) {
    const rows = await tx.booking.findMany({
      where: { status: { in: ["active", "flagged"] }, rackId },
      select: { id: true, candidateId: true, operatorId: true },
    });
    if (rows.length <= 1) continue;
    await tx.booking.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: "flagged" },
    });
    await tx.flaggedBooking.createMany({
      data: rows.map((r) => ({
        id: crypto.randomUUID(),
        bookingId: r.id,
        reason: FlaggedBookingReason.rack_duplicate_active,
        candidateId: r.candidateId,
        rackId,
        operatorId: r.operatorId,
      })),
      skipDuplicates: true,
    });
  }
}
