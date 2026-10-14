import { assertEquals } from '@std/assert';

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

Deno.test('connected recent history preserves every produced runtime event in the complete durable journal', async () => {
    const server = await startControlServer({ RALLAR_BLACK_BOX_RETENTION_MAX_EVENTS: '3' });
    let nextId = 1;
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        eventHistory: { mode: 'recent', maxEvents: 2 },
        idFactory: (prefix) => prefix === 'runtime-instance' ? 'owned-journal-runtime' : `${prefix}-${nextId++}`
    });
    const client = createDefaultRallarBlackBoxControlClient({ runtime, heartbeatIntervalMs: 60_000, statsIntervalMs: 0 });
    try {
        client.connect({ url: `${server.baseUrl.replace('http:', 'ws:')}/control`, runId: 'recent-journal', agentId: 'agent', completedCommandIds: [] });
        await waitForConnected(client);
        for (let index = 0; index < 120; index++) {
            runtime.recordEvent({ kind: index % 2 === 0 ? 'message' : 'diagnostic', topic: `journal.${index}` });
        }
        await waitForJsonl(server.baseUrl, '/runs/recent-journal/artifacts/events.jsonl', 'journal.119');
        // Read the durable file directly: the HTTP preview's in-memory fallback cannot satisfy this assertion.
        const text = await Deno.readTextFile(`${server.storageDir}/runs/recent-journal/events.jsonl`);
        const rows: JournalRuntimeEvent[] = text.trim().split('\n').map((line) => JSON.parse(line));
        assertEquals(rows.map((row) => row.value.topic), ['rallar.bb.stats', ...Array.from({ length: 120 }, (_, index) => `journal.${index}`)]);
        assertEquals(rows.slice(1).map((row) => row.value.history?.ordinal), Array.from({ length: 120 }, (_, index) => index + 1));
        assertEquals(rows.slice(1).map((row) => row.value.history?.generation), Array(120).fill(0));
        assertEquals(rows.slice(1).map((row) => row.value.history?.runtimeId), Array(120).fill('owned-journal-runtime'));
        assertEquals(runtime.state().eventHistory.evictedEvents, 118);
        assertEquals(runtime.state().events.length, 2);
        assertEquals(runtime.state().eventHistory.totalEvents, 120);
        assertEquals(runtime.state().eventHistory.countsByKind.message, 60);
        assertEquals(runtime.state().eventHistory.countsByKind.diagnostic, 60);
        assertEquals(runtime.state().eventHistory.capture.status, 'continuous');
    }
    finally {
        client.dispose();
        await server.stop();
        await Deno.remove(server.storageDir, { recursive: true });
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

Deno.test('HTTP manifest admission rejects malformed history before creating any staged run', async () => {
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
            assertEquals(response.status, 400);
            await response.body?.cancel();
        }
        assertEquals(await getJson(server.baseUrl, '/distributed-runs'), { distributedRuns: [] });
    }
    finally {
        await server.stop();
        await Deno.remove(server.storageDir, { recursive: true });
    }
});
