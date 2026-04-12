-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "entity_version" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "locks" ADD COLUMN     "entity_version" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "operators" ADD COLUMN     "entity_version" BIGINT NOT NULL DEFAULT 0;
