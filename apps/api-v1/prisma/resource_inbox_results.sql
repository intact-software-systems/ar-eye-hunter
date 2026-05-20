CREATE SEQUENCE trans_inbox_results_seq START WITH 1000 INCREMENT BY 1 CACHE 100;

CREATE TABLE resource_inbox_results
(
    ris_row_id      bigint       NOT NULL DEFAULT nextval('trans_inbox_results_seq'),
    ris_resource_id varchar(36)  NOT NULL,
    ris_topic_id    varchar(36)  NOT NULL,
    ris_resource    text         NOT NULL,
    ris_type_id     varchar(36)  NOT NULL,
    ris_status      varchar(36)  NOT NULL,
    fk_ext_bank_id varchar(35)  NOT NULL,
    system_date    date         NOT NULL,
    created_by     varchar(16)  NOT NULL,
    created_ts     timestamp(6) NOT NULL,
    expire_ts      timestamp(6) NOT NULL,
    CONSTRAINT ris_pk PRIMARY KEY (ris_row_id),
    CONSTRAINT resource_inbox_results_unique_k UNIQUE (fk_ext_bank_id, ris_resource_id, ris_topic_id)
);

CREATE INDEX resource_inbox_results_ix ON resource_inbox_results (ris_status, ris_type_id);
CREATE INDEX resource_inbox_results_expire_ts_ix ON resource_inbox_results (expire_ts);