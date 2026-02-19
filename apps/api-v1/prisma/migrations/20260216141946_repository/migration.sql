CREATE SEQUENCE trans_inbox_seq START WITH 1000 INCREMENT BY 1 CACHE 100;

CREATE TABLE resource_inbox
(
    ri_row_id      bigint       NOT NULL DEFAULT nextval('trans_inbox_seq'),
    ri_resource_id varchar(36)  NOT NULL,
    ri_topic_id    varchar(36)  NOT NULL,
    ri_resource    text         NOT NULL,
    ri_type_id     varchar(36)  NOT NULL,
    ri_status      varchar(36)  NOT NULL,
    fk_ext_bank_id  varchar(35)  NOT NULL,
    system_date     date         NOT NULL,
    created_by      varchar(16)  NOT NULL,
    created_ts      timestamp(6) NOT NULL,
    start_ts        timestamp(6),
    end_ts          timestamp(6),
    next_ts         timestamp(6),
    ri_attempts    bigint,
    CONSTRAINT ri_pk PRIMARY KEY (ri_row_id),
    CONSTRAINT resource_inbox_unique_k UNIQUE (fk_ext_bank_id, ri_resource_id, ri_topic_id)
);

CREATE INDEX resource_inbox_ix ON resource_inbox (ri_status, ri_type_id);
