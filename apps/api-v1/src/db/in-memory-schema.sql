-- Ephemeral API-v1 SQL schema for RALLAR_SQL_BACKEND=pglite-memory and
-- RALLAR_SQL_BACKEND=pglite-file.
--
-- Keep this file idempotent. In-memory startup applies the final repository
-- schema directly and does not execute Prisma migrations.

CREATE SEQUENCE IF NOT EXISTS trans_inbox_seq
    START WITH 1000
    INCREMENT BY 1
    CACHE 100;

CREATE TABLE IF NOT EXISTS resource_inbox
(
    ri_row_id      bigint       NOT NULL DEFAULT nextval('trans_inbox_seq'),
    ri_resource_id varchar(36)  NOT NULL,
    ri_topic_id    varchar(36)  NOT NULL,
    ri_resource    text         NOT NULL,
    ri_type_id     varchar(36)  NOT NULL,
    ri_status      varchar(36)  NOT NULL,
    fk_ext_bank_id varchar(35)  NOT NULL,
    system_date    date         NOT NULL,
    created_by     varchar(16)  NOT NULL,
    created_ts     timestamp(6) NOT NULL,
    start_ts       timestamp(6),
    end_ts         timestamp(6),
    next_ts        timestamp(6),
    ri_attempts    bigint,
    expire_ts      timestamp(6) NOT NULL,
    CONSTRAINT ri_pk PRIMARY KEY (ri_row_id),
    CONSTRAINT resource_inbox_unique_k UNIQUE (fk_ext_bank_id, ri_resource_id, ri_topic_id)
);

CREATE INDEX IF NOT EXISTS resource_inbox_ix
    ON resource_inbox (ri_status, ri_type_id);

CREATE INDEX IF NOT EXISTS resource_inbox_expire_ts_ix
    ON resource_inbox (expire_ts);

CREATE SEQUENCE IF NOT EXISTS trans_inbox_results_seq
    START WITH 1000
    INCREMENT BY 1
    CACHE 100;

CREATE TABLE IF NOT EXISTS resource_inbox_results
(
    ris_row_id      bigint       NOT NULL DEFAULT nextval('trans_inbox_results_seq'),
    ris_resource_id varchar(36)  NOT NULL,
    ris_topic_id    varchar(36)  NOT NULL,
    ris_resource    text         NOT NULL,
    ris_type_id     varchar(36)  NOT NULL,
    ris_status      varchar(36)  NOT NULL,
    fk_ext_bank_id  varchar(35)  NOT NULL,
    system_date     date         NOT NULL,
    created_by      varchar(16)  NOT NULL,
    created_ts      timestamp(6) NOT NULL,
    expire_ts       timestamp(6) NOT NULL,
    CONSTRAINT ris_pk PRIMARY KEY (ris_row_id),
    CONSTRAINT resource_inbox_results_unique_k UNIQUE (fk_ext_bank_id, ris_resource_id, ris_topic_id)
);

CREATE INDEX IF NOT EXISTS resource_inbox_results_ix
    ON resource_inbox_results (ris_status, ris_type_id);

CREATE INDEX IF NOT EXISTS resource_inbox_results_expire_ts_ix
    ON resource_inbox_results (expire_ts);

CREATE TABLE IF NOT EXISTS runtime_state_store
(
    store_namespace text                     NOT NULL,
    store_key       text                     NOT NULL,
    store_value     text                     NOT NULL,
    updated_ts      timestamp with time zone NOT NULL DEFAULT now(),
    expire_at_ts    timestamp with time zone NOT NULL,
    revision        bigint                   NOT NULL DEFAULT 0,
    CONSTRAINT runtime_state_store_pk PRIMARY KEY (store_namespace, store_key)
);

CREATE INDEX IF NOT EXISTS runtime_state_store_namespace_ix
    ON runtime_state_store (store_namespace);

CREATE INDEX IF NOT EXISTS runtime_state_store_namespace_expire_at_ix
    ON runtime_state_store (store_namespace, expire_at_ts);

CREATE INDEX IF NOT EXISTS runtime_state_store_expire_at_ix
    ON runtime_state_store (expire_at_ts);

CREATE TABLE IF NOT EXISTS app_data_store
(
    app_namespace  text                     NOT NULL,
    store_name     text                     NOT NULL,
    data_key       text                     NOT NULL,
    data_value     text                     NOT NULL,
    schema_version integer                  NOT NULL DEFAULT 1,
    expire_at_ts   timestamp with time zone NOT NULL,
    updated_ts     timestamp with time zone NOT NULL DEFAULT now(),
    revision       bigint                   NOT NULL DEFAULT 0,
    CONSTRAINT app_data_store_pk PRIMARY KEY (app_namespace, store_name, data_key)
);

CREATE INDEX IF NOT EXISTS app_data_store_store_ix
    ON app_data_store (app_namespace, store_name);

CREATE INDEX IF NOT EXISTS app_data_store_expire_at_ix
    ON app_data_store (expire_at_ts);

CREATE INDEX IF NOT EXISTS app_data_store_namespace_expire_at_ix
    ON app_data_store (app_namespace, expire_at_ts);
