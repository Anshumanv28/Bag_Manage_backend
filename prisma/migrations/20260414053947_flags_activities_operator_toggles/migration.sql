-- CreateEnum
CREATE TYPE "FlaggedBookingReason" AS ENUM ('candidate_duplicate_active', 'rack_duplicate_active');

-- CreateEnum
CREATE TYPE "BookingActivityEventType" AS ENUM ('candidate_scanned', 'rack_scanned', 'deposit_confirmed', 'return_confirmed');

-- AlterTable
ALTER TABLE "operators" ADD COLUMN     "deposit_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "retrieve_enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "flagged_bookings" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "reason" "FlaggedBookingReason" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flagged_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_activities" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "operator_id" TEXT NOT NULL,
    "device_id" TEXT,
    "event_type" "BookingActivityEventType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "booking_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flagged_bookings_created_at_idx" ON "flagged_bookings"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "flagged_bookings_booking_id_reason_key" ON "flagged_bookings"("booking_id", "reason");

-- CreateIndex
CREATE INDEX "booking_activities_booking_id_occurred_at_idx" ON "booking_activities"("booking_id", "occurred_at");

-- CreateIndex
CREATE INDEX "bookings_candidate_id_status_idx" ON "bookings"("candidate_id", "status");

-- CreateIndex
CREATE INDEX "bookings_rack_id_status_idx" ON "bookings"("rack_id", "status");

-- CreateIndex
CREATE INDEX "bookings_updated_at_id_idx" ON "bookings"("updated_at", "id");

-- AddForeignKey
ALTER TABLE "flagged_bookings" ADD CONSTRAINT "flagged_bookings_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_activities" ADD CONSTRAINT "booking_activities_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_activities" ADD CONSTRAINT "booking_activities_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;
