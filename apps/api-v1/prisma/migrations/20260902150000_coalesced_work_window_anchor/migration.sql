-- Coalesced app-outbox rows gain the series anchor `windowOpenedAtEpochMs`
-- on their coalescing metadata. Rows written before it existed anchor at
-- their stored latest request, the closest fact they carry; every reader
-- requires the anchor from here on.
UPDATE resource_inbox
SET ri_resource = jsonb_set(
    ri_resource::jsonb,
    '{payload,resource}',
    to_jsonb(
        jsonb_set(
            (ri_resource::jsonb #>> '{payload,resource}')::jsonb,
            '{data,__rallarCoalescedWork,windowOpenedAtEpochMs}',
            (ri_resource::jsonb #>> '{payload,resource}')::jsonb #> '{data,__rallarCoalescedWork,requestedAtEpochMs}'
        )::text
    )
)::text
WHERE ri_type_id = 'APP_OUTBOX'
  AND (ri_resource::jsonb #>> '{payload,resource}') IS NOT NULL
  AND ((ri_resource::jsonb #>> '{payload,resource}')::jsonb #> '{data,__rallarCoalescedWork,requestedAtEpochMs}') IS NOT NULL
  AND NOT ((ri_resource::jsonb #>> '{payload,resource}')::jsonb #> '{data,__rallarCoalescedWork}') ? 'windowOpenedAtEpochMs';

UPDATE resource_inbox_results
SET ris_resource = jsonb_set(
    ris_resource::jsonb,
    '{payload,resource}',
    to_jsonb(
        jsonb_set(
            (ris_resource::jsonb #>> '{payload,resource}')::jsonb,
            '{data,__rallarCoalescedWork,windowOpenedAtEpochMs}',
            (ris_resource::jsonb #>> '{payload,resource}')::jsonb #> '{data,__rallarCoalescedWork,requestedAtEpochMs}'
        )::text
    )
)::text
WHERE ris_type_id = 'APP_OUTBOX'
  AND (ris_resource::jsonb #>> '{payload,resource}') IS NOT NULL
  AND ((ris_resource::jsonb #>> '{payload,resource}')::jsonb #> '{data,__rallarCoalescedWork,requestedAtEpochMs}') IS NOT NULL
  AND NOT ((ris_resource::jsonb #>> '{payload,resource}')::jsonb #> '{data,__rallarCoalescedWork}') ? 'windowOpenedAtEpochMs';
