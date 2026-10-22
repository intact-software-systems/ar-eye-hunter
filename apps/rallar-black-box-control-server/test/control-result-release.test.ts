import { assertEquals } from '@std/assert';

import {
    canonicalControlRetentionJson,
    ControlRetentionPlanLimitError
} from '@shared-test/rallar-bb-test/control-retention-canonical.ts';
import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RESULT_CAPTURE_LIMITS } from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { createManualTimers } from '../../../packages/tests/shared/resilience/manual-timers.ts';
import { ControlArtifactRecorder, DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG } from '../src/control-artifact-recorder.ts';

Deno.test('durable receipt requires storage and exact complete results on disk', async () => {
    const identity = { runId: 'durable', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
    const envelope = { kind: 'result' as const, protocolVersion: 1 as const, ...identity, commandId: result.commandId, ok: result.ok, result };
    const missing = new ControlArtifactRecorder({
        timers: createDefaultTimers(),
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
        storageDir: undefined,
        commandSnapshots: { snapshotCommand: () => undefined }
    });
    assertEquals((await missing.record(envelope)).left !== undefined, true);
    const storageDir = await Deno.makeTempDir();
    try {
        const recorder = new ControlArtifactRecorder({
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
            storageDir,
            commandSnapshots: { snapshotCommand: () => undefined }
        });
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
    const recorder = new ControlArtifactRecorder({
        timers: createDefaultTimers(),
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
        storageDir,
        commandSnapshots: { snapshotCommand: () => undefined }
    });
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
    const recorder = new ControlArtifactRecorder({
        timers: createDefaultTimers(),
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
        storageDir,
        commandSnapshots: { snapshotCommand: () => undefined }
    });
    try {
        const result = await runtime.execute({ kind: 'loop', commandId: 'loop', count: 3, commands: [{ kind: 'health' }] }, identity);
        const envelope = { kind: 'result' as const, protocolVersion: 1 as const, ...identity, commandId: result.commandId, ok: result.ok, result };
        for (const event of runtime.state().events) {
            await recorder.record({ kind: 'event', protocolVersion: 1, ...identity, atEpochMs: event.atEpochMs, payload: event });
        }
        assertEquals((await recorder.record(envelope)).left, undefined);
        const projection = runtime.state().events.find((event) => event.kind === 'result' && event.commandId === 'loop')!;
        await recorder.record({ kind: 'event', protocolVersion: 1, ...identity, atEpochMs: projection.atEpochMs, payload: projection });
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
    const recorder = new ControlArtifactRecorder({
        timers: createDefaultTimers(),
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
        storageDir,
        commandSnapshots: { snapshotCommand: () => undefined }
    });
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

Deno.test('a 50-agent result above the retention node budget is certified and released end to end', async () => {
    const storageDir = await Deno.makeTempDir();
    const identity = { runId: 'fifty-agent', agentId: 'director' };
    const runtime = createDefaultRallarBlackBoxTestRuntime({ commandExecutor: () => ({ status: 'ok', value: createFiftyAgentDirectorValue() }) });
    const recorder = new ControlArtifactRecorder({
        timers: createDefaultTimers(),
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
        storageDir,
        commandSnapshots: { snapshotCommand: () => undefined }
    });
    try {
        const result = await runtime.execute({ kind: 'health', commandId: 'director' }, identity);
        // The fixture must exceed the retention canonicalizer's node budget, or the test proves nothing.
        assertEquals(toRetentionLimitBreach(result), 'canonicalNodes');
        const recorded = await recorder.record({ kind: 'result', protocolVersion: 1, ...identity, commandId: result.commandId, ok: result.ok, result });
        assertEquals(recorded.left, undefined);
        const receipts = await recorder.readResultReceipts(identity, ['director']);
        assertEquals(receipts.left, undefined);
        assertEquals(receipts.right?.length, 1);
        const release = await runtime.releaseResults({ ...identity, requestId: 'fifty-agent-release', receipts: receipts.right! });
        assertEquals(release.status, 'released');
        assertEquals(release.releasedResults, 1);
        const stored = JSON.parse(await Deno.readTextFile(`${storageDir}/runs/fifty-agent/results.jsonl`));
        assertEquals(stored.fullResult, JSON.parse(JSON.stringify(result)));
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('a result beyond its capture budget is persisted in full but never certified', async () => {
    const storageDir = await Deno.makeTempDir();
    const identity = { runId: 'large', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: () => ({ status: 'ok', value: 'x'.repeat(RESULT_CAPTURE_LIMITS.stringCharacters + 1) })
    });
    const recorder = new ControlArtifactRecorder({
        timers: createDefaultTimers(),
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
        storageDir,
        commandSnapshots: { snapshotCommand: () => undefined }
    });
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

Deno.test('batched capture acknowledges only after flush and rejects release after overflow', async () => {
    const storageDir = await Deno.makeTempDir();
    const timers = createManualTimers(0);
    const identity = { runId: 'batched-release', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
    const envelope = { kind: 'result' as const, protocolVersion: 1 as const, ...identity, commandId: result.commandId, ok: result.ok, result };
    const recorder = new ControlArtifactRecorder({
        storageDir,
        commandSnapshots: { snapshotCommand: () => undefined },
        timers,
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
    });
    try {
        let acknowledged = false;
        const recording = recorder.record(envelope).then((outcome) => {
            acknowledged = true;
            return outcome;
        });
        await Promise.resolve();
        assertEquals(acknowledged, false);
        await recorder.stop();
        assertEquals((await recording).right?.length, 1);
        assertEquals((await recorder.readResultReceipts(identity, ['captured'])).right?.length, 1);
        const overflow = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: { snapshotCommand: () => undefined },
            timers,
            config: { flushIntervalMs: 250, maxPendingBytes: 1 }
        });
        assertEquals((await overflow.record(envelope)).left !== undefined, true);
        await overflow.stop();
        assertEquals((await overflow.readResultReceipts(identity, ['captured'])).left !== undefined, true);
        assertEquals(runtime.state().commandHistory.length, 1);
    }
    finally {
        await recorder.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('overflow during receipt persistence prevents a successful capture acknowledgement', async () => {
    const storageDir = await Deno.makeTempDir();
    const timers = createManualTimers(0);
    const identity = { runId: 'receipt-race', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
    const recorder = new ControlArtifactRecorder({
        storageDir,
        commandSnapshots: { snapshotCommand: () => undefined },
        timers,
        config: { flushIntervalMs: 250, maxPendingBytes: 4_000 }
    });
    const writeTextFile = Deno.writeTextFile;
    let releaseJournal = () => {};
    let journalStarted = () => {};
    const journalEntered = new Promise<void>((resolve) => {
        journalStarted = resolve;
    });
    const journalBlocked = new Promise<void>((resolve) => {
        releaseJournal = resolve;
    });
    Deno.writeTextFile = async (...args: Parameters<typeof writeTextFile>) => {
        if (String(args[0]).endsWith('/result-receipts.jsonl')) {
            journalStarted();
            await journalBlocked;
        }
        return writeTextFile(...args);
    };
    try {
        const captured = recorder.record({ kind: 'result', protocolVersion: 1, ...identity, commandId: result.commandId, ok: result.ok, result });
        const flushing = recorder.stop();
        await journalEntered;
        const dropped = recorder.record({ kind: 'event', protocolVersion: 1, ...identity, atEpochMs: 1, payload: { large: 'x'.repeat(5_000) } });
        assertEquals((await dropped).left !== undefined, true);
        releaseJournal();
        await flushing;
        assertEquals((await captured).left !== undefined, true);
        assertEquals((await recorder.readResultReceipts(identity, ['captured'])).left !== undefined, true);
    }
    finally {
        releaseJournal();
        Deno.writeTextFile = writeTextFile;
        await recorder.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});

function createFiftyAgentDirectorValue(): ApiJsonObject {
    return {
        agents: Array.from({ length: 50 }, (_, agent) => ({
            agentId: `agent-${agent}`,
            ok: true,
            samples: Array.from({ length: 2_500 }, (_, sample) => sample % 1_000)
        }))
    };
}

function toRetentionLimitBreach(result: RallarBlackBoxTestResult): string | undefined {
    try {
        canonicalControlRetentionJson(result);
        return undefined;
    }
    catch (error) {
        return error instanceof ControlRetentionPlanLimitError ? error.limit : undefined;
    }
}
