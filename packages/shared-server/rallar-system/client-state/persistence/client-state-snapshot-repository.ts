import type {
    ClientInstance,
    ClientInstanceRef,
    ClientPresenceSnapshot,
    ClientPrincipalRef,
    ClientScope,
    ClientSession,
    ClientSessionRef,
    ClientSnapshot
} from '@shared/api/client-types.ts';
import { toClientSnapshotLastSeenAtEpochMs } from '@shared/api/group-client-views.ts';

import {
    resolveRuntimeStateReadBatchLiveValues,
    type RuntimeStateReadBatchLiveSelection
} from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type { RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import { toRuntimeStateReadBatchSelectedKey } from '../../../runtime-state/read-batch/to-runtime-state-read-batch-selected-key.ts';
import type { RuntimeStateEntryRead, RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { ClientStateEventStore } from '../../state-events/client-state-event-store.ts';
import { readStableStateSnapshot, StateSnapshotReadConflictError } from '../../state-events/state-snapshot-read.ts';
import {
    toPrincipalAudienceSessions,
    type PrincipalAudienceSessions
} from '../../state-sync/state-sync-principal-audience.ts';
import { toClientPresenceState } from '../client-presence-state.ts';
import { assembleClientStateSnapshot, toActiveClientSessions } from './assemble-client-state-snapshot.ts';
import { clientStateIdempotencyStorageKey } from './client-state-idempotency-storage-key.ts';
import { clientStateInstanceStorageKey } from './client-state-instance-storage-key.ts';
import {
    toLiveClientStateEntryValue,
    type ClientMutationIdempotencyRecord,
    type ClientMutationStateBatch,
    type ClientMutationStateBatchInput,
    type ClientPrincipalSnapshotRead
} from './client-state-persistence-contracts.ts';
import { clientStatePrincipalStorageKey } from './client-state-principal-storage-key.ts';
import { ClientStateRepositoryReads } from './client-state-repository-reads.ts';
import {
    CLIENT_STATE_IDEMPOTENT_NAMESPACE,
    CLIENT_STATE_INSTANCES_NAMESPACE,
    CLIENT_STATE_PRINCIPALS_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE
} from './client-state-runtime-namespaces.ts';
import { clientStateScopeStorageKeyPrefix } from './client-state-scope-storage-key.ts';
import { clientStateSessionStorageKey } from './client-state-session-storage-key.ts';

type LiveSelection = RuntimeStateReadBatchLiveSelection<JsonWireValue>;

interface PrincipalChildSelections {
    readonly principal: LiveSelection;
    readonly instances: LiveSelection;
    readonly sessions: LiveSelection;
}

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

    /**
     * Every co-member's principal and connected sessions from one statement, so each principal agrees with its
     * sessions; the disconnected sessions a principal retains stay in the store.
     */
    async readAudienceSessionsForPrincipals(
        refs: readonly ClientPrincipalRef[]
    ): Promise<readonly PrincipalAudienceSessions[]> {
        const uniqueRefs = [...new Map(refs.map((ref) => [clientStatePrincipalStorageKey(ref), ref])).values()];
        if (uniqueRefs.length === 0) {
            return [];
        }
        const selections = await this.readLiveSelections(uniqueRefs.flatMap((ref, index) => [
            this.toPrincipalSelector(ref, `principal:${index}`),
            this.toConnectedSessionsSelector(ref, `sessions:${index}`)
        ]));
        return uniqueRefs.flatMap((ref, index) => {
            const [stored] = selections[index * 2].entries;
            if (!stored) {
                return [];
            }
            const principal = this.findPrincipalEntryValue(stored, ref).value;
            const sessions = selections[index * 2 + 1].entries.map((entry) => this.toSessionEntry(entry, ref).value);
            return [toPrincipalAudienceSessions(principal, toActiveClientSessions(sessions))];
        });
    }

    /** A mutation's principal snapshot, instance, session and receipt, with the companion rows, from one statement. */
    async readMutationState(input: ClientMutationStateBatchInput): Promise<ClientMutationStateBatch> {
        const { principalRef, requestId } = input;
        const selectors = [
            this.toPrincipalSelector(principalRef, 'principal'),
            this.toChildSelector(principalRef, CLIENT_STATE_INSTANCES_NAMESPACE, 'instances'),
            this.toChildSelector(principalRef, CLIENT_STATE_SESSIONS_NAMESPACE, 'sessions')
        ];
        if (requestId !== null) {
            selectors.push({
                selectorId: 'idempotency',
                kind: 'key',
                namespace: CLIENT_STATE_IDEMPOTENT_NAMESPACE,
                key: clientStateIdempotencyStorageKey(principalRef, requestId)
            });
        }
        const selections = await this.readLiveSelections([...selectors, ...input.companionSelectors]);
        const [principal, instances, sessions] = selections;
        return {
            idempotency: requestId === null
                ? undefined
                : this.toIdempotencyRead(selections[3], principalRef, requestId),
            principalSnapshot: this.toPrincipalSnapshotRead(principalRef, { principal, instances, sessions }),
            instance: input.instanceRef ? this.toInstanceRead(instances, input.instanceRef) : undefined,
            session: input.sessionRef ? this.toSessionRead(sessions, input.sessionRef) : NO_ENTRY_READ,
            companions: selections.slice(selectors.length)
        };
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

    /** Client-state rows decode as client-state; a companion row of another feature keeps the store's own rule. */
    protected override async toLiveJsonEntryValue(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<JsonWireValue> | undefined> {
        return CLIENT_STATE_NAMESPACES.has(namespace)
            ? await toLiveClientStateEntryValue(entry)
            : await super.toLiveJsonEntryValue(namespace, entry);
    }

    private async readLiveSelections(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly LiveSelection[]> {
        const resolved = await resolveRuntimeStateReadBatchLiveValues(
            selectors,
            await this.repository.readRuntimeStateBatch(selectors),
            async (namespace, entry) => await this.toLiveJsonEntryValue(namespace, entry)
        );
        if (resolved.status === 'changed') {
            throw new StateSnapshotReadConflictError(toRuntimeStateReadBatchSelectedKey(selectors[0]));
        }
        return resolved.selections;
    }

    private toPrincipalSelector(ref: ClientPrincipalRef, selectorId: string): RuntimeStateReadBatchSelector {
        return {
            selectorId,
            kind: 'key',
            namespace: CLIENT_STATE_PRINCIPALS_NAMESPACE,
            key: clientStatePrincipalStorageKey(ref)
        };
    }

    private toChildSelector(
        ref: ClientPrincipalRef,
        namespace: string,
        selectorId: string
    ): RuntimeStateReadBatchSelector {
        return {
            selectorId,
            kind: 'prefix',
            namespace,
            keyPrefix: this.childKeyPrefix(clientStatePrincipalStorageKey(ref))
        };
    }

    private toConnectedSessionsSelector(ref: ClientPrincipalRef, selectorId: string): RuntimeStateReadBatchSelector {
        return {
            selectorId,
            kind: 'prefix-containing',
            namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
            keyPrefix: this.childKeyPrefix(clientStatePrincipalStorageKey(ref)),
            storedValueContains: CONNECTED_SESSION_FIELDS
        };
    }

    private toPrincipalSnapshotRead(
        ref: ClientPrincipalRef,
        selections: PrincipalChildSelections
    ): ClientPrincipalSnapshotRead | undefined {
        const [stored] = selections.principal.entries;
        if (!stored) {
            return undefined;
        }
        const principal = this.findPrincipalEntryValue(stored, ref);
        const instances = selections.instances.entries.map((entry) => this.toInstanceEntry(entry, ref).value);
        const sessions = selections.sessions.entries.map((entry) => this.toSessionEntry(entry, ref).value);
        return {
            principal,
            snapshot: assembleClientStateSnapshot({
                principal: principal.value,
                instances,
                activeSessions: toActiveClientSessions(sessions),
                stateRevision: principal.entry.revision + 1
            })
        };
    }

    private toIdempotencyRead(
        selection: LiveSelection,
        ref: ClientPrincipalRef,
        requestId: string
    ): RuntimeStateEntryValue<ClientMutationIdempotencyRecord> | undefined {
        const [stored] = selection.entries;
        return stored ? this.toIdempotencyEntry(stored, { ...ref, requestId }) : undefined;
    }

    private toInstanceRead(
        instances: LiveSelection,
        ref: ClientInstanceRef
    ): RuntimeStateEntryValue<ClientInstance> | undefined {
        const key = clientStateInstanceStorageKey(ref);
        const stored = instances.entries.find((entry) => entry.entry.key === key);
        return stored ? this.toInstanceEntry(stored, ref) : undefined;
    }

    private toSessionRead(sessions: LiveSelection, ref: ClientSessionRef): RuntimeStateEntryRead<ClientSession> {
        const key = clientStateSessionStorageKey(ref);
        const stored = sessions.entries.find((entry) => entry.entry.key === key);
        return {
            value: stored ? this.toSessionEntry(stored, ref) : undefined,
            expiredEntry: sessions.expiredEntries.find((entry) => entry.key === key)
        };
    }
}

const NO_ENTRY_READ: RuntimeStateEntryRead<ClientSession> = { value: undefined, expiredEntry: undefined };

const CONNECTED_SESSION_FIELDS = {
    status: 'active',
    disconnectedAtEpochMs: null
} as const satisfies Partial<Record<keyof ClientSession, string | null>>;

const CLIENT_STATE_NAMESPACES: ReadonlySet<string> = new Set([
    CLIENT_STATE_PRINCIPALS_NAMESPACE,
    CLIENT_STATE_INSTANCES_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE,
    CLIENT_STATE_IDEMPOTENT_NAMESPACE
]);

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
