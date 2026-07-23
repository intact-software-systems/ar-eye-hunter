ALTER TABLE crdt_documents
    ADD COLUMN document_revision bigint NOT NULL DEFAULT 0;

UPDATE crdt_documents
SET document_revision = update_count + snapshot_count
WHERE document_revision = 0;
