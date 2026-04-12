-- This migration was generated via `prisma migrate diff` to align the database
-- with the simplified schema (operators + bookings + refresh_tokens).

-- AlterEnum
BEGIN;
CREATE TYPE "BookingStatus_new" AS ENUM ('active', 'complete');
ALTER TABLE "public"."bookings" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "bookings" ALTER COLUMN "status" TYPE "BookingStatus_new" USING ("status"::text::"BookingStatus_new");
ALTER TYPE "BookingStatus" RENAME TO "BookingStatus_old";
ALTER TYPE "BookingStatus_new" RENAME TO "BookingStatus";
DROP TYPE "public"."BookingStatus_old";
ALTER TABLE "bookings" ALTER COLUMN "status" SET DEFAULT 'active';
COMMIT;

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_lock_id_fkey";

-- DropIndex
DROP INDEX "bookings_customer_id_idx";

-- AlterTable
ALTER TABLE "bookings" DROP COLUMN "customer_id",
DROP COLUMN "ended_at",
DROP COLUMN "entity_version",
DROP COLUMN "started_at",
ADD COLUMN     "candidate_id" TEXT NOT NULL,
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "operators" DROP COLUMN "entity_version";

-- DropTable
DROP TABLE "changes";

-- DropTable
DROP TABLE "locks";

-- DropEnum
DROP TYPE "ChangeEntityType";

-- DropEnum
DROP TYPE "ChangeOp";

-- DropEnum
DROP TYPE "LockAvailability";

-- DropEnum
DROP TYPE "LockState";

-- CreateIndex
CREATE INDEX "bookings_candidate_id_idx" ON "bookings"("candidate_id");

