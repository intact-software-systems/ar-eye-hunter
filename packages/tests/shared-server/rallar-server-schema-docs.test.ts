import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('Rallar server storage schema docs', () => {
    it('keeps the physical storage summary aligned with runtime tables', () => {
        const docs = readWorkspaceFile(
            'packages/shared-server/rallar-server-repositories.md',
        );

        for (const tableName of [
            'runtime_state_store',
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
    });
});

function readWorkspaceFile(path: string): string {
    return readFileSync(resolve(ROOT, path), 'utf8');
}
