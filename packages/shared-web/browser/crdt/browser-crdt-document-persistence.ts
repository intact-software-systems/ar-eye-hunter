import {
    createRallarCrdtLocalStore,
    type RallarCrdtLocalStore
} from '@shared-web/browser/crdt/browser-crdt-local-store.ts';
import type { BrowserCrdtOperationAuthor } from '@shared-web/browser/crdt/browser-crdt-operation-author.ts';
import { sortBrowserCrdtUpdates } from '@shared-web/browser/crdt/browser-crdt-runtime-values.ts';
import type { RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import {
    decryptRallarCrdtSnapshotEnvelope,
    decryptRallarCrdtUpdateEnvelope,
    encryptRallarCrdtSnapshotEnvelope,
    encryptRallarCrdtUpdateEnvelope,
    isRallarCrdtEncryptedJsonEnvelope,
    isRallarCrdtEncryptedOperationBatch,
    type RallarCrdtApplyResult,
    type RallarCrdtDependencyBlockedUpdate,
    type RallarCrdtDocument,
    type RallarCrdtDocumentRef,
    type RallarCrdtEncryptionKeyring,
    type RallarCrdtFailedPendingUpdate,
    type RallarCrdtJsonValue,
    type RallarCrdtOperationBatch,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

export namespace BrowserCrdtDocumentPersistence {
    export type Options<TValue, TPayload extends RallarCrdtOperationBatch> = Readonly<{
        ref: RallarCrdtDocumentRef;
        documentKey: string;
        engine: RallarCrdtDocument<TValue, TPayload>;
        operations: BrowserCrdtOperationAuthor<TPayload>;
        pending: Map<string, RallarCrdtUpdateEnvelope<TPayload>>;
        failed: Map<string, RallarCrdtFailedPendingUpdate<TPayload>>;
        dependencyBlocked: Map<string, RallarCrdtDependencyBlockedUpdate<TPayload>>;
        enabled: boolean;
        encryption?: RallarCrdtEncryptionKeyring;
        data: RallarDataFacade;
        dbName: string;
        now: () => number;
    }>;

    export type Health = Readonly<{
        lastSnapshotAtEpochMs?: number;
        replayDurationMs: number;
        corruptLocalArtifactCount: number;
    }>;
}

/** Owns local replay, encryption at rest, and durable document cleanup. */
export class BrowserCrdtDocumentPersistence<TValue, TPayload extends RallarCrdtOperationBatch> {
    private readonly options: BrowserCrdtDocumentPersistence.Options<TValue, TPayload>;
    private localStore: RallarCrdtLocalStore | undefined;
    private lastSnapshotAtEpochMs: number | undefined;
    private replayDurationMs = 0;
    private corruptLocalArtifactCount = 0;

    public constructor(
        options: BrowserCrdtDocumentPersistence.Options<TValue, TPayload>
    ) {
        this.options = options;
    }

    public async hydrate(): Promise<void> {
        const startedAt = this.options.now();
        if (this.options.enabled) {
            this.localStore = await createRallarCrdtLocalStore({
                data: this.options.data,
                dbName: this.options.dbName
            });
            const state = await this.localStore.loadDocument<TValue | RallarCrdtJsonValue, TPayload>(this.options.ref);
            this.corruptLocalArtifactCount = state.corruptArtifacts.length;

            if (state.snapshot) {
                this.options.engine.importSnapshot(
                    await this.revealSnapshot(state.snapshot)
                );
                this.lastSnapshotAtEpochMs = state.snapshot.createdAtEpochMs;
            }
            for (const update of sortBrowserCrdtUpdates(state.pendingUpdates)) {
                this.options.pending.set(update.updateId, update);
                const engineUpdate = await this.revealUpdate(update);
                this.options.engine.apply(engineUpdate);
                this.options.operations.remember(engineUpdate);
            }
            for (const failed of state.failedPendingUpdates) {
                this.options.failed.set(failed.update.updateId, failed);
            }
            for (const blocked of state.dependencyBlockedUpdates) {
                this.options.dependencyBlocked.set(blocked.update.updateId, blocked);
            }

            await this.localStore.writeMetadata({
                documentKey: this.options.documentKey,
                ref: this.options.ref,
                replicaId: this.options.engine.replicaId,
                schemaVersion: state.metadata?.schemaVersion ?? 1,
                updatedAtEpochMs: this.options.now()
            });
        }
        this.replayDurationMs = Math.max(0, this.options.now() - startedAt);
    }

    public health(): BrowserCrdtDocumentPersistence.Health {
        return {
            lastSnapshotAtEpochMs: this.lastSnapshotAtEpochMs,
            replayDurationMs: this.replayDurationMs,
            corruptLocalArtifactCount: this.corruptLocalArtifactCount
        };
    }

    public async protectUpdate(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>> {
        return this.options.encryption
            ? await encryptRallarCrdtUpdateEnvelope(
                update,
                this.options.encryption
            )
            : update;
    }

    public async revealUpdate(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        if (!isRallarCrdtEncryptedOperationBatch(update.payload)) {
            return update;
        }
        if (!this.options.encryption) {
            throw new Error(
                'Cannot apply encrypted CRDT update without document encryption keys.'
            );
        }
        return await decryptRallarCrdtUpdateEnvelope<TPayload>(
            update as RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>,
            this.options.encryption
        );
    }

    public async revealSnapshot(
        snapshot: RallarCrdtSnapshotEnvelope<TValue | RallarCrdtJsonValue>
    ): Promise<RallarCrdtSnapshotEnvelope<TValue>> {
        if (!isRallarCrdtEncryptedJsonEnvelope(snapshot.value)) {
            return snapshot as RallarCrdtSnapshotEnvelope<TValue>;
        }
        if (!this.options.encryption) {
            throw new Error(
                'Cannot import encrypted CRDT snapshot without document encryption keys.'
            );
        }
        return await decryptRallarCrdtSnapshotEnvelope<TValue>(
            snapshot,
            this.options.encryption
        );
    }

    public async appendLocalUpdate(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<void> {
        await this.localStore?.appendPendingUpdate(update);
        await this.persistAppliedState(update);
        await this.localStore?.flush();
    }

    public async rememberFailedUpdate(
        failed: RallarCrdtFailedPendingUpdate<TPayload>
    ): Promise<void> {
        this.options.failed.set(failed.update.updateId, failed);
        await this.localStore?.writeFailedPendingUpdate(failed);
    }

    public async persistApplyResult(
        update: RallarCrdtUpdateEnvelope<TPayload>,
        result: RallarCrdtApplyResult
    ): Promise<void> {
        if (!this.localStore) {
            return;
        }
        if (result.status === 'applied' || result.status === 'duplicate') {
            await this.persistAppliedState(update, result.releasedUpdateIds);
            return;
        }
        if (result.status === 'dependency-blocked') {
            const blocked: RallarCrdtDependencyBlockedUpdate<TPayload> = {
                update,
                blockedAtEpochMs: this.options.now(),
                missingDependencyIds: result.missingDependencyIds,
                reason: 'Missing CRDT update dependencies.'
            };
            this.options.dependencyBlocked.set(update.updateId, blocked);
            await this.localStore.writeDependencyBlockedUpdate(blocked);
        }
    }

    public async flush(): Promise<void> {
        if (!this.localStore) {
            return;
        }
        const snapshot = await this.protectSnapshot(
            this.options.engine.snapshot('flush')
        );
        await this.localStore.writeSnapshot(snapshot);
        await this.localStore.flush();
        this.lastSnapshotAtEpochMs = snapshot.createdAtEpochMs;
    }

    public rememberSnapshot(createdAtEpochMs: number): void {
        this.lastSnapshotAtEpochMs = createdAtEpochMs;
    }

    public async removePendingUpdate(updateId: string): Promise<void> {
        this.options.pending.delete(updateId);
        await this.localStore?.removePendingUpdate(this.options.ref, updateId);
    }

    public async close(): Promise<void> {
        await this.localStore?.close();
        this.localStore = undefined;
    }

    public async destroy(): Promise<void> {
        await this.localStore?.destroyDocument(this.options.ref);
        await this.close();
    }

    private async persistAppliedState(
        update: RallarCrdtUpdateEnvelope<TPayload>,
        releasedUpdateIds: readonly string[] = []
    ): Promise<void> {
        if (!this.localStore) {
            return;
        }
        const appliedUpdateIds = [
            ...new Set([update.updateId, ...releasedUpdateIds])
        ];
        await Promise.all(
            appliedUpdateIds.flatMap((updateId) => {
                this.options.dependencyBlocked.delete(updateId);
                return [
                    this.localStore?.markSeen(
                        this.options.ref,
                        updateId,
                        this.options.now()
                    ),
                    this.localStore?.removeDependencyBlockedUpdate(
                        this.options.ref,
                        updateId
                    )
                ];
            })
        );

        const snapshot = await this.protectSnapshot(
            this.options.engine.snapshot('applied-update')
        );
        await this.localStore.writeSnapshot(snapshot);
        this.lastSnapshotAtEpochMs = snapshot.createdAtEpochMs;
    }

    private async protectSnapshot(
        snapshot: RallarCrdtSnapshotEnvelope<TValue>
    ): Promise<RallarCrdtSnapshotEnvelope<TValue | RallarCrdtJsonValue>> {
        return this.options.encryption
            ? await encryptRallarCrdtSnapshotEnvelope(
                snapshot,
                this.options.encryption
            )
            : snapshot;
    }
}
