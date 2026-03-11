CREATE TABLE runtime_state_store
(
    store_namespace text                     NOT NULL,
    store_key       text                     NOT NULL,
    store_value     text                     NOT NULL,
    updated_ts      timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT runtime_state_store_pk PRIMARY KEY (store_namespace, store_key)
);

CREATE INDEX runtime_state_store_namespace_ix
    ON runtime_state_store (store_namespace);
