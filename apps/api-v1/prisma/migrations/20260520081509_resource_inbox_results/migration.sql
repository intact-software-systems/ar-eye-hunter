-- CreateTable
CREATE TABLE "resource_inbox_results" (
    "ris_row_id" BIGSERIAL NOT NULL,
    "ris_resource_id" VARCHAR(36) NOT NULL,
    "ris_topic_id" VARCHAR(36) NOT NULL,
    "ris_resource" TEXT NOT NULL,
    "ris_type_id" VARCHAR(36) NOT NULL,
    "ris_status" VARCHAR(36) NOT NULL,
    "fk_ext_bank_id" VARCHAR(35) NOT NULL,
    "system_date" DATE NOT NULL,
    "created_by" VARCHAR(16) NOT NULL,
    "created_ts" TIMESTAMP(6) NOT NULL,
    "expire_ts" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "ris_pk" PRIMARY KEY ("ris_row_id")
);

-- CreateIndex
CREATE INDEX "resource_inbox_results_expire_ts_ix" ON "resource_inbox_results"("expire_ts");

-- CreateIndex
CREATE INDEX "resource_inbox_results_ix" ON "resource_inbox_results"("ris_status", "ris_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_inbox_results_unique_k" ON "resource_inbox_results"("fk_ext_bank_id", "ris_resource_id", "ris_topic_id");
