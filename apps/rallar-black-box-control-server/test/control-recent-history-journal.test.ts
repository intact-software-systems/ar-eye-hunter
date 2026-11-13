import { expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';

import { createDefaultRallarBlackBoxControlClient } from '@shared-test/rallar-bb-test/control-client.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { waitForJsonl } from './support/control-api-test-agent.ts';
import {
    ADMIN_TOKEN,
    adminHeaders,
    getJson,
    startControlServer
} from './support/control-api-test-server.ts';
import { toDistributedManifest } from './support/control-service-test-fixtures.ts';

interface JournalRuntimeEvent {
    readonly value: {
        readonly topic: string;
        readonly history?: { readonly runtimeId: string; readonly generation: number; readonly ordinal: number; };
    };
}

test('connected recent history preserves every produced runtime event in the complete durable journal', async () => {
    const server = await startControlServer({ RALLAR_BLACK_BOX_RETENTION_MAX_EVENTS: '3' });
    let nextId = 1;
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        eventHistory: { mode: 'recent', maxEvents: 2 },
        idFactory: (prefix) => prefix === 'runtime-instance' ? 'owned-journal-runtime' : `${prefix}-${nextId++}`
    });
    const client = createDefaultRallarBlackBoxControlClient({
        runtime,
        heartbeatIntervalMs: 60_000,
        statsIntervalMs: 0,
        browserCensusIntervalMs: 0
    });
    try {
        client.connect({ url: `${server.baseUrl.replace('http:', 'ws:')}/control`, runId: 'recent-journal', agentId: 'agent', completedCommandIds: [] });
        await waitForConnected(client);
        for (let index = 0; index < 120; index++) {
            runtime.recordEvent({ kind: index % 2 === 0 ? 'message' : 'diagnostic', topic: `journal.${index}` });
        }
        await waitForJsonl(server.baseUrl, '/runs/recent-journal/artifacts/events.jsonl', 'journal.119');
        // Read the durable file directly: the HTTP preview's in-memory fallback cannot satisfy this assertion.
        const text = await readFile(`${server.storageDir}/runs/recent-journal/events.jsonl`, 'utf8');
        const rows: JournalRuntimeEvent[] = text.trim().split('\n').map((line) => JSON.parse(line));
        expect(rows.map((row) => row.value.topic)).toEqual(['rallar.bb.stats', ...Array.from({ length: 120 }, (_, index) => `journal.${index}`)]);
        expect(rows.slice(1).map((row) => row.value.history?.ordinal)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1));
        expect(rows.slice(1).map((row) => row.value.history?.generation)).toEqual(Array(120).fill(0));
        expect(rows.slice(1).map((row) => row.value.history?.runtimeId)).toEqual(Array(120).fill('owned-journal-runtime'));
        expect(runtime.state().eventHistory.evictedEvents).toEqual(118);
        expect(runtime.state().events.length).toEqual(2);
        expect(runtime.state().eventHistory.totalEvents).toEqual(120);
        expect(runtime.state().eventHistory.countsByKind.message).toEqual(60);
        expect(runtime.state().eventHistory.countsByKind.diagnostic).toEqual(60);
        expect(runtime.state().eventHistory.capture.status).toEqual('continuous');
    }
    finally {
        client.dispose();
        await server.stop();
        await rm(server.storageDir, { recursive: true, force: true });
    }
});

async function waitForConnected(client: ReturnType<typeof createDefaultRallarBlackBoxControlClient>): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (client.getSnapshot().state !== 'registered') {
        if (Date.now() > deadline) {
            throw new Error('Owned journal client did not connect.');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('HTTP manifest admission rejects malformed history before creating any staged run', async () => {
    const server = await startControlServer({ RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN });
    try {
        for (
            const eventHistory of [{ mode: 'recent', maxEvents: 0 }, { mode: 'recent', maxEvents: 1.5 }, { mode: 'full', maxEvents: 2 }, {
                mode: 'recent',
                maxEvents: 9007199254740992
            }]
        ) {
            const response = await fetch(`${server.baseUrl}/distributed-runs`, {
                method: 'POST',
                headers: adminHeaders(),
                body: JSON.stringify({ manifest: { ...toDistributedManifest(), eventHistory } })
            });
            expect(response.status).toEqual(400);
            await response.body?.cancel();
        }
        expect(await getJson(server.baseUrl, '/distributed-runs')).toEqual({ distributedRuns: [] });
    }
    finally {
        await server.stop();
        await rm(server.storageDir, { recursive: true, force: true });
    }
});
