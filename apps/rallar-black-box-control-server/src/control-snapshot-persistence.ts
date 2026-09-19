import type { ControlRunSnapshotBounds, ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeArrayItems } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/artifact-json-value-guards.ts';
import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { validateControlFleetRunReportCollection } from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxControlService } from './control-service.ts';

export interface ControlSnapshotPersistence {
    restore(): Promise<void>;
    persist(): void;
}

export interface CreateControlSnapshotPersistenceInput {
    readonly storageDir: string | undefined;
    readonly retentionMaxRuns: number;
    readonly snapshotBounds: ControlRunSnapshotBounds;
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        'applyRunRetention' | 'restoreSnapshot' | 'snapshotForPersistence'
    >;
    readonly deleteRuns: (runIds: readonly string[]) => void;
}

const SNAPSHOT_PERSIST_DEBOUNCE_MS = 100;
const SNAPSHOT_FILE_SCHEMA_VERSION = 1;

export function createControlSnapshotPersistence(
    input: CreateControlSnapshotPersistenceInput
): ControlSnapshotPersistence {
    const path = input.storageDir ? toSnapshotPath(input.storageDir) : undefined;
    let sequence = 0;
    let scheduled = false;
    let persisting = false;
    let dirty = false;

    async function flush(): Promise<void> {
        scheduled = false;
        if (!dirty || persisting || !path || !input.storageDir) {
            return;
        }
        dirty = false;
        persisting = true;
        try {
            const tempPath = `${path}.tmp-${Deno.pid}-${Date.now()}-${sequence += 1}`;
            const snapshot = input.controlService.snapshotForPersistence(input.snapshotBounds);
            await writeSnapshotFile(input.storageDir, tempPath, toSnapshotFileText(snapshot));
        }
        finally {
            persisting = false;
            if (dirty) {
                schedulePersistence();
            }
        }
    }

    function schedulePersistence(): void {
        applyAutomaticRetention(input);
        if (!path) {
            return;
        }
        dirty = true;
        if (!scheduled && !persisting) {
            scheduled = true;
            setTimeout(() => void flush(), SNAPSHOT_PERSIST_DEBOUNCE_MS);
        }
    }

    return {
        restore: () => path ? restoreSnapshotFile(path, input.controlService) : Promise.resolve(),
        persist: schedulePersistence
    };
}

function applyAutomaticRetention(input: CreateControlSnapshotPersistenceInput): void {
    const deletedRunIds = input.controlService.applyRunRetention(input.retentionMaxRuns);
    if (deletedRunIds.length > 0) {
        input.deleteRuns(deletedRunIds);
    }
}

function toSnapshotPath(storageDir: string): string {
    return `${storageDir.replace(/\/+$/, '')}/control-snapshot.json`;
}

function toSnapshotFileText(snapshot: ControlServerSnapshot): string {
    return JSON.stringify(
        {
            schemaVersion: SNAPSHOT_FILE_SCHEMA_VERSION,
            savedAtEpochMs: Date.now(),
            snapshot
        },
        null,
        2
    );
}

async function writeSnapshotFile(storageDir: string, tempPath: string, payload: string): Promise<void> {
    const path = toSnapshotPath(storageDir);
    try {
        await Deno.mkdir(storageDir, { recursive: true });
        await Deno.writeTextFile(tempPath, payload);
        await Deno.rename(tempPath, path);
    }
    catch (error) {
        Deno.remove(tempPath).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not persist control snapshot to ${path}: ${message}`);
    }
}

async function restoreSnapshotFile(
    path: string,
    controlService: CreateControlSnapshotPersistenceInput['controlService']
): Promise<void> {
    try {
        decodeSnapshotFile(JSON.parse(await Deno.readTextFile(path))).fold(
            (issue) => console.warn(`Could not restore control snapshot from ${path}: ${issue}`),
            (snapshot) => {
                controlService.restoreSnapshot(snapshot);
                console.log(`Restored Rallar black-box control snapshot from ${path}`);
            }
        );
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not restore control snapshot from ${path}: ${message}`);
    }
}

/** A snapshot written before one of its fields became required does not decode and is not loaded. */
function decodeSnapshotFile(value: unknown): Either<string, ControlServerSnapshot> {
    if (!isJsonRecordValue(value) || !isJsonRecordValue(value.snapshot)) {
        return Either.ofLeft('the file holds no control snapshot object');
    }
    const { runs, distributedRuns, fleetReports } = value.snapshot;
    if (!Array.isArray(fleetReports)) {
        return Either.ofLeft('fleetReports must be an array');
    }
    const fleet = validateControlFleetRunReportCollection(fleetReports);
    const fleetIssue = fleet.issues[0];
    if (!fleet.ok) {
        return Either.ofLeft(`fleetReports${fleetIssue?.path.slice(1) ?? ''}: ${fleetIssue?.message ?? 'invalid'}`);
    }
    const decodedDistributedRuns = decodeArrayItems(
        distributedRuns,
        'distributedRuns',
        (run, runPath) => decodeControlDistributedRunSnapshot(run).mapLeft((issue) => `${runPath}: ${issue}`)
    );
    return decodeArrayItems(
        runs,
        'runs',
        (run, runPath) => decodeControlRunSnapshot(run).mapLeft((issue) => `${runPath}: ${issue}`)
    ).flatMap(
        (issue) => Either.ofLeft(issue),
        (restoredRuns) =>
            decodedDistributedRuns.mapRight((restoredDistributedRuns) => ({
                runs: restoredRuns,
                distributedRuns: restoredDistributedRuns,
                fleetReports: fleet.reports
            }))
    );
}
