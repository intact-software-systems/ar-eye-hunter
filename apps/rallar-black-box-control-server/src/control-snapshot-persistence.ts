import type {
    ControlRunSnapshotBounds,
    ControlServerSnapshot,
    RallarBlackBoxControlService
} from './control-service.ts';

const SNAPSHOT_PERSIST_DEBOUNCE_MS = 100;

export interface ControlSnapshotPersistence {
    restore(): Promise<void>;
    persist(): void;
}

export interface CreateControlSnapshotPersistenceInput {
    readonly storageDir?: string;
    readonly retentionMaxRuns: number;
    readonly snapshotBounds: ControlRunSnapshotBounds;
    readonly controlService: RallarBlackBoxControlService;
    readonly deleteRuns: (runIds: readonly string[]) => void;
}

export function createControlSnapshotPersistence(
    input: CreateControlSnapshotPersistenceInput
): ControlSnapshotPersistence {
    let sequence = 0;
    let scheduled = false;
    let persisting = false;
    let dirty = false;

    function snapshotPath(): string | undefined {
        return input.storageDir
            ? `${input.storageDir.replace(/\/+$/, '')}/control-snapshot.json`
            : undefined;
    }

    async function writeSnapshot(): Promise<void> {
        const path = snapshotPath();
        if (!path || !input.storageDir) {
            return;
        }
        const tempPath = `${path}.tmp-${Deno.pid}-${Date.now()}-${sequence += 1}`;

        const snapshot = input.controlService.snapshotForPersistence(input.snapshotBounds);
        const payload = JSON.stringify(
            {
                schemaVersion: 1,
                savedAtEpochMs: Date.now(),
                snapshot
            },
            null,
            2
        );
        try {
            await Deno.mkdir(input.storageDir, { recursive: true });
            await Deno.writeTextFile(tempPath, payload);
            await Deno.rename(tempPath, path);
        }
        catch (error) {
            Deno.remove(tempPath).catch(() => undefined);
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Could not persist control snapshot to ${path}: ${message}`);
        }
    }

    async function flush(): Promise<void> {
        scheduled = false;
        if (!dirty || persisting) {
            return;
        }
        dirty = false;
        persisting = true;
        try {
            await writeSnapshot();
        }
        finally {
            persisting = false;
            if (dirty) {
                schedulePersistence();
            }
        }
    }

    function schedulePersistence(): void {
        const deletedRunIds = input.controlService.pruneRuns(input.retentionMaxRuns);
        if (deletedRunIds.length > 0) {
            input.deleteRuns(deletedRunIds);
        }

        if (!snapshotPath()) {
            return;
        }
        dirty = true;
        if (scheduled || persisting) {
            return;
        }
        scheduled = true;
        setTimeout(() => {
            void flush();
        }, SNAPSHOT_PERSIST_DEBOUNCE_MS);
    }

    return {
        async restore() {
            const path = snapshotPath();
            if (!path) {
                return;
            }

            try {
                const text = await Deno.readTextFile(path);
                const parsed = JSON.parse(text) as { snapshot?: ControlServerSnapshot; };
                if (parsed.snapshot?.runs) {
                    input.controlService.restoreSnapshot(parsed.snapshot);
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
        },
        persist: schedulePersistence
    };
}
