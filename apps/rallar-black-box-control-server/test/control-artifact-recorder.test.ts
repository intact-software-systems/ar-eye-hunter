import { assert, assertEquals } from '@std/assert';

import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { createControlArtifactRecorder, toRunDirectoryName } from '../src/control-artifact-recorder.ts';

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
    recorder: ReturnType<typeof createControlArtifactRecorder>,
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
        const recorder = createControlArtifactRecorder({ storageDir });
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
        const recorder = createControlArtifactRecorder({ storageDir });
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
        const recorder = createControlArtifactRecorder({ storageDir });
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
        const recorder = createControlArtifactRecorder({ storageDir });

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
