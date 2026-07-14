import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('Rallar server storage schema docs', () => {
    it('keeps the physical storage summary aligned with runtime tables', () => {
        const docs = readWorkspaceFile(
            'packages/shared-server/rallar-server-repositories.md',
        );

        for (const tableName of [
            'runtime_state_store',
            'client_state_events',
            'group_state_events',
            'resource_inbox',
            'resource_inbox_results',
            'app_data_store',
            'crdt_documents',
            'crdt_updates',
            'crdt_snapshots',
        ]) {
            expect(docs).toContain(tableName);
        }
    });

    it('keeps CRDT tables represented in the API-v1 Prisma schema', () => {
        const schema = readWorkspaceFile('apps/api-v1/prisma/schema.prisma');

        for (const modelName of [
            'crdt_documents',
            'crdt_updates',
            'crdt_snapshots',
        ]) {
            expect(schema).toContain(`model ${modelName}`);
        }

        expect(schema).toContain('stored_update_bytes');
    });

    it('keeps CRDT update-byte counter backfill represented in API-v1 migrations', () => {
        const migration = readWorkspaceFile(
            'apps/api-v1/prisma/migrations/20260702193000_crdt_stored_update_bytes/migration.sql',
        );

        expect(migration).toContain('ADD COLUMN IF NOT EXISTS stored_update_bytes');
        expect(migration).toContain('sum(octet_length(update_envelope))');
    });

    it('keeps state event tables represented in the API-v1 Prisma schema', () => {
        const schema = readWorkspaceFile('apps/api-v1/prisma/schema.prisma');

        for (const modelName of [
            'client_state_events',
            'group_state_events',
        ]) {
            expect(schema).toContain(`model ${modelName}`);
        }

        for (const indexName of [
            'client_state_events_page_ix',
            'client_state_events_type_page_ix',
            'group_state_events_page_ix',
            'group_state_events_type_page_ix',
        ]) {
            expect(schema).toContain(indexName);
        }
    });

    it('keeps QueueBox dequeue indexes represented in the API-v1 Prisma schema', () => {
        const schema = readWorkspaceFile('apps/api-v1/prisma/schema.prisma');

        for (const indexName of [
            'resource_inbox_runnable_ix',
            'resource_inbox_reserved_timeout_ix',
        ]) {
            expect(schema).toContain(indexName);
        }
    });

    it('keeps QueueBox planner statistics represented in API-v1 migrations', () => {
        const migration = readWorkspaceFile(
            'apps/api-v1/prisma/migrations/20260702184500_resource_inbox_type_status_stats/migration.sql',
        );

        expect(migration).toContain('CREATE STATISTICS IF NOT EXISTS resource_inbox_type_status_stats');
        expect(migration).toContain('ON ri_type_id, ri_status');
        expect(migration).toContain('ANALYZE resource_inbox');
    });

    it('keeps the C-collated runtime-state prefix index represented in API-v1 migrations', () => {
        const migrationPath =
            'apps/api-v1/prisma/migrations/20260714170000_runtime_state_store_c_prefix_index/migration.sql';

        expect(existsSync(resolve(ROOT, migrationPath))).toBe(true);
        const migration = readWorkspaceFile(migrationPath).replace(/\s+/g, ' ');
        expect(migration).toContain(
            'CREATE INDEX IF NOT EXISTS runtime_state_store_namespace_key_c_ix ON runtime_state_store (store_namespace, store_key COLLATE "C")',
        );
    });

    it('documents state snapshots and event logs in the architecture notes', () => {
        const docs = readWorkspaceFile('packages/shared-server/architecture.md')
            .replace(/\s+/g, ' ');

        expect(docs).toContain('client/group snapshots in `runtime_state_store`');
        expect(docs).toContain('state-event logs in `client_state_events` and `group_state_events`');
    });
});

function readWorkspaceFile(path: string): string {
    return readFileSync(resolve(ROOT, path), 'utf8');
}
