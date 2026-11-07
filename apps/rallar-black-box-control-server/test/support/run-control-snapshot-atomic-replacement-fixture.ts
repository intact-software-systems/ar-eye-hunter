import { readdir, readFile, rename, writeFile } from 'node:fs/promises';

import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { ControlSnapshotPersistence } from '../../src/control-snapshot-persistence.ts';

interface AtomicSnapshotFileEvidence {
    readonly priorText: string;
    readonly afterFailureText: string;
    readonly attemptedText: string;
    readonly replacementText: string;
    readonly remainingFiles: readonly string[];
    readonly failedWarning: string;
}

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

export async function runControlSnapshotAtomicReplacementFixture(directory: string): Promise<void> {
    let restoredSnapshot: ControlServerSnapshot | undefined;
    let rejectRename = true;
    let attemptedText = '';
    let failedWarning = '';
    const renameFile = async (source: string, destination: string): Promise<void> => {
        if (rejectRename) {
            attemptedText = await readFile(source, 'utf8');
            throw new Error('controlled snapshot rename refusal');
        }
        await rename(source, destination);
    };
    const persistence = new ControlSnapshotPersistence({
        storageDir: directory,
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
        timingSink: undefined,
        renameFile
    });
    const log = console.log;
    const warn = console.warn;
    console.log = () => undefined;
    console.warn = (message: string) => {
        failedWarning = message;
    };
    try {
        const evidence = await writeAtomicSnapshotReplacementEvidence(directory, persistence, {
            setRejectRename: (value) => {
                rejectRename = value;
            },
            readAttemptedText: () => attemptedText,
            readFailedWarning: () => failedWarning
        });
        const attempted: unknown = JSON.parse(evidence.attemptedText);
        const replacement: unknown = JSON.parse(evidence.replacementText);
        if (!isJsonRecordValue(attempted) || !isJsonRecordValue(replacement)) {
            throw new Error('Persistence must emit snapshot envelopes.');
        }
        log(JSON.stringify({
            priorText: evidence.priorText,
            afterFailureText: evidence.afterFailureText,
            attemptedSnapshot: attempted.snapshot,
            replacementSnapshot: replacement.snapshot,
            restoredSnapshot,
            remainingFiles: evidence.remainingFiles,
            failedWarning: evidence.failedWarning
        }));
    }
    finally {
        console.log = log;
        console.warn = warn;
    }
}

interface RenameFailureControls {
    readonly setRejectRename: (value: boolean) => void;
    readonly readAttemptedText: () => string;
    readonly readFailedWarning: () => string;
}

async function writeAtomicSnapshotReplacementEvidence(
    directory: string,
    persistence: ControlSnapshotPersistence,
    controls: RenameFailureControls
): Promise<AtomicSnapshotFileEvidence> {
    const finalPath = directory + '/control-snapshot.json';
    const priorText = JSON.stringify({
        schemaVersion: 1,
        savedAtEpochMs: 1,
        snapshot: { runs: [], distributedRuns: [], fleetReports: [] }
    });
    await writeFile(finalPath, priorText, 'utf8');
    persistence.persist();
    await waitFor(async () => controls.readFailedWarning().length > 0);
    const afterFailureText = await readFile(finalPath, 'utf8');
    await waitFor(async () => (await readFileNames(directory)).length === 2);
    controls.setRejectRename(false);
    persistence.persist();
    await waitFor(async () => (await readFile(finalPath, 'utf8')) !== priorText);
    const replacementText = await readFile(finalPath, 'utf8');
    await persistence.restore();
    return {
        priorText,
        afterFailureText,
        attemptedText: controls.readAttemptedText(),
        replacementText,
        remainingFiles: await readFileNames(directory),
        failedWarning: controls.readFailedWarning()
    };
}

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
