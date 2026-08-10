CREATE TABLE "rtc_topology_delivery_stream" (
    "stream_id" UUID NOT NULL,
    "head_sequence" BIGINT NOT NULL DEFAULT 0,
    "retained_from_sequence" BIGINT NOT NULL DEFAULT 1,
    "lease_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rtc_topology_delivery_stream_pk" PRIMARY KEY ("stream_id"),
    CONSTRAINT "rtc_topology_delivery_stream_head_non_negative_ck"
        CHECK ("head_sequence" >= 0),
    CONSTRAINT "rtc_topology_delivery_stream_retained_positive_ck"
        CHECK ("retained_from_sequence" >= 1),
    CONSTRAINT "rtc_topology_delivery_stream_retained_head_ck"
        CHECK ("retained_from_sequence" <= "head_sequence" + 1)
);

CREATE TABLE "rtc_topology_delivery_log" (
    "publisher_stream_id" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "application_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "publication_id" TEXT NOT NULL,
    "outbox_topic_id" TEXT NOT NULL,
    "outbox_resource_id" TEXT NOT NULL,
    "outbox_context_id" TEXT NOT NULL,
    "retain_until" TIMESTAMPTZ(3) NOT NULL,
    "inserted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rtc_topology_delivery_log_pk"
        PRIMARY KEY ("publisher_stream_id", "sequence"),
    CONSTRAINT "rtc_topology_delivery_log_sequence_positive_ck"
        CHECK ("sequence" >= 1),
    CONSTRAINT "rtc_topology_delivery_log_application_non_empty_ck"
        CHECK (length(btrim("application_id")) > 0),
    CONSTRAINT "rtc_topology_delivery_log_workspace_non_empty_ck"
        CHECK (length(btrim("workspace_id")) > 0),
    CONSTRAINT "rtc_topology_delivery_log_group_non_empty_ck"
        CHECK (length(btrim("group_id")) > 0),
    CONSTRAINT "rtc_topology_delivery_log_publication_non_empty_ck"
        CHECK (length(btrim("publication_id")) > 0),
    CONSTRAINT "rtc_topology_delivery_log_topic_non_empty_ck"
        CHECK (length(btrim("outbox_topic_id")) > 0),
    CONSTRAINT "rtc_topology_delivery_log_resource_non_empty_ck"
        CHECK (length(btrim("outbox_resource_id")) > 0),
    CONSTRAINT "rtc_topology_delivery_log_context_non_empty_ck"
        CHECK (length(btrim("outbox_context_id")) > 0)
);

CREATE UNIQUE INDEX "rtc_topology_delivery_log_publication_uq"
    ON "rtc_topology_delivery_log" (
        "application_id",
        "workspace_id",
        "group_id",
        "publication_id"
    );

CREATE INDEX "rtc_topology_delivery_log_retain_until_ix"
    ON "rtc_topology_delivery_log" ("retain_until");

CREATE TABLE "rtc_topology_replay_cursor" (
    "consumer_stream_id" UUID NOT NULL,
    "publisher_stream_id" UUID NOT NULL,
    "last_processed_sequence" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rtc_topology_replay_cursor_pk"
        PRIMARY KEY ("consumer_stream_id", "publisher_stream_id"),
    CONSTRAINT "rtc_topology_replay_cursor_sequence_non_negative_ck"
        CHECK ("last_processed_sequence" >= 0)
);

ALTER TABLE "rtc_topology_delivery_log"
    ADD CONSTRAINT "rtc_topology_delivery_log_publisher_fk"
    FOREIGN KEY ("publisher_stream_id")
    REFERENCES "rtc_topology_delivery_stream" ("stream_id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

ALTER TABLE "rtc_topology_replay_cursor"
    ADD CONSTRAINT "rtc_topology_replay_cursor_consumer_fk"
    FOREIGN KEY ("consumer_stream_id")
    REFERENCES "rtc_topology_delivery_stream" ("stream_id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

ALTER TABLE "rtc_topology_replay_cursor"
    ADD CONSTRAINT "rtc_topology_replay_cursor_publisher_fk"
    FOREIGN KEY ("publisher_stream_id")
    REFERENCES "rtc_topology_delivery_stream" ("stream_id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;
