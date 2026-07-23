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
    ri_resource_id varchar(128) NOT NULL,
    ri_topic_id    varchar(36)  NOT NULL,
    ri_resource    text         NOT NULL,
    ri_type_id     varchar(36)  NOT NULL,
    ri_status      varchar(36)  NOT NULL,
    fk_ext_bank_id varchar(128) NOT NULL,
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

CREATE INDEX IF NOT EXISTS resource_inbox_runnable_ix
    ON resource_inbox (ri_type_id, ri_status, expire_ts, next_ts, ri_row_id);

CREATE INDEX IF NOT EXISTS resource_inbox_reserved_timeout_ix
    ON resource_inbox (ri_type_id, ri_status, start_ts, expire_ts, ri_row_id);

CREATE SEQUENCE IF NOT EXISTS trans_inbox_results_seq
    START WITH 1000
    INCREMENT BY 1
    CACHE 100;

CREATE TABLE IF NOT EXISTS resource_inbox_results
(
    ris_row_id      bigint       NOT NULL DEFAULT nextval('trans_inbox_results_seq'),
    ris_resource_id varchar(128) NOT NULL,
    ris_topic_id    varchar(36)  NOT NULL,
    ris_resource    text         NOT NULL,
    ris_type_id     varchar(36)  NOT NULL,
    ris_status      varchar(36)  NOT NULL,
    fk_ext_bank_id  varchar(128) NOT NULL,
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

CREATE INDEX IF NOT EXISTS runtime_state_store_namespace_key_c_ix
    ON runtime_state_store (store_namespace, store_key COLLATE "C");

CREATE INDEX IF NOT EXISTS runtime_state_store_namespace_expire_at_ix
    ON runtime_state_store (store_namespace, expire_at_ts);

CREATE INDEX IF NOT EXISTS runtime_state_store_expire_at_ix
    ON runtime_state_store (expire_at_ts);

CREATE TABLE IF NOT EXISTS client_state_events
(
    application_id       text   NOT NULL,
    workspace_key        text   NOT NULL,
    principal_id         text   NOT NULL,
    event_id             text   NOT NULL,
    event_type           text   NOT NULL,
    snapshot_version     bigint NOT NULL,
    occurred_at_epoch_ms bigint NOT NULL,
    client_instance_id   text,
    session_id           text,
    event_json           text   NOT NULL,
    CONSTRAINT client_state_events_pk PRIMARY KEY (application_id, workspace_key, principal_id, event_id)
);

CREATE INDEX IF NOT EXISTS client_state_events_page_ix
    ON client_state_events (application_id, workspace_key, principal_id, snapshot_version, occurred_at_epoch_ms, event_id);

CREATE INDEX IF NOT EXISTS client_state_events_type_page_ix
    ON client_state_events (application_id, workspace_key, principal_id, event_type, snapshot_version, occurred_at_epoch_ms, event_id);

CREATE TABLE IF NOT EXISTS group_state_events
(
    application_id       text   NOT NULL,
    workspace_key        text   NOT NULL,
    group_id             text   NOT NULL,
    event_id             text   NOT NULL,
    event_type           text   NOT NULL,
    snapshot_version     bigint NOT NULL,
    occurred_at_epoch_ms bigint NOT NULL,
    event_json           text   NOT NULL,
    CONSTRAINT group_state_events_pk PRIMARY KEY (application_id, workspace_key, group_id, event_id)
);

CREATE INDEX IF NOT EXISTS group_state_events_page_ix
    ON group_state_events (application_id, workspace_key, group_id, snapshot_version, occurred_at_epoch_ms, event_id);

CREATE INDEX IF NOT EXISTS group_state_events_type_page_ix
    ON group_state_events (application_id, workspace_key, group_id, event_type, snapshot_version, occurred_at_epoch_ms, event_id);

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

CREATE TABLE IF NOT EXISTS crdt_documents
(
    document_key         text                     NOT NULL,
    application_id       text                     NOT NULL,
    workspace_id         text,
    document_scope       text                     NOT NULL,
    document_type        text                     NOT NULL,
    document_id          text                     NOT NULL,
    document_ref         text                     NOT NULL,
    document_revision    bigint                   NOT NULL DEFAULT 0,
    lifecycle            text                     NOT NULL DEFAULT 'active',
    created_at_ts        timestamp with time zone NOT NULL DEFAULT now(),
    updated_at_ts        timestamp with time zone NOT NULL DEFAULT now(),
    archived_at_ts       timestamp with time zone,
    destroyed_at_ts      timestamp with time zone,
    last_append_sequence bigint                   NOT NULL DEFAULT 0,
    update_count         bigint                   NOT NULL DEFAULT 0,
    snapshot_count       bigint                   NOT NULL DEFAULT 0,
    stored_update_bytes  bigint                   NOT NULL DEFAULT 0,
    retention_policy     text,
    quota_policy         text,
    projection_ids       text,

    CONSTRAINT crdt_documents_pk PRIMARY KEY (document_key)
);

CREATE INDEX IF NOT EXISTS crdt_documents_lookup_ix
    ON crdt_documents (application_id, workspace_id, document_scope, document_type);

CREATE INDEX IF NOT EXISTS crdt_documents_lifecycle_ix
    ON crdt_documents (lifecycle);

CREATE TABLE IF NOT EXISTS crdt_updates
(
    document_key         text                     NOT NULL,
    append_sequence      bigint                   NOT NULL,
    update_id            text                     NOT NULL,
    update_envelope      text                     NOT NULL,
    accepted_update_hash text                     NOT NULL,
    actor_id             text        not null,
    principal_id         text        not null,
    session_id           text        not null,
    server_id            text        not null,
    authorization_scope  text                     NOT NULL,
    accepted_at_ts       timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT crdt_updates_pk PRIMARY KEY (document_key, append_sequence),
    CONSTRAINT crdt_updates_update_id_uq UNIQUE (document_key, update_id),
    CONSTRAINT crdt_updates_document_fk FOREIGN KEY (document_key)
        REFERENCES crdt_documents (document_key)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS crdt_updates_document_sequence_ix
    ON crdt_updates (document_key, append_sequence);

CREATE INDEX IF NOT EXISTS crdt_updates_update_id_ix
    ON crdt_updates (update_id);

CREATE TABLE IF NOT EXISTS crdt_snapshots
(
    document_key      text                     NOT NULL,
    snapshot_id       text                     NOT NULL,
    append_sequence   bigint                   NOT NULL,
    snapshot_envelope text                     NOT NULL,
    created_at_ts     timestamp with time zone NOT NULL DEFAULT now(),
    reason            text,

    CONSTRAINT crdt_snapshots_pk PRIMARY KEY (document_key, snapshot_id),
    CONSTRAINT crdt_snapshots_document_fk FOREIGN KEY (document_key)
        REFERENCES crdt_documents (document_key)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS crdt_snapshots_document_append_ix
    ON crdt_snapshots (document_key, append_sequence DESC);
