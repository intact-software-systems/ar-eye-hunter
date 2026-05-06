CREATE TABLE app_data_store
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

CREATE INDEX app_data_store_store_ix
    ON app_data_store (app_namespace, store_name);

CREATE INDEX app_data_store_expire_at_ix
    ON app_data_store (expire_at_ts);

CREATE INDEX app_data_store_namespace_expire_at_ix
    ON app_data_store (app_namespace, expire_at_ts);
