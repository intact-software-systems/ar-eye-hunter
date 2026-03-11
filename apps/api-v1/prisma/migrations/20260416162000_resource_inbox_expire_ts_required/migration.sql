ALTER TABLE resource_inbox
    ADD COLUMN expire_ts timestamp(6);

UPDATE resource_inbox
SET expire_ts = '9999-12-31 23:59:59.999999'
WHERE expire_ts IS NULL;

ALTER TABLE resource_inbox
    ALTER COLUMN expire_ts SET NOT NULL;

CREATE INDEX resource_inbox_expire_ts_ix ON resource_inbox (expire_ts);
