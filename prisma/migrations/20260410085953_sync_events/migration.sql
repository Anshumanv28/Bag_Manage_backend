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

-- CreateIndex
CREATE INDEX "sync_events_operator_id_idx" ON "sync_events"("operator_id");

-- CreateIndex
CREATE INDEX "sync_events_created_at_idx" ON "sync_events"("created_at");

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;
