ALTER TABLE resource_inbox
    ALTER COLUMN ri_resource_id TYPE varchar(128),
    ALTER COLUMN fk_ext_bank_id TYPE varchar(128);

ALTER TABLE resource_inbox_results
    ALTER COLUMN ris_resource_id TYPE varchar(128),
    ALTER COLUMN fk_ext_bank_id TYPE varchar(128);
