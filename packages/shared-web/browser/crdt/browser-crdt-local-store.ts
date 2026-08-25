import type { RallarDataFacade, RallarDataStore } from '@shared-web/browser/rallar-data.ts';
import {
    toRallarCrdtDocumentKey,
    validateRallarCrdtSnapshotEnvelope,
    validateRallarCrdtUpdateEnvelope,
    type RallarCrdtDependencyBlockedUpdate,
    type RallarCrdtDocumentRef,
    type RallarCrdtFailedPendingUpdate,
    type RallarCrdtOperationBatch,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

export const RALLAR_CRDT_LOCAL_STORE_NAMES = {
    snapshots: 'crdt:snapshots',
    pendingUpdates: 'crdt:pending-updates',
    failedPendingUpdates: 'crdt:failed-pending-updates',
    dependencyBlockedUpdates: 'crdt:dependency-blocked-updates',
    seenUpdates: 'crdt:seen-updates',
    metadata: 'crdt:metadata'
} as const;

export const DEFAULT_RALLAR_CRDT_DB_NAME = 'rallar-crdt';

export type RallarCrdtLocalStoreOptions = Readonly<{
    data: RallarDataFacade;
    dbName?: string;
}>;

export type RallarCrdtSeenUpdateRecord = Readonly<{
    documentKey: string;
    updateId: string;
    seenAtEpochMs: number;
}>;

export type RallarCrdtDocumentMetadataRecord = Readonly<{
    documentKey: string;
    ref: RallarCrdtDocumentRef;
    replicaId: string;
    schemaVersion: number;
    updatedAtEpochMs: number;
}>;

type RallarCrdtLocalStoreName = (typeof RALLAR_CRDT_LOCAL_STORE_NAMES)[keyof typeof RALLAR_CRDT_LOCAL_STORE_NAMES];

export type RallarCrdtLocalCorruptArtifact = Readonly<{
    store: RallarCrdtLocalStoreName;
    key: string;
    reason: string;
    issueCodes: readonly string[];
}>;

export type RallarCrdtLocalDocumentState<
    TValue = unknown,
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
> = Readonly<{
    documentKey: string;
    snapshot?: RallarCrdtSnapshotEnvelope<TValue>;
    pendingUpdates: readonly RallarCrdtUpdateEnvelope<TPayload>[];
    failedPendingUpdates: readonly RallarCrdtFailedPendingUpdate<TPayload>[];
    dependencyBlockedUpdates: readonly RallarCrdtDependencyBlockedUpdate<TPayload>[];
    seenUpdates: readonly RallarCrdtSeenUpdateRecord[];
    metadata?: RallarCrdtDocumentMetadataRecord;
    corruptArtifacts: readonly RallarCrdtLocalCorruptArtifact[];
}>;

export type RallarCrdtLocalStore = Readonly<{
    loadDocument<TValue = unknown, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch>(
        ref: RallarCrdtDocumentRef
    ): Promise<RallarCrdtLocalDocumentState<TValue, TPayload>>;
    writeSnapshot<TValue>(
        snapshot: RallarCrdtSnapshotEnvelope<TValue>
    ): Promise<void>;
    appendPendingUpdate<TPayload extends RallarCrdtOperationBatch>(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<void>;
    removePendingUpdate(
        ref: RallarCrdtDocumentRef,
        updateId: string
    ): Promise<boolean>;
    writeFailedPendingUpdate<TPayload extends RallarCrdtOperationBatch>(
        failed: RallarCrdtFailedPendingUpdate<TPayload>
    ): Promise<void>;
    writeDependencyBlockedUpdate<TPayload extends RallarCrdtOperationBatch>(
        blocked: RallarCrdtDependencyBlockedUpdate<TPayload>
    ): Promise<void>;
    removeDependencyBlockedUpdate(
        ref: RallarCrdtDocumentRef,
        updateId: string
    ): Promise<boolean>;
    markSeen(
        ref: RallarCrdtDocumentRef,
        updateId: string,
        seenAtEpochMs: number
    ): Promise<void>;
    writeMetadata(metadata: RallarCrdtDocumentMetadataRecord): Promise<void>;
    flush(): Promise<void>;
    clearDocument(ref: RallarCrdtDocumentRef): Promise<void>;
    destroyDocument(ref: RallarCrdtDocumentRef): Promise<void>;
    close(): Promise<void>;
}>;

type StoreBundle = Readonly<{
    snapshots: RallarDataStore<RallarCrdtSnapshotEnvelope>;
    pendingUpdates: RallarDataStore<RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>>;
    failedPendingUpdates: RallarDataStore<RallarCrdtFailedPendingUpdate<RallarCrdtOperationBatch>>;
    dependencyBlockedUpdates: RallarDataStore<RallarCrdtDependencyBlockedUpdate<RallarCrdtOperationBatch>>;
    seenUpdates: RallarDataStore<RallarCrdtSeenUpdateRecord>;
    metadata: RallarDataStore<RallarCrdtDocumentMetadataRecord>;
}>;

export async function createRallarCrdtLocalStore(
    options: RallarCrdtLocalStoreOptions
): Promise<RallarCrdtLocalStore> {
    const dbName = options.dbName ?? DEFAULT_RALLAR_CRDT_DB_NAME;
    const stores: StoreBundle = {
        snapshots: await openInternalStore(
            options.data,
            dbName,
            RALLAR_CRDT_LOCAL_STORE_NAMES.snapshots
        ),
        pendingUpdates: await openInternalStore(
            options.data,
            dbName,
            RALLAR_CRDT_LOCAL_STORE_NAMES.pendingUpdates
        ),
        failedPendingUpdates: await openInternalStore(
            options.data,
            dbName,
            RALLAR_CRDT_LOCAL_STORE_NAMES.failedPendingUpdates
        ),
        dependencyBlockedUpdates: await openInternalStore(
            options.data,
            dbName,
            RALLAR_CRDT_LOCAL_STORE_NAMES.dependencyBlockedUpdates
        ),
        seenUpdates: await openInternalStore(
            options.data,
            dbName,
            RALLAR_CRDT_LOCAL_STORE_NAMES.seenUpdates
        ),
        metadata: await openInternalStore(
            options.data,
            dbName,
            RALLAR_CRDT_LOCAL_STORE_NAMES.metadata
        )
    };

    return new DataBackedRallarCrdtLocalStore(stores);
}

class DataBackedRallarCrdtLocalStore implements RallarCrdtLocalStore {
    private readonly stores: StoreBundle;

    public constructor(stores: StoreBundle) {
        this.stores = stores;
    }

    public async loadDocument<TValue = unknown, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch>(
        ref: RallarCrdtDocumentRef
    ): Promise<RallarCrdtLocalDocumentState<TValue, TPayload>> {
        const documentKey = toRallarCrdtDocumentKey(ref);
        const documentStoreKey = toDocumentStoreKey(documentKey);
        const prefix = toDocumentArtifactPrefix(documentKey);

        const [
            snapshot,
            pendingUpdateEntries,
            failedPendingUpdateEntries,
            dependencyBlockedUpdateEntries,
            seenUpdates,
            metadata
        ] = await Promise.all([
            this.stores.snapshots.get(documentStoreKey),
            readDocumentArtifactEntries(this.stores.pendingUpdates, prefix),
            readDocumentArtifactEntries(
                this.stores.failedPendingUpdates,
                prefix
            ),
            readDocumentArtifactEntries(
                this.stores.dependencyBlockedUpdates,
                prefix
            ),
            readDocumentArtifacts(this.stores.seenUpdates, prefix),
            this.stores.metadata.get(documentStoreKey)
        ]);
        const corruptArtifacts: RallarCrdtLocalCorruptArtifact[] = [];
        const validSnapshot = validateSnapshotArtifact<TValue>(
            snapshot,
            RALLAR_CRDT_LOCAL_STORE_NAMES.snapshots,
            documentStoreKey,
            corruptArtifacts
        );

        return {
            documentKey,
            snapshot: validSnapshot,
            pendingUpdates: collectValidUpdateArtifacts<TPayload>(
                pendingUpdateEntries,
                RALLAR_CRDT_LOCAL_STORE_NAMES.pendingUpdates,
                corruptArtifacts
            ),
            failedPendingUpdates: collectValidNestedUpdateArtifacts<RallarCrdtFailedPendingUpdate<TPayload>>(
                failedPendingUpdateEntries,
                RALLAR_CRDT_LOCAL_STORE_NAMES.failedPendingUpdates,
                corruptArtifacts
            ),
            dependencyBlockedUpdates: collectValidNestedUpdateArtifacts<RallarCrdtDependencyBlockedUpdate<TPayload>>(
                dependencyBlockedUpdateEntries,
                RALLAR_CRDT_LOCAL_STORE_NAMES.dependencyBlockedUpdates,
                corruptArtifacts
            ),
            seenUpdates,
            metadata,
            corruptArtifacts
        };
    }

    public async writeSnapshot<TValue>(
        snapshot: RallarCrdtSnapshotEnvelope<TValue>
    ): Promise<void> {
        await this.stores.snapshots.set(
            toDocumentStoreKey(toRallarCrdtDocumentKey(snapshot.document)),
            snapshot as RallarCrdtSnapshotEnvelope
        );
    }

    public async appendPendingUpdate<TPayload extends RallarCrdtOperationBatch>(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<void> {
        await this.stores.pendingUpdates.set(
            toDocumentArtifactKey(
                toRallarCrdtDocumentKey(update.document),
                update.updateId
            ),
            update
        );
    }

    public async removePendingUpdate(
        ref: RallarCrdtDocumentRef,
        updateId: string
    ): Promise<boolean> {
        return await this.stores.pendingUpdates.delete(
            toDocumentArtifactKey(toRallarCrdtDocumentKey(ref), updateId)
        );
    }

    public async writeFailedPendingUpdate<TPayload extends RallarCrdtOperationBatch>(
        failed: RallarCrdtFailedPendingUpdate<TPayload>
    ): Promise<void> {
        await this.stores.failedPendingUpdates.set(
            toDocumentArtifactKey(
                toRallarCrdtDocumentKey(failed.update.document),
                failed.update.updateId
            ),
            failed
        );
    }

    public async writeDependencyBlockedUpdate<TPayload extends RallarCrdtOperationBatch>(
        blocked: RallarCrdtDependencyBlockedUpdate<TPayload>
    ): Promise<void> {
        await this.stores.dependencyBlockedUpdates.set(
            toDocumentArtifactKey(
                toRallarCrdtDocumentKey(blocked.update.document),
                blocked.update.updateId
            ),
            blocked
        );
    }

    public async removeDependencyBlockedUpdate(
        ref: RallarCrdtDocumentRef,
        updateId: string
    ): Promise<boolean> {
        return await this.stores.dependencyBlockedUpdates.delete(
            toDocumentArtifactKey(toRallarCrdtDocumentKey(ref), updateId)
        );
    }

    public async markSeen(
        ref: RallarCrdtDocumentRef,
        updateId: string,
        seenAtEpochMs: number
    ): Promise<void> {
        const documentKey = toRallarCrdtDocumentKey(ref);
        await this.stores.seenUpdates.set(
            toDocumentArtifactKey(documentKey, updateId),
            {
                documentKey,
                updateId,
                seenAtEpochMs
            }
        );
    }

    public async writeMetadata(
        metadata: RallarCrdtDocumentMetadataRecord
    ): Promise<void> {
        await this.stores.metadata.set(
            toDocumentStoreKey(metadata.documentKey),
            metadata
        );
    }

    public async flush(): Promise<void> {
        await Promise.all(
            Object.values(this.stores).map((store) => store.flush())
        );
    }

    public async clearDocument(ref: RallarCrdtDocumentRef): Promise<void> {
        const documentKey = toRallarCrdtDocumentKey(ref);
        const documentStoreKey = toDocumentStoreKey(documentKey);
        const prefix = toDocumentArtifactPrefix(documentKey);

        await Promise.all([
            this.stores.snapshots.delete(documentStoreKey),
            this.stores.metadata.delete(documentStoreKey),
            deleteDocumentArtifacts(this.stores.pendingUpdates, prefix),
            deleteDocumentArtifacts(this.stores.failedPendingUpdates, prefix),
            deleteDocumentArtifacts(
                this.stores.dependencyBlockedUpdates,
                prefix
            ),
            deleteDocumentArtifacts(this.stores.seenUpdates, prefix)
        ]);
    }

    public async destroyDocument(ref: RallarCrdtDocumentRef): Promise<void> {
        await this.clearDocument(ref);
        await this.flush();
    }

    public async close(): Promise<void> {
        await this.flush();
        await Promise.all(
            Object.values(this.stores).map((store) => store.close())
        );
    }
}

async function openInternalStore<V>(
    data: RallarDataFacade,
    dbName: string,
    name: string
): Promise<RallarDataStore<V>> {
    return await data.open<V>(name, {
        dbName,
        scope: 'app',
        schemaVersion: 1,
        sync: false
    });
}

async function readDocumentArtifacts<V>(
    store: RallarDataStore<V>,
    prefix: string
): Promise<V[]> {
    return (await readDocumentArtifactEntries(store, prefix)).map(
        (entry) => entry.value
    );
}

async function readDocumentArtifactEntries<V>(
    store: RallarDataStore<V>,
    prefix: string
): Promise<Array<Readonly<{ key: string; value: V; }>>> {
    const keys = (await store.listKeys())
        .filter((key) => key.startsWith(prefix))
        .sort();
    const entries: Array<Readonly<{ key: string; value: V; }>> = [];

    for (const key of keys) {
        const value = await store.get(key);
        if (value !== undefined) {
            entries.push({
                key,
                value
            });
        }
    }

    return entries;
}

async function deleteDocumentArtifacts<V>(
    store: RallarDataStore<V>,
    prefix: string
): Promise<void> {
    const keys = (await store.listKeys()).filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => store.delete(key)));
}

function toDocumentStoreKey(documentKey: string): string {
    return encodeURIComponent(documentKey);
}

function toDocumentArtifactPrefix(documentKey: string): string {
    return `${toDocumentStoreKey(documentKey)}/`;
}

function toDocumentArtifactKey(
    documentKey: string,
    artifactId: string
): string {
    return `${toDocumentArtifactPrefix(documentKey)}${
        encodeURIComponent(
            artifactId
        )
    }`;
}

function validateSnapshotArtifact<TValue>(
    snapshot: RallarCrdtSnapshotEnvelope | undefined,
    store: RallarCrdtLocalStoreName,
    key: string,
    corruptArtifacts: RallarCrdtLocalCorruptArtifact[]
): RallarCrdtSnapshotEnvelope<TValue> | undefined {
    if (!snapshot) {
        return undefined;
    }

    const validation = validateRallarCrdtSnapshotEnvelope(snapshot);
    if (validation.valid) {
        return snapshot as RallarCrdtSnapshotEnvelope<TValue>;
    }

    corruptArtifacts.push({
        store,
        key,
        reason: 'Persisted CRDT snapshot failed validation and was not replayed.',
        issueCodes: validation.issues.map((issue) => issue.code)
    });
    return undefined;
}

function collectValidUpdateArtifacts<TPayload extends RallarCrdtOperationBatch>(
    entries: Array<Readonly<{ key: string; value: unknown; }>>,
    store: RallarCrdtLocalStoreName,
    corruptArtifacts: RallarCrdtLocalCorruptArtifact[]
): RallarCrdtUpdateEnvelope<TPayload>[] {
    const updates: RallarCrdtUpdateEnvelope<TPayload>[] = [];

    for (const entry of entries) {
        const validation = validateRallarCrdtUpdateEnvelope(entry.value);
        if (validation.valid) {
            updates.push(entry.value as RallarCrdtUpdateEnvelope<TPayload>);
        }
        else {
            corruptArtifacts.push({
                store,
                key: entry.key,
                reason: 'Persisted CRDT update failed validation and was not replayed.',
                issueCodes: validation.issues.map((issue) => issue.code)
            });
        }
    }

    return updates;
}

function collectValidNestedUpdateArtifacts<TArtifact extends Readonly<{ update: RallarCrdtUpdateEnvelope; }>>(
    entries: Array<Readonly<{ key: string; value: unknown; }>>,
    store: RallarCrdtLocalStoreName,
    corruptArtifacts: RallarCrdtLocalCorruptArtifact[]
): TArtifact[] {
    const artifacts: TArtifact[] = [];

    for (const entry of entries) {
        const update = readNestedUpdate(entry.value);
        const validation = validateRallarCrdtUpdateEnvelope(update);
        if (validation.valid) {
            artifacts.push(entry.value as TArtifact);
        }
        else {
            corruptArtifacts.push({
                store,
                key: entry.key,
                reason: 'Persisted CRDT nested update artifact failed validation and was not replayed.',
                issueCodes: validation.issues.map((issue) => issue.code)
            });
        }
    }

    return artifacts;
}

function readNestedUpdate(value: unknown): unknown {
    return value && typeof value === 'object' && 'update' in value
        ? (value as { update?: unknown; }).update
        : undefined;
}
