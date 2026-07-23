ALTER TABLE crdt_documents
    ADD COLUMN document_revision bigint NOT NULL DEFAULT 1;

UPDATE crdt_documents
SET document_revision = greatest(1, update_count + snapshot_count)
WHERE document_revision < 1;
