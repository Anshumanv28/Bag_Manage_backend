-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "return_operator_id" TEXT;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_return_operator_id_fkey" FOREIGN KEY ("return_operator_id") REFERENCES "operators"("phone") ON DELETE SET NULL ON UPDATE CASCADE;

-- SOP: at most one active (deposited) booking per roll (candidate) and per rack (lock)
CREATE UNIQUE INDEX "bookings_one_active_candidate_id" ON "bookings" ("candidate_id") WHERE "status" = 'active';

CREATE UNIQUE INDEX "bookings_one_active_lock_id" ON "bookings" ("lock_id") WHERE "status" = 'active';
