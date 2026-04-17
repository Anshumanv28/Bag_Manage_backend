-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('active', 'complete', 'flagged', 'deleted');

-- CreateEnum
CREATE TYPE "ScanEventType" AS ENUM ('candidate_scanned', 'rack_scanned', 'deposit_cancelled', 'retrieve_cancelled', 'scan_rejected');

-- CreateEnum
CREATE TYPE "ScanOperation" AS ENUM ('deposit', 'retrieve');

-- CreateTable
CREATE TABLE "operators" (
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "deposit_enabled" BOOLEAN NOT NULL DEFAULT true,
    "retrieve_enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("phone")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "rack_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "return_operator_id" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "operator_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_events" (
    "id" UUID NOT NULL,
    "operator_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "mutation_count" INTEGER NOT NULL,
    "ok_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("id")
);

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
CREATE INDEX "bookings_rack_id_idx" ON "bookings"("rack_id");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE INDEX "bookings_candidate_id_idx" ON "bookings"("candidate_id");

-- CreateIndex
CREATE INDEX "bookings_candidate_id_status_idx" ON "bookings"("candidate_id", "status");

-- CreateIndex
CREATE INDEX "bookings_rack_id_status_idx" ON "bookings"("rack_id", "status");

-- CreateIndex
CREATE INDEX "bookings_updated_at_id_idx" ON "bookings"("updated_at", "id");

-- CreateIndex
CREATE INDEX "refresh_tokens_operator_id_idx" ON "refresh_tokens"("operator_id");

-- CreateIndex
CREATE INDEX "sync_events_operator_id_idx" ON "sync_events"("operator_id");

-- CreateIndex
CREATE INDEX "sync_events_created_at_idx" ON "sync_events"("created_at");

-- CreateIndex
CREATE INDEX "scan_events_operator_id_occurred_at_idx" ON "scan_events"("operator_id", "occurred_at");

-- CreateIndex
CREATE INDEX "scan_events_created_at_idx" ON "scan_events"("created_at");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_return_operator_id_fkey" FOREIGN KEY ("return_operator_id") REFERENCES "operators"("phone") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;
