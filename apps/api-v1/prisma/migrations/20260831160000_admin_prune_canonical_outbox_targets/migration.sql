-- Stop old admin producers and queue readers before this migration; start only
-- the canonical reader afterwards. This translates retained transport envelopes,
-- including completed pages, without reopening work or changing business data.
DO $$
DECLARE
    queued_page record;
    envelope jsonb;
    page_work jsonb;
BEGIN
    FOR queued_page IN
        SELECT ri_row_id, ri_resource, ri_resource_id, ri_topic_id, fk_ext_bank_id
        FROM resource_inbox
        WHERE ri_type_id = 'APP_OUTBOX'
          AND ri_topic_id = 'rallar.admin.prune-expired'
        FOR UPDATE
    LOOP
        BEGIN
            envelope := queued_page.ri_resource::jsonb;
        EXCEPTION WHEN invalid_text_representation OR untranslatable_character OR numeric_value_out_of_range THEN
            CONTINUE;
        END;
        IF jsonb_typeof(envelope) IS DISTINCT FROM 'object'
           OR NOT envelope ?& ARRAY['id', 'route', 'targets', 'constraints', 'payload', 'audit']
           OR envelope - ARRAY['id', 'route', 'targets', 'constraints', 'payload', 'audit']
               IS DISTINCT FROM '{}'::jsonb
           OR envelope->'targets' IS DISTINCT FROM '{"mode":"all","scope":"global"}'::jsonb
           OR envelope->'route' IS DISTINCT FROM jsonb_build_object(
               'topicId', queued_page.ri_topic_id,
               'resourceId', queued_page.ri_resource_id,
               'contextId', queued_page.fk_ext_bank_id
           )
           OR jsonb_typeof(envelope->'id') IS DISTINCT FROM 'object'
           OR envelope->'id'->'v' IS DISTINCT FROM '2'::jsonb
           OR envelope->'id'->>'msgId' IS DISTINCT FROM queued_page.ri_resource_id
           OR jsonb_typeof(envelope->'payload') IS DISTINCT FROM 'object'
           OR envelope->'payload'->>'typeId' IS DISTINCT FROM 'ADMIN_PRUNE_EXPIRED'
           OR envelope->'payload'->>'contentType' IS DISTINCT FROM 'application/json'
           OR jsonb_typeof(envelope->'payload'->'resource') IS DISTINCT FROM 'string'
        THEN
            CONTINUE;
        END IF;
        BEGIN
            page_work := (envelope->'payload'->>'resource')::jsonb;
        EXCEPTION WHEN invalid_text_representation OR untranslatable_character OR numeric_value_out_of_range THEN
            CONTINUE;
        END;
        IF jsonb_typeof(page_work) IS DISTINCT FROM 'object'
           OR page_work->>'kind' IS DISTINCT FROM 'page'
        THEN
            CONTINUE;
        END IF;
        UPDATE resource_inbox
        SET ri_resource = jsonb_set(
            envelope, '{targets}', '{"mode":"broadcast","scope":"all"}'::jsonb, false
        )::text
        WHERE ri_row_id = queued_page.ri_row_id;
    END LOOP;
END $$;
