CREATE TABLE client_state_events
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

CREATE INDEX client_state_events_page_ix
    ON client_state_events (application_id, workspace_key, principal_id, snapshot_version, occurred_at_epoch_ms, event_id);

CREATE INDEX client_state_events_type_page_ix
    ON client_state_events (application_id, workspace_key, principal_id, event_type, snapshot_version, occurred_at_epoch_ms, event_id);

CREATE TABLE group_state_events
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

CREATE INDEX group_state_events_page_ix
    ON group_state_events (application_id, workspace_key, group_id, snapshot_version, occurred_at_epoch_ms, event_id);

CREATE INDEX group_state_events_type_page_ix
    ON group_state_events (application_id, workspace_key, group_id, event_type, snapshot_version, occurred_at_epoch_ms, event_id);
