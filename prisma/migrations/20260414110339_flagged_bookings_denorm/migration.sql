/*
  Warnings:

  - Added the required column `candidate_id` to the `flagged_bookings` table without a default value. This is not possible if the table is not empty.
  - Added the required column `operator_id` to the `flagged_bookings` table without a default value. This is not possible if the table is not empty.
  - Added the required column `rack_id` to the `flagged_bookings` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "flagged_bookings" DROP CONSTRAINT "flagged_bookings_booking_id_fkey";

-- AlterTable
ALTER TABLE "flagged_bookings" ADD COLUMN     "candidate_id" TEXT NOT NULL,
ADD COLUMN     "operator_id" TEXT NOT NULL,
ADD COLUMN     "rack_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "flagged_bookings_candidate_id_idx" ON "flagged_bookings"("candidate_id");

-- CreateIndex
CREATE INDEX "flagged_bookings_rack_id_idx" ON "flagged_bookings"("rack_id");
