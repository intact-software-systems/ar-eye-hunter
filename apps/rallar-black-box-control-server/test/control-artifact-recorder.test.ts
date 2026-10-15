import { assert, assertEquals } from '@std/assert';

import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    ControlArtifactRecorder,
    DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG,
    toRunDirectoryName
} from '../src/control-artifact-recorder.ts';
import { createDefaultControlTimers } from '../src/control-timers.ts';
import { createManualControlTimers } from './support/manual-control-timers.ts';

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
            timers: createDefaultControlTimers(),
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
            timers: createDefaultControlTimers(),
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
            timers: createDefaultControlTimers(),
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
            timers: createDefaultControlTimers(),
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
    const timers = createManualControlTimers(0);
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

Deno.test('pending rows beyond the byte cap drop the oldest and record the gap before the rows that remain', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-artifact-recorder-cap-' });
    const timers = createManualControlTimers(0);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
        const recorder = new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers,
            config: { flushIntervalMs: 250, maxPendingBytes: 2_000 }
        });
        for (let index = 0; index < 100; index += 1) {
            recorder.record(eventEnvelope('capped-run', `event-${index}`, `marker-${index}`));
        }
        await timers.advanceTo(250);
        await recorder.stop();
        const rows = (await eventsTextForRun(recorder, 'capped-run')).trim().split('\n').map((line) => JSON.parse(line));
        const [gap, ...kept] = rows;

        assertEquals(gap.kind, 'artifact-truncated');
        assertEquals(gap.omittedRows + kept.length, 100, 'every row is either written or counted in the gap');
        assert(kept.reduce((total, row) => total + JSON.stringify(row).length + 1, 0) <= 2_000, 'the rows kept fit the cap');
        assertEquals(kept.at(-1).value, 'marker-99', 'the newest rows are kept');
        assertEquals(kept[0].name, `event-${gap.omittedRows}`, 'the oldest rows are dropped');
        assertEquals(warnings.length, 1);
        assert(warnings[0].includes(`dropped ${gap.omittedRows} pending rows`), warnings[0]);
    }
    finally {
        console.warn = warn;
        await Deno.remove(storageDir, { recursive: true });
    }
});
