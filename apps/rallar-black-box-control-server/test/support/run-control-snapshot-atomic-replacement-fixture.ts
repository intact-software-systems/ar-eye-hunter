import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createControlSnapshotPersistence } from '../../src/control-snapshot-persistence.ts';
import type { ControlSnapshotPersistence } from '../../src/control-snapshot-persistence.ts';

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
    const persistence = createControlSnapshotPersistence({
        storageDir: directory,
        retentionMaxRuns: 50,
        snapshotBounds: {},
        controlService: {
            applyRunRetention: () => [],
            snapshotForPersistence: () => replacementSnapshot,
            restoreSnapshot: (value: ControlServerSnapshot) => {
                restoredSnapshot = value;
            }
        },
        deleteRuns: () => undefined
    });
    const log = console.log;
    console.log = () => undefined;
    try {
        const evidence = await writeAtomicSnapshotReplacementEvidence(directory, persistence);
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
    }
}

async function writeAtomicSnapshotReplacementEvidence(
    directory: string,
    persistence: ControlSnapshotPersistence
): Promise<AtomicSnapshotFileEvidence> {
    const finalPath = directory + '/control-snapshot.json';
    const priorText = JSON.stringify({
        schemaVersion: 1,
        savedAtEpochMs: 1,
        snapshot: { runs: [], distributedRuns: [], fleetReports: [] }
    });
    const rename = Deno.rename;
    const warn = console.warn;
    let rejectRename = true;
    let failedWarning = '';
    let attemptedText = '';
    Deno.rename = async (source, destination) => {
        if (rejectRename) {
            attemptedText = await Deno.readTextFile(source);
            throw new Error('controlled snapshot rename refusal');
        }
        return rename(source, destination);
    };
    console.warn = (message: string) => {
        failedWarning = message;
    };
    try {
        await Deno.writeTextFile(finalPath, priorText);
        persistence.persist();
        await waitFor(async () => failedWarning.length > 0);
        const afterFailureText = await Deno.readTextFile(finalPath);
        await waitFor(async () => (await readFileNames(directory)).length === 2);
        rejectRename = false;
        persistence.persist();
        await waitFor(async () => (await Deno.readTextFile(finalPath)) !== priorText);
        const replacementText = await Deno.readTextFile(finalPath);
        await persistence.restore();
        return {
            priorText,
            afterFailureText,
            attemptedText,
            replacementText,
            remainingFiles: await readFileNames(directory),
            failedWarning
        };
    }
    finally {
        Deno.rename = rename;
        console.warn = warn;
    }
}

async function readFileNames(directory: string): Promise<string[]> {
    const names: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
        names.push(entry.name);
    }
    return names.sort();
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
