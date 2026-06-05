CREATE TABLE crdt_documents
(
    document_key         text                     NOT NULL,
    application_id       text                     NOT NULL,
    workspace_id         text,
    document_scope       text                     NOT NULL,
    document_type        text                     NOT NULL,
    document_id          text                     NOT NULL,
    document_ref         text                     NOT NULL,
    lifecycle            text                     NOT NULL DEFAULT 'active',
    created_at_ts        timestamp with time zone NOT NULL DEFAULT now(),
    updated_at_ts        timestamp with time zone NOT NULL DEFAULT now(),
    archived_at_ts       timestamp with time zone,
    destroyed_at_ts      timestamp with time zone,
    last_append_sequence bigint                   NOT NULL DEFAULT 0,
    update_count         bigint                   NOT NULL DEFAULT 0,
    snapshot_count       bigint                   NOT NULL DEFAULT 0,
    retention_policy     text,
    quota_policy         text,
    projection_ids       text,

    CONSTRAINT crdt_documents_pk PRIMARY KEY (document_key)
);

CREATE INDEX crdt_documents_lookup_ix
    ON crdt_documents (application_id, workspace_id, document_scope, document_type);

CREATE INDEX crdt_documents_lifecycle_ix
    ON crdt_documents (lifecycle);

CREATE TABLE crdt_updates
(
    document_key         text                     NOT NULL,
    append_sequence      bigint                   NOT NULL,
    update_id            text                     NOT NULL,
    update_envelope      text                     NOT NULL,
    accepted_update_hash text                     NOT NULL,
    actor_id             text,
    principal_id         text,
    session_id           text,
    server_id            text,
    authorization_scope  text                     NOT NULL,
    accepted_at_ts       timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT crdt_updates_pk PRIMARY KEY (document_key, append_sequence),
    CONSTRAINT crdt_updates_update_id_uq UNIQUE (document_key, update_id),
    CONSTRAINT crdt_updates_document_fk FOREIGN KEY (document_key)
        REFERENCES crdt_documents (document_key)
        ON DELETE CASCADE
);

CREATE INDEX crdt_updates_document_sequence_ix
    ON crdt_updates (document_key, append_sequence);

CREATE INDEX crdt_updates_update_id_ix
    ON crdt_updates (update_id);

CREATE TABLE crdt_snapshots
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

CREATE INDEX crdt_snapshots_document_append_ix
    ON crdt_snapshots (document_key, append_sequence DESC);
