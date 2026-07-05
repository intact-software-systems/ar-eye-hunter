ALTER TABLE crdt_documents
    ADD COLUMN IF NOT EXISTS stored_update_bytes bigint NOT NULL DEFAULT 0;

UPDATE crdt_documents document
SET stored_update_bytes = updates.update_bytes
FROM (
    SELECT document_key,
           coalesce(sum(octet_length(update_envelope)), 0)::bigint AS update_bytes
    FROM crdt_updates
    GROUP BY document_key
) updates
WHERE document.document_key = updates.document_key;
