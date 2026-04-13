-- Rename lock -> rack (SOP); remove unused table_id.
DROP INDEX IF EXISTS "bookings_one_active_lock_id";

ALTER TABLE "bookings" RENAME COLUMN "lock_id" TO "rack_id";

DROP INDEX IF EXISTS "bookings_lock_id_idx";
CREATE INDEX "bookings_rack_id_idx" ON "bookings"("rack_id");

CREATE UNIQUE INDEX "bookings_one_active_rack_id" ON "bookings" ("rack_id") WHERE "status" = 'active';

ALTER TABLE "bookings" DROP COLUMN "table_id";
