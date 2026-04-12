-- CreateEnum
CREATE TYPE "LockState" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "LockAvailability" AS ENUM ('available', 'assigned', 'maintenance');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('active', 'ended', 'cancelled');

-- CreateEnum
CREATE TYPE "ChangeEntityType" AS ENUM ('operator', 'lock', 'booking');

-- CreateEnum
CREATE TYPE "ChangeOp" AS ENUM ('upsert', 'delete');

-- CreateTable
CREATE TABLE "operators" (
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("phone")
);

-- CreateTable
CREATE TABLE "locks" (
    "lock_id" TEXT NOT NULL,
    "lock_state" "LockState" NOT NULL DEFAULT 'open',
    "availability" "LockAvailability" NOT NULL DEFAULT 'available',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locks_pkey" PRIMARY KEY ("lock_id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "lock_id" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

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
CREATE TABLE "changes" (
    "id" UUID NOT NULL,
    "entity_type" "ChangeEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "op" "ChangeOp" NOT NULL,
    "entity_version" BIGINT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by_operator_id" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bookings_lock_id_idx" ON "bookings"("lock_id");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE INDEX "bookings_customer_id_idx" ON "bookings"("customer_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_operator_id_idx" ON "refresh_tokens"("operator_id");

-- CreateIndex
CREATE INDEX "changes_entity_type_changed_at_id_idx" ON "changes"("entity_type", "changed_at", "id");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_lock_id_fkey" FOREIGN KEY ("lock_id") REFERENCES "locks"("lock_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;
