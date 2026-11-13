import { expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as realFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Captured before any `mock.module` installs a fake, so mocks can delegate to the real filesystem.
const realAppendFile = realFsPromises.appendFile;

test('durable receipt requires storage and exact complete results on disk', async () => {
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
    expect((await missing.record(envelope)).left !== undefined).toEqual(true);
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-black-box-'));
    try {
        const recorder = new ControlArtifactRecorder({
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
            storageDir,
            commandSnapshots: { snapshotCommand: () => undefined }
        });
        const written = await recorder.record(envelope);
        expect(written.right?.length).toEqual(1);
        const receipts = await recorder.readResultReceipts(identity, ['captured']);
        expect(receipts.right?.length).toEqual(1);
        const release = await runtime.releaseResults({ ...identity, requestId: 'durable-release', receipts: receipts.right! });
        expect(release.status).toEqual('released');
        const row = JSON.parse((await readFile(`${storageDir}/runs/durable/results.jsonl`, 'utf8')).trim());
        expect(row.fullResult).toEqual(JSON.parse(JSON.stringify(result)));
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('failed disk writes cannot become receipts after a later successful append', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-black-box-'));
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
        await writeFile(`${storageDir}/runs`, 'block directory creation', 'utf8');
        expect((await recorder.record(envelope)).left !== undefined).toEqual(true);
        expect(runtime.state().commandHistory.length).toEqual(1);
        await rm(`${storageDir}/runs`, { force: true });
        expect((await recorder.record(envelope)).left !== undefined).toEqual(true);
        expect((await recorder.readResultReceipts(identity, [result.commandId])).left !== undefined).toEqual(true);
        const stored = await readFile(`${storageDir}/runs/failed-disk/results.jsonl`, 'utf8');
        expect(JSON.parse(stored).fullResult.commandId).toEqual('never-release');
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('nested root capture binds every retained child and preserves complete event artifacts', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-black-box-'));
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
        expect((await recorder.record(envelope)).left).toEqual(undefined);
        const projection = runtime.state().events.find((event) => event.kind === 'result' && event.commandId === 'loop')!;
        await recorder.record({ kind: 'event', protocolVersion: 1, ...identity, atEpochMs: projection.atEpochMs, payload: projection });
        const captured = await recorder.readResultReceipts(identity, ['loop']);
        expect(captured.right?.length).toEqual(4);
        const before = await readFile(`${storageDir}/runs/nested/events.jsonl`, 'utf8');
        const released = await runtime.releaseResults({ ...identity, requestId: 'nested-release', receipts: captured.right! });
        expect(released.status).toEqual('released');
        expect(runtime.state().commandHistory.length).toEqual(0);
        expect(await readFile(`${storageDir}/runs/nested/events.jsonl`, 'utf8')).toEqual(before);
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('receipt selection keeps reused root IDs scoped to the latest reset generation', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-black-box-'));
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
            expect(receipts.right?.length).toEqual(1);
            expect(receipts.right?.[0].capture.generation).toEqual(generation);
            expect((await runtime.releaseResults({ ...identity, requestId: `release-${generation}`, receipts: receipts.right! })).status).toEqual('released');
            await runtime.execute({ kind: 'reset', commandId: `reset-${generation}` }, identity);
        }
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('a 50-agent result above the retention node budget is certified and released end to end', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-black-box-'));
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
        expect(toRetentionLimitBreach(result)).toEqual('canonicalNodes');
        const recorded = await recorder.record({ kind: 'result', protocolVersion: 1, ...identity, commandId: result.commandId, ok: result.ok, result });
        expect(recorded.left).toEqual(undefined);
        const receipts = await recorder.readResultReceipts(identity, ['director']);
        expect(receipts.left).toEqual(undefined);
        expect(receipts.right?.length).toEqual(1);
        const release = await runtime.releaseResults({ ...identity, requestId: 'fifty-agent-release', receipts: receipts.right! });
        expect(release.status).toEqual('released');
        expect(release.releasedResults).toEqual(1);
        const stored = JSON.parse(await readFile(`${storageDir}/runs/fifty-agent/results.jsonl`, 'utf8'));
        expect(stored.fullResult).toEqual(JSON.parse(JSON.stringify(result)));
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('a result beyond its capture budget is persisted in full but never certified', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-black-box-'));
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
        const recorded = await recorder.record({ kind: 'result', protocolVersion: 1, ...identity, commandId: result.commandId, ok: result.ok, result });
        expect(recorded.left).toEqual(`Result capture exceeded the stringCharacters bound of ${RESULT_CAPTURE_LIMITS.stringCharacters}.`);
        const stored = JSON.parse(await readFile(`${storageDir}/runs/large/results.jsonl`, 'utf8'));
        expect(stored.fullResult).toEqual(JSON.parse(JSON.stringify(result)));
        expect((await recorder.readResultReceipts(identity, ['large'])).left !== undefined).toEqual(true);
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('batched capture acknowledges only after flush and rejects release after overflow', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-black-box-'));
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
        expect(acknowledged).toEqual(false);
        await recorder.stop();
        expect((await recording).right?.length).toEqual(1);
        expect((await recorder.readResultReceipts(identity, ['captured'])).right?.length).toEqual(1);
        const overflow = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: { snapshotCommand: () => undefined },
            timers,
            config: { flushIntervalMs: 250, maxPendingBytes: 1 }
        });
        expect((await overflow.record(envelope)).left !== undefined).toEqual(true);
        await overflow.stop();
        expect((await overflow.readResultReceipts(identity, ['captured'])).left !== undefined).toEqual(true);
        expect(runtime.state().commandHistory.length).toEqual(1);
    }
    finally {
        await recorder.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('overflow during receipt persistence prevents a successful capture acknowledgement', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-black-box-'));
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
    let releaseJournal = () => {};
    let journalStarted = () => {};
    const journalEntered = new Promise<void>((resolve) => {
        journalStarted = resolve;
    });
    const journalBlocked = new Promise<void>((resolve) => {
        releaseJournal = resolve;
    });
    mock.module('node:fs/promises', () => ({
        ...realFsPromises,
        appendFile: async (...args: Parameters<typeof realAppendFile>) => {
            if (String(args[0]).endsWith('/result-receipts.jsonl')) {
                journalStarted();
                await journalBlocked;
            }
            return realAppendFile(...args);
        }
    }));
    try {
        const captured = recorder.record({ kind: 'result', protocolVersion: 1, ...identity, commandId: result.commandId, ok: result.ok, result });
        const flushing = recorder.stop();
        await journalEntered;
        const dropped = recorder.record({ kind: 'event', protocolVersion: 1, ...identity, atEpochMs: 1, payload: { large: 'x'.repeat(5_000) } });
        expect((await dropped).left !== undefined).toEqual(true);
        releaseJournal();
        await flushing;
        expect((await captured).left !== undefined).toEqual(true);
        expect((await recorder.readResultReceipts(identity, ['captured'])).left !== undefined).toEqual(true);
    }
    finally {
        releaseJournal();
        await recorder.stop();
        await rm(storageDir, { recursive: true, force: true });
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
