import type { Prisma } from "@prisma/client";

/** When bookings share a candidate or rack, mark them flagged. */
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
  }
}
