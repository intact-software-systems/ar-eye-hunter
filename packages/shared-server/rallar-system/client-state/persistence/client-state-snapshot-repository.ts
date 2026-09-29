import type {
    ClientInstanceRef,
    ClientPresenceSnapshot,
    ClientPrincipalRef,
    ClientScope,
    ClientSessionRef,
    ClientSnapshot
} from '@shared/api/client-types.ts';
import { toClientSnapshotLastSeenAtEpochMs } from '@shared/api/group-client-views.ts';

import { resolveRuntimeStateReadBatchLiveValues } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type { RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { ClientStateEventStore } from '../../state-events/client-state-event-store.ts';
import { readStableStateSnapshot, StateSnapshotReadConflictError } from '../../state-events/state-snapshot-read.ts';
import { toClientPresenceState } from '../client-presence-state.ts';
import { assembleClientStateSnapshot, toActiveClientSessions } from './assemble-client-state-snapshot.ts';
import { toLiveClientStateEntryValue, type ClientPrincipalSnapshotRead } from './client-state-persistence-contracts.ts';
import { clientStatePrincipalStorageKey } from './client-state-principal-storage-key.ts';
import { ClientStateRepositoryReads } from './client-state-repository-reads.ts';
import {
    CLIENT_STATE_INSTANCES_NAMESPACE,
    CLIENT_STATE_PRINCIPALS_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE
} from './client-state-runtime-namespaces.ts';
import { clientStateScopeStorageKeyPrefix } from './client-state-scope-storage-key.ts';

export class ClientStateSnapshotRepository extends ClientStateRepositoryReads {
    constructor(repository: RuntimeStateRepositoryLike, events: ClientStateEventStore) {
        super(repository, events);
    }

    async listSnapshots(scope: ClientScope): Promise<readonly ClientSnapshot[]> {
        const keyPrefix = clientStateScopeStorageKeyPrefix(scope);
        const principalsBefore = await this.listClientPrincipalEntries(keyPrefix, scope);
        const [instances, sessions] = await Promise.all([
            this.listClientInstanceEntries(keyPrefix, scope),
            this.listClientSessionEntries(keyPrefix, scope)
        ]);
        const principalsAfter = await this.listClientPrincipalEntries(keyPrefix, scope);
        const instancesByPrincipalId = collectValuesByPrincipalId(
            instances.map((entry) => entry.value)
        );
        const activeSessionsByPrincipalId = collectValuesByPrincipalId(
            toActiveClientSessions(sessions.map((entry) => entry.value))
        );
        const beforeByKey = new Map(principalsBefore.map((stored) => [stored.entry.key, stored]));
        const snapshots = await Promise.all(
            principalsAfter.map(async (stored) => {
                const before = beforeByKey.get(stored.entry.key);
                if (!before || before.entry.revision !== stored.entry.revision) {
                    return await this.readSnapshot(stored.value);
                }
                return assembleClientStateSnapshot({
                    principal: stored.value,
                    instances: instancesByPrincipalId.get(stored.value.principalId) ?? [],
                    activeSessions: activeSessionsByPrincipalId.get(stored.value.principalId) ?? [],
                    stateRevision: stored.entry.revision + 1
                });
            })
        );
        return snapshots.filter((snapshot): snapshot is ClientSnapshot => snapshot !== undefined);
    }

    async readSnapshotsForPrincipals(
        refs: readonly ClientPrincipalRef[]
    ): Promise<readonly ClientSnapshot[]> {
        const uniqueRefs = [...new Map(refs.map((ref) => [clientStatePrincipalStorageKey(ref), ref])).values()];
        if (uniqueRefs.length === 0) {
            return [];
        }
        const principalSelectors: RuntimeStateReadBatchSelector[] = uniqueRefs.map((ref, index) => ({
            selectorId: `principal:${index}`,
            kind: 'key',
            namespace: CLIENT_STATE_PRINCIPALS_NAMESPACE,
            key: clientStatePrincipalStorageKey(ref)
        }));
        const childSelectors: RuntimeStateReadBatchSelector[] = uniqueRefs.flatMap((ref, index) => {
            const keyPrefix = this.childKeyPrefix(clientStatePrincipalStorageKey(ref));
            return [
                {
                    selectorId: `instances:${index}`,
                    kind: 'prefix',
                    namespace: CLIENT_STATE_INSTANCES_NAMESPACE,
                    keyPrefix
                },
                {
                    selectorId: `sessions:${index}`,
                    kind: 'prefix',
                    namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
                    keyPrefix
                }
            ];
        });
        const beforeSelections = await this.readLiveAudienceSelections([...principalSelectors, ...childSelectors]);
        const afterSelections = await this.readLiveAudienceSelections(principalSelectors);
        const snapshots = await Promise.all(uniqueRefs.map(async (ref, index) => {
            const after = afterSelections[index][0];
            if (!after) {
                return undefined;
            }
            const principal = this.findPrincipalEntryValue(after, ref);
            const before = beforeSelections[index][0];
            if (!before || before.entry.revision !== after.entry.revision) {
                return await this.readSnapshot(ref);
            }
            const instances = beforeSelections[uniqueRefs.length + index * 2]
                .map((entry) => this.toInstanceEntry(entry, ref).value);
            const activeSessions = toActiveClientSessions(
                beforeSelections[uniqueRefs.length + index * 2 + 1]
                    .map((entry) => this.toSessionEntry(entry, ref).value)
            );
            return assembleClientStateSnapshot({
                principal: principal.value,
                instances,
                activeSessions,
                stateRevision: principal.entry.revision + 1
            });
        }));
        return snapshots.filter((snapshot): snapshot is ClientSnapshot => snapshot !== undefined);
    }

    private async readLiveAudienceSelections(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly (readonly RuntimeStateEntryValue<JsonWireValue>[])[]> {
        const resolved = await resolveRuntimeStateReadBatchLiveValues(
            selectors,
            await this.repository.readRuntimeStateBatch(selectors),
            async (namespace, entry) => await this.toLiveJsonEntryValue(namespace, entry)
        );
        if (resolved.status === 'changed') {
            throw new StateSnapshotReadConflictError(
                selectors[0].kind === 'key' ? selectors[0].key : selectors[0].keyPrefix
            );
        }
        return resolved.selections.map((selection) => selection.entries);
    }

    async readPresenceSnapshot(ref: ClientPrincipalRef): Promise<ClientPresenceSnapshot | undefined> {
        const principal = await this.findPrincipalEntry(ref);
        if (!principal) {
            return undefined;
        }

        const activeSessions = toActiveClientSessions(
            (
                await this.listClientSessionEntries(
                    this.childKeyPrefix(clientStatePrincipalStorageKey(ref)),
                    ref
                )
            ).map((entry) => entry.value)
        );
        return {
            applicationId: principal.value.applicationId,
            workspaceId: principal.value.workspaceId,
            principalId: principal.value.principalId,
            presenceVersion: principal.value.presenceVersion,
            isOnline: activeSessions.length > 0,
            presenceState: toClientPresenceState(activeSessions),
            activeSessions,
            lastSeenAtEpochMs: toClientSnapshotLastSeenAtEpochMs(
                principal.value.lastSeenAtEpochMs,
                activeSessions
            )
        };
    }

    async readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined> {
        return (await this.readPrincipalSnapshot(ref))?.snapshot;
    }

    async readPrincipalSnapshot(
        ref: ClientPrincipalRef
    ): Promise<ClientPrincipalSnapshotRead | undefined> {
        const principalKey = clientStatePrincipalStorageKey(ref);
        return await readStableStateSnapshot({
            snapshotKey: principalKey,
            readAggregate: async () => await this.findPrincipalEntry(ref),
            readChildren: async () => {
                const [instances, sessions] = await Promise.all([
                    this.listClientInstanceEntries(this.childKeyPrefix(principalKey), ref),
                    this.listClientSessionEntries(this.childKeyPrefix(principalKey), ref)
                ]);
                return [
                    instances.map((entry) => entry.value),
                    toActiveClientSessions(sessions.map((entry) => entry.value))
                ] as const;
            },
            assemble: (stored, instances, activeSessions) => ({
                principal: stored,
                snapshot: assembleClientStateSnapshot({
                    principal: stored.value,
                    instances,
                    activeSessions,
                    stateRevision: stored.entry.revision + 1
                })
            })
        });
    }

    protected override async toLiveJsonEntryValue(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<JsonWireValue> | undefined> {
        void namespace;
        return await toLiveClientStateEntryValue(entry);
    }
}

function collectValuesByPrincipalId<T extends Readonly<{ principalId: string; }>>(
    values: readonly T[]
): Map<string, T[]> {
    const valuesByPrincipalId = new Map<string, T[]>();
    for (const value of values) {
        const current = valuesByPrincipalId.get(value.principalId) ?? [];
        current.push(value);
        valuesByPrincipalId.set(value.principalId, current);
    }
    return valuesByPrincipalId;
}
