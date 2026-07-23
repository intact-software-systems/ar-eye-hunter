-- Legacy durable rows predate trusted ingress identity. Preserve them with
-- explicit sentinels so consumers can distinguish the backfill from a trusted
-- principal/session while all new authoritative rows remain structurally total.
update crdt_updates set
  actor_id = coalesce(actor_id, 'legacy:unknown-actor'),
  principal_id = coalesce(principal_id, 'legacy:unknown-principal'),
  session_id = coalesce(session_id, 'legacy:unknown-session'),
  server_id = coalesce(server_id, 'legacy:unknown-server')
where actor_id is null or principal_id is null or session_id is null or server_id is null;

update crdt_documents
set document_revision = greatest(1, update_count + snapshot_count)
where document_revision < 1;

update crdt_snapshots
set
  snapshot_envelope = jsonb_set(
    snapshot_envelope::jsonb,
    '{metadata,reason}',
    to_jsonb(case
      when reason is not null and btrim(reason) <> '' then reason
      else 'legacy-import'
    end),
    true
  )::text,
  reason = case
    when reason is not null and btrim(reason) <> '' then reason
    else 'legacy-import'
  end;

alter table crdt_updates
  alter column actor_id set not null,
  alter column principal_id set not null,
  alter column session_id set not null,
  alter column server_id set not null;

alter table crdt_documents
  alter column document_revision set default 1;

alter table crdt_snapshots
  alter column reason set not null;
