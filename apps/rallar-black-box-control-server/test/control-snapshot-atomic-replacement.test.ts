import { expect, mock, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as realFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { ControlSnapshotPersistence } from '../src/control-snapshot-persistence.ts';

const replacementSnapshot: ControlServerSnapshot = {
    runs: [{
        runId: 'replacement-run',
        createdAtEpochMs: 10,
        updatedAtEpochMs: 20,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    }],
    distributedRuns: [],
    fleetReports: []
};

// Captured before `mock.module` installs the fake, so the mock can delegate to the real rename.
const realRename = realFsPromises.rename;
const realReadFile = realFsPromises.readFile;

// One installed mock serves the whole file; the shared state below switches its behaviour. It delegates to the real
// rename unless the test rejects it, so the mock is transparent to every other file sharing the module.
let rejectRename = false;
let attemptedText = '';

mock.module('node:fs/promises', () => ({
    ...realFsPromises,
    rename: async (source: string | URL, destination: string | URL): Promise<void> => {
        if (rejectRename) {
            attemptedText = await realReadFile(String(source), 'utf8');
            throw new Error('controlled snapshot rename refusal');
        }
        await realRename(source, destination);
    }
}));

test('a failed snapshot rename preserves the prior file and a retry replaces it atomically', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-snapshot-atomic-'));
    const log = console.log;
    const warn = console.warn;
    const warnings: string[] = [];
    console.log = () => undefined;
    console.warn = (message: string) => warnings.push(message);
    try {
        rejectRename = true;
        attemptedText = '';
        let restoredSnapshot: ControlServerSnapshot | undefined;
        const persistence = new ControlSnapshotPersistence({
            storageDir,
            retentionMaxRuns: 50,
            snapshotBounds: {},
            flushIntervalMs: 0,
            controlService: {
                applyCompletedRunRetention: () => [],
                snapshotLifecycleRevision: () => '',
                snapshotRevision: () => ({ content: 'replacement', lifecycle: '' }),
                snapshotForPersistence: () => replacementSnapshot,
                restoreSnapshot: (value: ControlServerSnapshot) => {
                    restoredSnapshot = value;
                }
            },
            deleteRuns: () => undefined,
            timers: createDefaultTimers(),
            timingSink: undefined
        });

        const finalPath = `${storageDir}/control-snapshot.json`;
        const priorText = JSON.stringify({
            schemaVersion: 1,
            savedAtEpochMs: 1,
            snapshot: { runs: [], distributedRuns: [], fleetReports: [] }
        });
        await writeFile(finalPath, priorText, 'utf8');
        persistence.persist();
        await waitFor(async () => warnings.length > 0);
        const afterFailureText = await readFile(finalPath, 'utf8');
        await waitFor(async () => (await readFileNames(storageDir)).length === 1);
        rejectRename = false;
        persistence.persist();
        await waitFor(async () => (await readFile(finalPath, 'utf8')) !== priorText);
        const replacementText = await readFile(finalPath, 'utf8');
        await persistence.restore();

        const attempted: unknown = JSON.parse(attemptedText);
        const replacement: unknown = JSON.parse(replacementText);
        if (!isJsonRecordValue(attempted) || !isJsonRecordValue(replacement)) {
            throw new Error('Persistence must emit snapshot envelopes.');
        }

        expect(afterFailureText).toEqual(priorText);
        expect(attempted.snapshot).toEqual(replacementSnapshot);
        expect(replacement.snapshot).toEqual(replacementSnapshot);
        expect(restoredSnapshot).toEqual(replacementSnapshot);
        expect(await readFileNames(storageDir)).toEqual(['control-snapshot.json']);
        expect(warnings.some((message) => message.includes('controlled snapshot rename refusal'))).toEqual(true);
    }
    finally {
        rejectRename = false;
        console.log = log;
        console.warn = warn;
        await rm(storageDir, { recursive: true, force: true });
    }
});

async function readFileNames(directory: string): Promise<string[]> {
    return (await readdir(directory)).sort();
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Native snapshot effect did not settle within the 1s observation budget.');
}
