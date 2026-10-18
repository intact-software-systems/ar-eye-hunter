import { assert, assertEquals } from '@std/assert';

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
        return await Deno.readTextFile(path);
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return '';
        }
        throw error;
    }
}

Deno.test('artifact recorder keeps "%" and "_25" run ids on separate disk paths', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-percent-' });
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
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('artifact recorder keeps "/" and "_2F" run ids on separate disk paths', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-slash-' });
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
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('deleting one colliding run id leaves the other run\'s stored marker intact', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-delete-' });
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
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('recording and deleting "." and ".." run ids stays inside their own runs/ directory', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-dots-' });
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    try {
        await Deno.writeTextFile(snapshotPath, 'root-marker');
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

        assertEquals(await readTextFileOrEmpty(snapshotPath), 'root-marker');
        assert(siblingEventsAfterDelete.includes('sibling-marker'));
        assert(!(await eventsTextForRun(recorder, '..')).includes('dotdot-marker'));
        assert(!(await eventsTextForRun(recorder, '.')).includes('dot-marker'));
    }
    finally {
        await Deno.remove(storageDir, { recursive: true }).catch(() => undefined);
    }
});

Deno.test('toRunDirectoryName resolves "A" and "a" to different directory names', () => {
    assertEquals(toRunDirectoryName('A') === toRunDirectoryName('a'), false);
    assertEquals(toRunDirectoryName('Run'), '_0052un');
    assertEquals(toRunDirectoryName('run'), 'run');
});

Deno.test('toRunDirectoryName is injective and its output alphabet is [a-z0-9_-]', () => {
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
        assert(/^[a-z0-9_-]+$/.test(output), `output alphabet must be [a-z0-9_-], got: ${output}`);
    }
    assertEquals(new Set(outputs).size, outputs.length);

    assertEquals(toRunDirectoryName('run /1'), 'run_0020_002f1');
    assertEquals(toRunDirectoryName('_25'), '_005f25');
    assertEquals(toRunDirectoryName('..'), '_002e_002e');
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
    const writeTextFile = Deno.writeTextFile;
    const mkdir = Deno.mkdir;
    const counts: FileWriteCounts = { writes: 0, directories: 0 };
    Deno.writeTextFile = (...args: Parameters<typeof writeTextFile>) => {
        counts.writes += 1;
        return writeTextFile(...args);
    };
    Deno.mkdir = (...args: Parameters<typeof mkdir>) => {
        counts.directories += 1;
        return mkdir(...args);
    };
    try {
        return await run(counts);
    }
    finally {
        Deno.writeTextFile = writeTextFile;
        Deno.mkdir = mkdir;
    }
}

// Before batching, each result was serialized twice and cost two appends and a directory creation of its own.
Deno.test('1,000 recorded results are serialized once each and appended in one write per run file', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-batch-' });
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
        const resultRows = (await Deno.readTextFile(`${runDirectory}/results.jsonl`)).trim().split('\n').map((line) => JSON.parse(line));
        const eventRows = (await Deno.readTextFile(`${runDirectory}/events.jsonl`)).trim().split('\n').map((line) => JSON.parse(line));

        assertEquals(serializations, 1_000, 'each received result is serialized once for both rows');
        assertEquals(counts, { writes: 2, directories: 1 });
        assertEquals(resultRows.length, 1_000);
        assertEquals(resultRows[999].actual, { probe: 'probe-999' });
        assertEquals(eventRows.map((row) => row.kind), Array.from({ length: 1_000 }, () => 'step-result'));
        assertEquals(eventRows[0].actual, { probe: 'probe-0' });
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
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
    const writeTextFile = Deno.writeTextFile;
    let started = 0;
    let release = () => undefined as void;
    const released = new Promise<void>((resolve) => release = resolve);
    Deno.writeTextFile = async (...args: Parameters<typeof writeTextFile>) => {
        started += 1;
        await released;
        return writeTextFile(...args);
    };
    try {
        return await run(release, () => started);
    }
    finally {
        release();
        Deno.writeTextFile = writeTextFile;
    }
}

// Before rows stayed pending during a write, every tick queued its rows behind the stalled write and nothing was dropped.
Deno.test('while a write stalls, rows stay pending under the cap and the oldest of the recording run are dropped', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-stall-' });
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
        const resultsText = await Deno.readTextFile(`${runDirectory}/results.jsonl`);
        const eventsText = await Deno.readTextFile(`${runDirectory}/events.jsonl`);
        const results = readJsonlRows(resultsText);
        const events = readJsonlRows(eventsText);
        const [inFlight, overflow, ...kept] = results;
        const keptBytes = [resultsText, eventsText]
            .flatMap((text) => text.split('\n').slice(2, -1))
            .reduce((total, line) => total + line.length + 1, 0);
        const overflowValue = overflow.value as Record<string, number>;

        assertEquals(writesDuringStall, 1, 'one batch is in flight and no later batch queues behind it');
        assertEquals(inFlight.commandId, 'in-flight');
        assertEquals(overflow.kind, 'control-artifact-overflow');
        assertEquals(events[1], overflow, 'the same overflow row heads both files');
        assert(keptBytes <= maxPendingBytes, `${keptBytes} pending bytes outlived the stall`);
        assertEquals(overflowValue.omittedResults + kept.length, stalledRows.length);
        assertEquals(kept.map((row) => row.commandId), stalledRows.slice(overflowValue.omittedResults), 'the oldest rows are dropped');
        assertEquals(
            events.slice(2).map((row) => row.commandId),
            stalledRows.slice(overflowValue.omittedResults),
            'each kept result keeps its step-result row'
        );
    }
    finally {
        console.warn = warn;
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('a run over the cap drops only its own rows; a quiet run keeps all of its rows', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-cap-' });
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

        assertEquals(quiet.map((row) => row.value), [0, 1, 2, 3, 4].map((index) => `quiet-marker-${index}`));
        assertEquals([overflow.kind, overflow.agentId, overflow.atEpochMs], ['control-artifact-overflow', 'control-server', 250]);
        assertEquals(overflowValue.omittedEventRows + kept.length, 100, 'every row is either written or counted');
        assertEquals(overflowValue.omittedResults, 0);
        assertEquals(kept.at(-1)?.value, 'marker-99', 'the newest rows are kept');
        assertEquals(kept[0].name, `event-${overflowValue.omittedEventRows}`, 'the oldest rows are dropped');
        assertEquals(warnings.length, 1);
        assert(warnings[0].includes(`dropped ${overflowValue.omittedEventRows} pending rows`), warnings[0]);
    }
    finally {
        console.warn = warn;
        await Deno.remove(storageDir, { recursive: true });
    }
});

async function waitForFileWrite(writesStarted: () => number): Promise<void> {
    for (let turn = 0; writesStarted() === 0 && turn < 1_000; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert(writesStarted() > 0, 'the scheduled artifact write must reach the disk port');
}

Deno.test('a stalled artifact write leaves no periodic retry timers while rows stay pending', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-idle-timers-' });
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
                assertEquals(timers.pendingCount(), 0, 'a stalled write cannot make progress on a retry tick');
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
        const text = await Deno.readTextFile(`${storageDir}/runs/timer-run/events.jsonl`);
        assertEquals(readJsonlRows(text).map((row) => row.value), ['first-marker', 'pending-marker']);
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('a read barrier drains arriving rows without residual timers and allows later recording', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-drain-' });
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
            assertEquals(readJsonlRows(text).map((row) => row.value), ['first-marker', 'arriving-marker']);
            await Promise.all([first, arriving]);
            assertEquals(timers.pendingCount(), 0, 'the barrier must leave no wakeup for already drained rows');
        });
        const later = recorder.record(eventEnvelope('barrier-run', 'later', 'later-marker'));
        await timers.advanceTo(249);
        assertEquals(readJsonlRows(await Deno.readTextFile(`${storageDir}/runs/barrier-run/events.jsonl`)).length, 2);
        await timers.advanceTo(250);
        await later;
        assertEquals(
            readJsonlRows(await Deno.readTextFile(`${storageDir}/runs/barrier-run/events.jsonl`)).map((row) => row.value),
            ['first-marker', 'arriving-marker', 'later-marker']
        );
        assertEquals(timers.pendingCount(), 0);
    }
    finally {
        await recorder.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('deleting in-flight and pending runs preserves file order and another run capture', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-ordered-delete-' });
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
            assertEquals((await deleted).left, 'The run was deleted before durable capture completed.');
            assertEquals((await kept).right, []);
        });
        assertEquals(await readTextFileOrEmpty(`${storageDir}/runs/deleted-flight/events.jsonl`), '');
        assertEquals(await readTextFileOrEmpty(`${storageDir}/runs/deleted-pending/events.jsonl`), '');
        assertEquals(
            readJsonlRows(await Deno.readTextFile(`${storageDir}/runs/kept-run/events.jsonl`)).map((row) => row.value),
            ['kept-marker']
        );
        assertEquals(timers.pendingCount(), 0);
    }
    finally {
        await recorder.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});

async function withStalledRemoval<T>(
    path: string,
    run: (entered: Promise<void>, release: () => void) => Promise<T>
): Promise<T> {
    const remove = Deno.remove;
    let announce = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => announce = resolve);
    const released = new Promise<void>((resolve) => release = resolve);
    Deno.remove = async (...args: Parameters<typeof remove>) => {
        if (args[0] === path) {
            announce();
            await released;
        }
        return remove(...args);
    };
    try {
        return await run(entered, release);
    }
    finally {
        release();
        Deno.remove = remove;
    }
}

Deno.test('a barrier includes recording that arrives while its queued deletion is stalled', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-delete-barrier-' });
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
            assert(captured, 'the barrier must settle capture that arrived during deletion');
            assertEquals(timers.pendingCount(), 0);
            assertEquals((await capture).right, []);
            assertEquals(
                readJsonlRows(await Deno.readTextFile(`${storageDir}/runs/kept-run/events.jsonl`)).map((row) => row.value),
                ['arriving-marker']
            );
            assertEquals(await readTextFileOrEmpty(`${storageDir}/runs/deleted-run/events.jsonl`), '');
        });
    }
    finally {
        await recorder.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('a barrier follows continued arrivals and appended deletions until the file boundary is idle', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-delete-followup-' });
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
                assertEquals(stopped, false, 'the appended deletion is still part of the read barrier');
                const second = recorder.record(eventEnvelope('kept-run', 'second', 'second-marker'));
                const deleted = recorder.record(eventEnvelope('deleted-pending', 'pending', 'pending-marker'));
                recorder.deleteRun('deleted-pending');
                releaseSecond();
                await stopping;
                assertEquals(timers.pendingCount(), 0);
                assertEquals((await first).right, []);
                assertEquals((await second).right, []);
                assertEquals((await deleted).left, 'The run was deleted before durable capture completed.');
            });
        });
        assertEquals(
            readJsonlRows(await Deno.readTextFile(`${storageDir}/runs/kept-run/events.jsonl`)).map((row) => row.value),
            ['first-marker', 'second-marker']
        );
        for (const runId of ['deleted-first', 'deleted-second', 'deleted-pending']) {
            assertEquals(await readTextFileOrEmpty(`${storageDir}/runs/${runId}/events.jsonl`), '');
        }
    }
    finally {
        await recorder.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});
