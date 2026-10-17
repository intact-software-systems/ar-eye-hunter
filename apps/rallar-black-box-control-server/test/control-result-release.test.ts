import { assertEquals } from '@std/assert';

import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { ControlArtifactRecorder } from '../src/control-artifact-recorder.ts';

Deno.test('durable receipt requires storage and exact complete results on disk', async () => {
    const identity = { runId: 'durable', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
    const envelope = { kind: 'result' as const, protocolVersion: 1 as const, ...identity, commandId: result.commandId, ok: result.ok, result };
    const missing = new ControlArtifactRecorder({ storageDir: undefined, commandSnapshots: { snapshotCommand: () => undefined } });
    assertEquals((await missing.record(envelope)).left !== undefined, true);
    const storageDir = await Deno.makeTempDir();
    try {
        const recorder = new ControlArtifactRecorder({ storageDir, commandSnapshots: { snapshotCommand: () => undefined } });
        const written = await recorder.record(envelope);
        assertEquals(written.right?.length, 1);
        const receipts = await recorder.readResultReceipts(identity, ['captured']);
        assertEquals(receipts.right?.length, 1);
        const release = await runtime.releaseResults({ ...identity, requestId: 'durable-release', receipts: receipts.right! });
        assertEquals(release.status, 'released');
        const row = JSON.parse((await Deno.readTextFile(`${storageDir}/runs/durable/results.jsonl`)).trim());
        assertEquals(row.fullResult, JSON.parse(JSON.stringify(result)));
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('failed disk writes cannot become receipts after a later successful append', async () => {
    const storageDir = await Deno.makeTempDir();
    const identity = { runId: 'failed-disk', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute({ kind: 'health', commandId: 'never-release' }, identity);
    const envelope = { kind: 'result' as const, protocolVersion: 1 as const, ...identity, commandId: result.commandId, ok: result.ok, result };
    const recorder = new ControlArtifactRecorder({ storageDir, commandSnapshots: { snapshotCommand: () => undefined } });
    try {
        await Deno.writeTextFile(`${storageDir}/runs`, 'block directory creation');
        assertEquals((await recorder.record(envelope)).left !== undefined, true);
        assertEquals(runtime.state().commandHistory.length, 1);
        await Deno.remove(`${storageDir}/runs`);
        assertEquals((await recorder.record(envelope)).left !== undefined, true);
        assertEquals((await recorder.readResultReceipts(identity, [result.commandId])).left !== undefined, true);
        const stored = await Deno.readTextFile(`${storageDir}/runs/failed-disk/results.jsonl`);
        assertEquals(JSON.parse(stored).fullResult.commandId, 'never-release');
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('nested root capture binds every retained child and preserves complete event artifacts', async () => {
    const storageDir = await Deno.makeTempDir();
    const identity = { runId: 'nested', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const recorder = new ControlArtifactRecorder({ storageDir, commandSnapshots: { snapshotCommand: () => undefined } });
    try {
        const result = await runtime.execute({ kind: 'loop', commandId: 'loop', count: 3, commands: [{ kind: 'health' }] }, identity);
        const envelope = { kind: 'result' as const, protocolVersion: 1 as const, ...identity, commandId: result.commandId, ok: result.ok, result };
        for (const event of runtime.state().events) {
            await recorder.record({ kind: 'event', protocolVersion: 1, ...identity, atEpochMs: event.atEpochMs, payload: event });
        }
        assertEquals((await recorder.record(envelope)).left, undefined);
        const captured = await recorder.readResultReceipts(identity, ['loop']);
        assertEquals(captured.right?.length, 4);
        const before = await Deno.readTextFile(`${storageDir}/runs/nested/events.jsonl`);
        const released = await runtime.releaseResults({ ...identity, requestId: 'nested-release', receipts: captured.right! });
        assertEquals(released.status, 'released');
        assertEquals(runtime.state().commandHistory.length, 0);
        assertEquals(await Deno.readTextFile(`${storageDir}/runs/nested/events.jsonl`), before);
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('receipt selection keeps reused root IDs scoped to the latest reset generation', async () => {
    const storageDir = await Deno.makeTempDir();
    const identity = { runId: 'reset-scope', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const recorder = new ControlArtifactRecorder({ storageDir, commandSnapshots: { snapshotCommand: () => undefined } });
    try {
        for (let generation = 0; generation < 2; generation += 1) {
            const result = await runtime.execute({ kind: 'health', commandId: 'same' }, identity);
            await recorder.record({ kind: 'result', protocolVersion: 1, ...identity, commandId: 'same', ok: result.ok, result });
            const receipts = await recorder.readResultReceipts(identity, ['same']);
            assertEquals(receipts.right?.length, 1);
            assertEquals(receipts.right?.[0].capture.generation, generation);
            assertEquals((await runtime.releaseResults({ ...identity, requestId: `release-${generation}`, receipts: receipts.right! })).status, 'released');
            await runtime.execute({ kind: 'reset', commandId: `reset-${generation}` }, identity);
        }
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('canonical receipt budget never prevents full admitted result artifact persistence', async () => {
    const storageDir = await Deno.makeTempDir();
    const identity = { runId: 'large', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime({ commandExecutor: () => ({ status: 'ok', value: 'x'.repeat(1_048_577) }) });
    const recorder = new ControlArtifactRecorder({ storageDir, commandSnapshots: { snapshotCommand: () => undefined } });
    try {
        const result = await runtime.execute({ kind: 'health', commandId: 'large' }, identity);
        assertEquals(
            (await recorder.record({ kind: 'result', protocolVersion: 1, ...identity, commandId: result.commandId, ok: result.ok, result })).left !== undefined,
            true
        );
        const stored = JSON.parse(await Deno.readTextFile(`${storageDir}/runs/large/results.jsonl`));
        assertEquals(stored.fullResult, JSON.parse(JSON.stringify(result)));
        assertEquals((await recorder.readResultReceipts(identity, ['large'])).left !== undefined, true);
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});
