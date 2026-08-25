import type { AppDataValueCodec } from '@shared-server/app-data/app-data-value-codec.ts';
import { createRallarServerAiResultPersistence, type RallarServerAiResultStorePort } from '@shared-server/rallar-ai/rallar-server-ai-result-persistence.ts';
import type { RallarAiJsonResult, RallarAiJsonValue } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';
import { createRallarServerAiTestResult } from './rallar-server-ai-test-fixtures.ts';

describe('Rallar server AI result persistence', () => {
    it('opens the selected current-format store and writes the generated result', async () => {
        const stored = createStoredResultCapture();
        const persist = createRallarServerAiResultPersistence({
            stores: stored.port,
            defaultStoreName: 'rallar-ai-results',
            defaultNamespace: 'server'
        });
        const result = createRallarServerAiTestResult();

        await persist({
            result,
            storeName: 'game-ai-results',
            namespace: 'game-server',
            key: 'result-1',
            ttlMs: 60_000
        });

        expect(stored.opened).toEqual({
            storeName: 'game-ai-results',
            namespace: 'game-server',
            ttlMs: 60_000,
            schemaVersion: 1
        });
        expect(stored.written).toEqual({ key: 'result-1', result });
    });

    it('does not touch persistence when authorization denies the write', async () => {
        const stored = createStoredResultCapture();
        const persist = createRallarServerAiResultPersistence({
            stores: stored.port,
            defaultStoreName: 'rallar-ai-results',
            defaultNamespace: 'server',
            authorize: () => false
        });

        await expect(persist({ result: createRallarServerAiTestResult() }))
            .rejects.toMatchObject({ code: 'unauthorized' });
        expect(stored.opened).toBeUndefined();
        expect(stored.written).toBeUndefined();
    });
});

interface StoredResultCapture {
    readonly port: RallarServerAiResultStorePort;
    readonly opened:
        | Readonly<{
            storeName: string;
            namespace: string;
            ttlMs?: number;
            schemaVersion: number;
        }>
        | undefined;
    readonly written:
        | Readonly<{
            key: string;
            result: RallarAiJsonResult<RallarAiJsonValue>;
        }>
        | undefined;
}

function createStoredResultCapture(): StoredResultCapture {
    let opened: StoredResultCapture['opened'];
    let written: StoredResultCapture['written'];
    const port: RallarServerAiResultStorePort = {
        open: async (
            storeName: string,
            options: Readonly<{
                codec: AppDataValueCodec<RallarAiJsonResult<RallarAiJsonValue>>;
                namespace: string;
                ttlMs?: number;
            }>
        ) => {
            opened = {
                storeName,
                namespace: options.namespace,
                ttlMs: options.ttlMs,
                schemaVersion: options.codec.schemaVersion
            };
            return {
                set: async (key, result) => {
                    written = { key, result };
                }
            };
        }
    };
    return {
        port,
        get opened() {
            return opened;
        },
        get written() {
            return written;
        }
    };
}
