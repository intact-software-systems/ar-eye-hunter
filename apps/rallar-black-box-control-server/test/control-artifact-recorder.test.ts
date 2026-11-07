import { expect, mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as realFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxTestRecord } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { createManualTimers } from '../../../packages/tests/shared/resilience/manual-timers.ts';
import {
    ControlArtifactRecorder,
    DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
} from '../src/control-artifact-recorder.ts';
import { toRunDirectoryName } from '../src/control-artifact-storage.ts';

const NO_COMMAND_SNAPSHOTS = { snapshotCommand: () => undefined };

// Captured before any `mock.module` installs a fake, so mocks can delegate to the real filesystem.
const realAppendFile = realFsPromises.appendFile;
const realMkdir = realFsPromises.mkdir;
const realRm = realFsPromises.rm;

// One installed mock serves the whole file; the helpers below switch its behaviour through shared state. This keeps
// nested stalls composable, where re-mocking per helper would drop the outer stall.
let onAppend: ((path: string) => void) | undefined;
let onMkdir: (() => void) | undefined;
let appendBlocker: { started: () => void; released: Promise<void>; } | undefined;
const rmStalls = new Map<string, { announce: () => void; released: Promise<void>; }>();

mock.module('node:fs/promises', () => ({
    ...realFsPromises,
    appendFile: async (...args: Parameters<typeof realAppendFile>) => {
        onAppend?.(String(args[0]));
        if (appendBlocker) {
            appendBlocker.started();
            await appendBlocker.released;
        }
        return realAppendFile(...args);
    },
    mkdir: async (...args: Parameters<typeof realMkdir>) => {
        onMkdir?.();
        return realMkdir(...args);
    },
    rm: async (...args: Parameters<typeof realRm>) => {
        const stall = rmStalls.get(String(args[0]));
        if (stall) {
            stall.announce();
            await stall.released;
        }
        return realRm(...args);
    }
}));

function emptyRunSnapshot(runId: string): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 0,
        updatedAtEpochMs: 0,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

function eventEnvelope(runId: string, eventId: string, marker: string): ControlClientEnvelope {
    return {
        kind: 'event',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId,
        agentId: 'agent-a',
        atEpochMs: 1,
        eventId,
        payload: marker
    };
}

function eventsTextForRun(
    recorder: ControlArtifactRecorder,
    runId: string
): Promise<string> {
    return recorder.response({ runId, kind: 'events', fallbackRun: emptyRunSnapshot(runId), corsOrigins: [] })
        .then((response) => response.text());
}

async function readTextFileOrEmpty(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

test('artifact recorder keeps "%" and "_25" run ids on separate disk paths', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-percent-'));
    try {
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });
        recorder.record(eventEnvelope('%', 'percent-event', 'percent-marker'));
        recorder.record(eventEnvelope('_25', 'underscore-event', 'underscore-marker'));

        const percentEvents = await eventsTextForRun(recorder, '%');
        const underscoreEvents = await eventsTextForRun(recorder, '_25');

        assert(percentEvents.includes('percent-marker'));
        assert(!percentEvents.includes('underscore-marker'));
        assert(underscoreEvents.includes('underscore-marker'));
        assert(!underscoreEvents.includes('percent-marker'));
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('artifact recorder keeps "/" and "_2F" run ids on separate disk paths', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-slash-'));
    try {
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });
        recorder.record(eventEnvelope('/', 'slash-event', 'slash-marker'));
        recorder.record(eventEnvelope('_2F', 'literal-2f-event', 'literal-2f-marker'));

        const slashEvents = await eventsTextForRun(recorder, '/');
        const literalEvents = await eventsTextForRun(recorder, '_2F');

        assert(slashEvents.includes('slash-marker'));
        assert(!slashEvents.includes('literal-2f-marker'));
        assert(literalEvents.includes('literal-2f-marker'));
        assert(!literalEvents.includes('slash-marker'));
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('deleting one colliding run id leaves the other run\'s stored marker intact', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-delete-'));
    try {
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });
        recorder.record(eventEnvelope('%', 'percent-event', 'percent-marker'));
        recorder.record(eventEnvelope('_25', 'underscore-event', 'underscore-marker'));

        recorder.deleteRun('%');

        const percentEvents = await eventsTextForRun(recorder, '%');
        const underscoreEvents = await eventsTextForRun(recorder, '_25');

        assert(!percentEvents.includes('percent-marker'));
        assert(underscoreEvents.includes('underscore-marker'));
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('recording and deleting "." and ".." run ids stays inside their own runs/ directory', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-dots-'));
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    try {
        await writeFile(snapshotPath, 'root-marker', 'utf8');
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });

        recorder.record(eventEnvelope('sibling-run', 'sibling-event', 'sibling-marker'));
        recorder.record(eventEnvelope('..', 'dotdot-event', 'dotdot-marker'));
        recorder.record(eventEnvelope('.', 'dot-event', 'dot-marker'));

        assert((await eventsTextForRun(recorder, '..')).includes('dotdot-marker'));
        assert((await eventsTextForRun(recorder, '.')).includes('dot-marker'));

        recorder.deleteRun('..');
        recorder.deleteRun('.');

        // response() flushes the shared write queue before reading, so reading through it here
        // also waits for both queued deletes above to finish before the direct fs read below.
        const siblingEventsAfterDelete = await eventsTextForRun(recorder, 'sibling-run');

        expect(await readTextFileOrEmpty(snapshotPath)).toEqual('root-marker');
        assert(siblingEventsAfterDelete.includes('sibling-marker'));
        assert(!(await eventsTextForRun(recorder, '..')).includes('dotdot-marker'));
        assert(!(await eventsTextForRun(recorder, '.')).includes('dot-marker'));
    }
    finally {
        await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
    }
});

test('toRunDirectoryName resolves "A" and "a" to different directory names', () => {
    expect(toRunDirectoryName('A') === toRunDirectoryName('a')).toEqual(false);
    expect(toRunDirectoryName('Run')).toEqual('_0052un');
    expect(toRunDirectoryName('run')).toEqual('run');
});

test('toRunDirectoryName is injective and its output alphabet is [a-z0-9_-]', () => {
    const samples = [
        'run /1',
        '_25',
        '%',
        '/',
        '_2F',
        '.',
        '..',
        'A',
        'a',
        'Run',
        'run',
        '\uD800', // lone high surrogate
        '\uDC00', // lone low surrogate
        '😀' // surrogate pair (one emoji code point)
    ];
    const outputs = samples.map(toRunDirectoryName);

    for (const output of outputs) {
        assert(/^[a-z0-9_-]+$/.test(output));
    }
    expect(new Set(outputs).size).toEqual(outputs.length);

    expect(toRunDirectoryName('run /1')).toEqual('run_0020_002f1');
    expect(toRunDirectoryName('_25')).toEqual('_005f25');
    expect(toRunDirectoryName('..')).toEqual('_002e_002e');
});

function resultEnvelope(commandId: string, value: object): ControlClientEnvelope {
    return {
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'batched-run',
        agentId: 'agent-a',
        commandId,
        ok: true,
        result: {
            commandId,
            kind: 'health',
            status: 'ok',
            ok: true,
            value,
            startedAtEpochMs: 1,
            endedAtEpochMs: 2,
            durationMs: 1
        }
    };
}

interface FileWriteCounts {
    writes: number;
    directories: number;
}

/** Counts the recorder's file appends and directory creations: each is one disk operation the batching bounds. */
async function countFileWrites<T>(run: (counts: FileWriteCounts) => Promise<T>): Promise<T> {
    const counts: FileWriteCounts = { writes: 0, directories: 0 };
    onAppend = () => {
        counts.writes += 1;
    };
    onMkdir = () => {
        counts.directories += 1;
    };
    try {
        return await run(counts);
    }
    finally {
        onAppend = undefined;
        onMkdir = undefined;
    }
}

// Before batching, each result was serialized twice and cost two appends and a directory creation of its own.
test('1,000 recorded results are serialized once each and appended in one write per run file', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-batch-'));
    const timers = createManualTimers(0);
    let serializations = 0;
    try {
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers,
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        });
        const counts = await countFileWrites(async (counts) => {
            for (let index = 0; index < 1_000; index += 1) {
                recorder.record(resultEnvelope(`result-${index}`, {
                    probe: {
                        toJSON: () => {
                            serializations += 1;
                            return `probe-${index}`;
                        }
                    }
                }));
            }
            await timers.advanceTo(DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG.flushIntervalMs);
            await recorder.stop();
            return counts;
        });
        const runDirectory = `${storageDir}/runs/${toRunDirectoryName('batched-run')}`;
        const resultRows = (await readFile(`${runDirectory}/results.jsonl`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        const eventRows = (await readFile(`${runDirectory}/events.jsonl`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

        expect(serializations).toEqual(1_000);
        expect(counts).toEqual({ writes: 2, directories: 1 });
        expect(resultRows.length).toEqual(1_000);
        expect(resultRows[999].actual).toEqual({ probe: 'probe-999' });
        expect(eventRows.map((row) => row.kind)).toEqual(Array.from({ length: 1_000 }, () => 'step-result'));
        expect(eventRows[0].actual).toEqual({ probe: 'probe-0' });
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

function readJsonlRows(text: string): readonly RallarBlackBoxTestRecord[] {
    return text.trim().split('\n').filter((line) => line.length > 0).map((line) => decodeRecord(JSON.parse(line)));
}

function resultEnvelopeForRun(runId: string, commandId: string, marker: string): ControlClientEnvelope {
    return { ...resultEnvelope(commandId, { marker }), runId };
}

/** Holds every file append until `release` runs, as a disk that stops answering would. */
async function withStalledWrites<T>(run: (release: () => void, writesStarted: () => number) => Promise<T>): Promise<T> {
    let started = 0;
    let release = () => undefined as void;
    const released = new Promise<void>((resolve) => release = resolve);
    appendBlocker = {
        started: () => {
            started += 1;
        },
        released
    };
    try {
        return await run(release, () => started);
    }
    finally {
        release();
        appendBlocker = undefined;
    }
}

// Before rows stayed pending during a write, every tick queued its rows behind the stalled write and nothing was dropped.
test('while a write stalls, rows stay pending under the cap and the oldest of the recording run are dropped', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-stall-'));
    const timers = createManualTimers(0);
    const maxPendingBytes = 4_000;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers,
            config: { flushIntervalMs: 250, maxPendingBytes }
        });
        const { writesDuringStall, stalledRows } = await withStalledWrites(async (release, writesStarted) => {
            recorder.record(resultEnvelopeForRun('stalled-run', 'in-flight', 'in-flight'));
            const ticking = timers.advanceTo(250);
            await waitForFileWrite(writesStarted);
            const rows: string[] = [];
            // Each tick's rows fit under the cap; only rows held across ticks exceed it.
            for (let tick = 2; tick <= 9; tick += 1) {
                for (let index = 0; index < 5; index += 1) {
                    const marker = `stalled-${tick}-${index}`;
                    rows.push(marker);
                    recorder.record(resultEnvelopeForRun('stalled-run', marker, marker));
                }
                await timers.advanceTo(tick * 250);
            }
            const writes = writesStarted();
            release();
            await ticking;
            await recorder.stop();
            return { writesDuringStall: writes, stalledRows: rows };
        });
        const runDirectory = `${storageDir}/runs/${toRunDirectoryName('stalled-run')}`;
        const resultsText = await readFile(`${runDirectory}/results.jsonl`, 'utf8');
        const eventsText = await readFile(`${runDirectory}/events.jsonl`, 'utf8');
        const results = readJsonlRows(resultsText);
        const events = readJsonlRows(eventsText);
        const [inFlight, overflow, ...kept] = results;
        const keptBytes = [resultsText, eventsText]
            .flatMap((text) => text.split('\n').slice(2, -1))
            .reduce((total, line) => total + line.length + 1, 0);
        const overflowValue = overflow.value as Record<string, number>;

        expect(writesDuringStall).toEqual(1);
        expect(inFlight.commandId).toEqual('in-flight');
        expect(overflow.kind).toEqual('control-artifact-overflow');
        expect(events[1]).toEqual(overflow);
        assert(keptBytes <= maxPendingBytes);
        expect(overflowValue.omittedResults + kept.length).toEqual(stalledRows.length);
        expect(kept.map((row) => row.commandId)).toEqual(stalledRows.slice(overflowValue.omittedResults));
        expect(events.slice(2).map((row) => row.commandId)).toEqual(stalledRows.slice(overflowValue.omittedResults));
    }
    finally {
        console.warn = warn;
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('a run over the cap drops only its own rows; a quiet run keeps all of its rows', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-cap-'));
    const timers = createManualTimers(0);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers,
            config: { flushIntervalMs: 250, maxPendingBytes: 3_000 }
        });
        for (let index = 0; index < 5; index += 1) {
            recorder.record(eventEnvelope('quiet-run', `quiet-${index}`, `quiet-marker-${index}`));
        }
        for (let index = 0; index < 100; index += 1) {
            recorder.record(eventEnvelope('noisy-run', `event-${index}`, `marker-${index}`));
        }
        await timers.advanceTo(250);
        await recorder.stop();
        const quiet = readJsonlRows(await eventsTextForRun(recorder, 'quiet-run'));
        const [overflow, ...kept] = readJsonlRows(await eventsTextForRun(recorder, 'noisy-run'));
        const overflowValue = overflow.value as Record<string, number>;

        expect(quiet.map((row) => row.value)).toEqual([0, 1, 2, 3, 4].map((index) => `quiet-marker-${index}`));
        expect([overflow.kind, overflow.agentId, overflow.atEpochMs]).toEqual(['control-artifact-overflow', 'control-server', 250]);
        expect(overflowValue.omittedEventRows + kept.length).toEqual(100);
        expect(overflowValue.omittedResults).toEqual(0);
        expect(kept.at(-1)?.value).toEqual('marker-99');
        expect(kept[0].name).toEqual(`event-${overflowValue.omittedEventRows}`);
        expect(warnings.length).toEqual(1);
        assert(warnings[0].includes(`dropped ${overflowValue.omittedEventRows} pending rows`));
    }
    finally {
        console.warn = warn;
        await rm(storageDir, { recursive: true, force: true });
    }
});

async function waitForFileWrite(writesStarted: () => number): Promise<void> {
    for (let turn = 0; writesStarted() === 0 && turn < 1_000; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert(writesStarted() > 0);
}

test('a stalled artifact write leaves no periodic retry timers while rows stay pending', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-idle-timers-'));
    const timers = createManualTimers(0);
    const recorder = new ControlArtifactRecorder({
        storageDir,
        commandSnapshots: NO_COMMAND_SNAPSHOTS,
        timers,
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
    });
    try {
        await withStalledWrites(async (release, writesStarted) => {
            const first = recorder.record(eventEnvelope('timer-run', 'first', 'first-marker'));
            const ticking = timers.advanceTo(250);
            await waitForFileWrite(writesStarted);
            try {
                const pending = recorder.record(eventEnvelope('timer-run', 'pending', 'pending-marker'));
                await timers.advanceTo(1_250);
                expect(timers.pendingCount()).toEqual(0);
                release();
                await recorder.stop();
                await Promise.all([first, pending]);
            }
            finally {
                release();
                await ticking;
                await recorder.stop();
            }
        });
        const text = await readFile(`${storageDir}/runs/timer-run/events.jsonl`, 'utf8');
        expect(readJsonlRows(text).map((row) => row.value)).toEqual(['first-marker', 'pending-marker']);
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('a read barrier drains arriving rows without residual timers and allows later recording', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-drain-'));
    const timers = createManualTimers(0);
    const recorder = new ControlArtifactRecorder({
        storageDir,
        commandSnapshots: NO_COMMAND_SNAPSHOTS,
        timers,
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
    });
    try {
        await withStalledWrites(async (release, writesStarted) => {
            const first = recorder.record(eventEnvelope('barrier-run', 'first', 'first-marker'));
            const reading = eventsTextForRun(recorder, 'barrier-run');
            await waitForFileWrite(writesStarted);
            const arriving = recorder.record(eventEnvelope('barrier-run', 'arriving', 'arriving-marker'));
            release();
            const text = await reading;
            expect(readJsonlRows(text).map((row) => row.value)).toEqual(['first-marker', 'arriving-marker']);
            await Promise.all([first, arriving]);
            expect(timers.pendingCount()).toEqual(0);
        });
        const later = recorder.record(eventEnvelope('barrier-run', 'later', 'later-marker'));
        await timers.advanceTo(249);
        expect(readJsonlRows(await readFile(`${storageDir}/runs/barrier-run/events.jsonl`, 'utf8')).length).toEqual(2);
        await timers.advanceTo(250);
        await later;
        expect(readJsonlRows(await readFile(`${storageDir}/runs/barrier-run/events.jsonl`, 'utf8')).map((row) => row.value)).toEqual([
            'first-marker',
            'arriving-marker',
            'later-marker'
        ]);
        expect(timers.pendingCount()).toEqual(0);
    }
    finally {
        await recorder.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('deleting in-flight and pending runs preserves file order and another run capture', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-ordered-delete-'));
    const timers = createManualTimers(0);
    const recorder = new ControlArtifactRecorder({
        storageDir,
        commandSnapshots: NO_COMMAND_SNAPSHOTS,
        timers,
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
    });
    try {
        await withStalledWrites(async (release, writesStarted) => {
            const first = recorder.record(eventEnvelope('deleted-flight', 'first', 'deleted-flight-marker'));
            const ticking = timers.advanceTo(250);
            await waitForFileWrite(writesStarted);
            const deleted = recorder.record(eventEnvelope('deleted-pending', 'pending', 'deleted-pending-marker'));
            const kept = recorder.record(eventEnvelope('kept-run', 'kept', 'kept-marker'));
            recorder.deleteRun('deleted-flight');
            recorder.deleteRun('deleted-pending');
            release();
            await ticking;
            await recorder.stop();
            await first;
            expect((await deleted).left).toEqual('The run was deleted before durable capture completed.');
            expect((await kept).right).toEqual([]);
        });
        expect(await readTextFileOrEmpty(`${storageDir}/runs/deleted-flight/events.jsonl`)).toEqual('');
        expect(await readTextFileOrEmpty(`${storageDir}/runs/deleted-pending/events.jsonl`)).toEqual('');
        expect(readJsonlRows(await readFile(`${storageDir}/runs/kept-run/events.jsonl`, 'utf8')).map((row) => row.value)).toEqual(['kept-marker']);
        expect(timers.pendingCount()).toEqual(0);
    }
    finally {
        await recorder.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

async function withStalledRemoval<T>(
    path: string,
    run: (entered: Promise<void>, release: () => void) => Promise<T>
): Promise<T> {
    let announce = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => announce = resolve);
    const released = new Promise<void>((resolve) => release = resolve);
    rmStalls.set(path, { announce, released });
    try {
        return await run(entered, release);
    }
    finally {
        release();
        rmStalls.delete(path);
    }
}

test('a barrier includes recording that arrives while its queued deletion is stalled', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-delete-barrier-'));
    const timers = createManualTimers(0);
    const recorder = new ControlArtifactRecorder({
        storageDir,
        commandSnapshots: NO_COMMAND_SNAPSHOTS,
        timers,
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
    });
    try {
        void recorder.record(eventEnvelope('deleted-run', 'old', 'old-marker'));
        await recorder.stop();
        await withStalledRemoval(`${storageDir}/runs/deleted-run`, async (entered, release) => {
            recorder.deleteRun('deleted-run');
            const stopping = recorder.stop();
            await entered;
            let captured = false;
            const capture = recorder.record(eventEnvelope('kept-run', 'arriving', 'arriving-marker'))
                .then((outcome) => {
                    captured = true;
                    return outcome;
                });
            release();
            await stopping;
            assert(captured);
            expect(timers.pendingCount()).toEqual(0);
            expect((await capture).right).toEqual([]);
            expect(readJsonlRows(await readFile(`${storageDir}/runs/kept-run/events.jsonl`, 'utf8')).map((row) => row.value)).toEqual(['arriving-marker']);
            expect(await readTextFileOrEmpty(`${storageDir}/runs/deleted-run/events.jsonl`)).toEqual('');
        });
    }
    finally {
        await recorder.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('a barrier follows continued arrivals and appended deletions until the file boundary is idle', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-artifact-recorder-delete-followup-'));
    const timers = createManualTimers(0);
    const recorder = new ControlArtifactRecorder({
        storageDir,
        commandSnapshots: NO_COMMAND_SNAPSHOTS,
        timers,
        config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
    });
    try {
        void recorder.record(eventEnvelope('deleted-first', 'old-first', 'old-first-marker'));
        void recorder.record(eventEnvelope('deleted-second', 'old-second', 'old-second-marker'));
        await recorder.stop();
        await withStalledRemoval(`${storageDir}/runs/deleted-first`, async (firstEntered, releaseFirst) => {
            await withStalledRemoval(`${storageDir}/runs/deleted-second`, async (secondEntered, releaseSecond) => {
                recorder.deleteRun('deleted-first');
                let stopped = false;
                const stopping = recorder.stop().then(() => stopped = true);
                await firstEntered;
                const first = recorder.record(eventEnvelope('kept-run', 'first', 'first-marker'));
                recorder.deleteRun('deleted-second');
                releaseFirst();
                await secondEntered;
                for (let turn = 0; turn < 10; turn += 1) {
                    await Promise.resolve();
                }
                expect(stopped).toEqual(false);
                const second = recorder.record(eventEnvelope('kept-run', 'second', 'second-marker'));
                const deleted = recorder.record(eventEnvelope('deleted-pending', 'pending', 'pending-marker'));
                recorder.deleteRun('deleted-pending');
                releaseSecond();
                await stopping;
                expect(timers.pendingCount()).toEqual(0);
                expect((await first).right).toEqual([]);
                expect((await second).right).toEqual([]);
                expect((await deleted).left).toEqual('The run was deleted before durable capture completed.');
            });
        });
        expect(readJsonlRows(await readFile(`${storageDir}/runs/kept-run/events.jsonl`, 'utf8')).map((row) => row.value)).toEqual([
            'first-marker',
            'second-marker'
        ]);
        for (const runId of ['deleted-first', 'deleted-second', 'deleted-pending']) {
            expect(await readTextFileOrEmpty(`${storageDir}/runs/${runId}/events.jsonl`)).toEqual('');
        }
    }
    finally {
        await recorder.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});
