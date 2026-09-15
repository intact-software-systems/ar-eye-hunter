import type { ControlRunSnapshotBounds, ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

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
        const snapshot = decodeSnapshotFile(JSON.parse(await Deno.readTextFile(path)));
        if (snapshot) {
            controlService.restoreSnapshot(snapshot);
            console.log(`Restored Rallar black-box control snapshot from ${path}`);
        }
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not restore control snapshot from ${path}: ${message}`);
    }
}

// The file is this server's own persisted snapshot, so only the envelope and the presence of runs
// are checked before the snapshot is trusted as written.
function decodeSnapshotFile(value: unknown): ControlServerSnapshot | undefined {
    if (!isJsonRecordValue(value) || !isJsonRecordValue(value.snapshot) || !value.snapshot.runs) {
        return undefined;
    }
    return value.snapshot as ControlServerSnapshot;
}
