-- CreateEnum
CREATE TYPE "ScanEventType" AS ENUM ('candidate_scanned', 'rack_scanned', 'deposit_cancelled', 'retrieve_cancelled');

-- CreateEnum
CREATE TYPE "ScanOperation" AS ENUM ('deposit', 'retrieve');

-- CreateTable
CREATE TABLE "scan_events" (
    "id" UUID NOT NULL,
    "operator_id" TEXT NOT NULL,
    "device_id" TEXT,
    "operation" "ScanOperation" NOT NULL,
    "event_type" "ScanEventType" NOT NULL,
    "candidate_id" TEXT,
    "rack_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_events_operator_id_occurred_at_idx" ON "scan_events"("operator_id", "occurred_at");

-- CreateIndex
CREATE INDEX "scan_events_created_at_idx" ON "scan_events"("created_at");

-- AddForeignKey
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;
