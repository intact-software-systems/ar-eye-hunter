import {
    requireEpoch,
    requireExactKeys,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import { decodeStateScope, type StateScope } from '@shared/api/state-types.ts';
import { decodeViewWatchFamily, type ViewWatchFamily } from '@shared/api/views/view-watch.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { readRuntimeStateKeySelections } from '../../runtime-state/read-batch/read-runtime-state-key-selections.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import { decodeAuthSessionBySessionIdEntry } from '../auth/persistence/auth-session-persistence.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE, authSessionKey } from '../auth/persistence/auth-storage-keys.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import {
    groupStateScopeStorageKey
} from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';

export interface ViewWatchIdentity extends StateScope {
    readonly sessionId: string;
    readonly family: ViewWatchFamily;
}

/** The selected preview is interest on an issued session; no group membership or discovery intent is implied. */
export interface ViewWatchResource extends StateScope {
    readonly family: ViewWatchFamily;
    readonly resourceId: string;
}

export interface ViewWatchRegistration extends ViewWatchIdentity {
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly connectionGenerationId: string;
    readonly registrationId: string;
    readonly resourceId: string;
    readonly sessionIssuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export const VIEW_WATCH_SLOTS_NAMESPACE = 'view-watch:slots';
export const VIEW_WATCH_RESOURCES_NAMESPACE = 'view-watch:resources';

export function viewWatchSlotKey(identity: ViewWatchIdentity): string {
    requireString(identity.sessionId, 'Watch session');
    return `session=${encodeURIComponent(identity.sessionId)}:${groupStateScopeStorageKey(identity)}:family=${
        decodeViewWatchFamily(identity.family)
    }`;
}

export function viewWatchResourcePrefix(ref: ViewWatchResource): string {
    return `${groupStateScopeStorageKey(ref)}:family=${decodeViewWatchFamily(ref.family)}:resource=${
        encodeURIComponent(ref.resourceId)
    }:session=`;
}

export function viewWatchResourceKey(registration: ViewWatchRegistration): string {
    return viewWatchResourcePrefix(registration) + encodeURIComponent(registration.sessionId);
}

export interface ViewWatchSessionRead {
    readonly auth: RuntimeStateEntryValue<PersistedAuthSession> | null;
    readonly previous: RuntimeStateEntryValue<ViewWatchRegistration> | null;
}

export class ViewWatchRepository {
    private readonly repository: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>;

    constructor(repository: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>) {
        this.repository = repository;
    }

    /** Auth and slot share a snapshot, so even an absent-slot clear fences concurrent registration. */
    async readSession(identity: ViewWatchIdentity): Promise<ViewWatchSessionRead> {
        const [auth, previous] = await readRuntimeStateKeySelections(this.repository, [
            {
                selectorId: 'auth',
                kind: 'key',
                namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                key: authSessionKey(identity.sessionId)
            },
            { selectorId: 'slot', kind: 'key', namespace: VIEW_WATCH_SLOTS_NAMESPACE, key: viewWatchSlotKey(identity) }
        ]);
        return {
            auth: auth === undefined ? null : decodeAuthSessionBySessionIdEntry(identity.sessionId, {
                entry: auth,
                value: decodeJsonWireValue(JSON.parse(auth.value), 'View watch auth')
            }),
            previous: previous === undefined ? null : decodeViewWatchEntry(previous, 'slot')
        };
    }

    async readSlot(identity: ViewWatchIdentity): Promise<RuntimeStateEntryValue<ViewWatchRegistration> | null> {
        const key = viewWatchSlotKey(identity);
        const entry = await this.repository.findEntry(VIEW_WATCH_SLOTS_NAMESPACE, key);
        if (entry !== undefined && entry.key !== key) {
            throw new TypeError('Watch slot read returned another key');
        }
        return entry === undefined ? null : decodeViewWatchEntry(entry, 'slot');
    }

    /** Replacing or clearing the predecessor between reads is an ordinary optimistic conflict. */
    async readResource(
        registration: ViewWatchRegistration
    ): Promise<RuntimeStateEntryValue<ViewWatchRegistration> | null> {
        const [slot, resource] = await readRuntimeStateKeySelections(this.repository, [
            {
                selectorId: 'slot',
                kind: 'key',
                namespace: VIEW_WATCH_SLOTS_NAMESPACE,
                key: viewWatchSlotKey(registration)
            },
            {
                selectorId: 'resource',
                kind: 'key',
                namespace: VIEW_WATCH_RESOURCES_NAMESPACE,
                key: viewWatchResourceKey(registration)
            }
        ]);
        if (slot === undefined || !jsonEquals(decodeViewWatchEntry(slot, 'slot').value, registration)) {
            throw new RuntimeStateWriteConflictError();
        }
        return resource === undefined ? null : decodeViewWatchEntry(resource, 'resource');
    }

    async listForResource(ref: ViewWatchResource): Promise<readonly RuntimeStateEntryValue<ViewWatchRegistration>[]> {
        return await this.readPrefix(VIEW_WATCH_RESOURCES_NAMESPACE, viewWatchResourcePrefix(ref), 'resource');
    }

    private async readPrefix(
        namespace: string,
        keyPrefix: string,
        kind: 'slot' | 'resource'
    ): Promise<readonly RuntimeStateEntryValue<ViewWatchRegistration>[]> {
        const selections = await this.repository.readRuntimeStateBatch([{
            selectorId: 'watches',
            kind: 'prefix',
            namespace,
            keyPrefix
        }]);
        if (
            selections.length !== 1 || selections[0].selectorId !== 'watches' ||
            selections[0].entries.some((entry) => !entry.key.startsWith(keyPrefix))
        ) {
            throw new TypeError('View watch selection differs from its requested prefix');
        }
        return selections[0].entries.map((entry) => decodeViewWatchEntry(entry, kind));
    }
}

export function decodeViewWatchEntry(
    entry: RuntimeStateEntry,
    kind: 'slot' | 'resource'
): RuntimeStateEntryValue<ViewWatchRegistration> {
    const record = requireRecord(JSON.parse(entry.value), 'Stored view watch');
    requireExactKeys(record, [
        'applicationId',
        'workspaceId',
        'sessionId',
        'family',
        'principalId',
        'clientInstanceId',
        'connectionGenerationId',
        'registrationId',
        'resourceId',
        'sessionIssuedAtEpochMs',
        'expiresAtEpochMs'
    ], 'Stored view watch');
    const scope = decodeStateScope({ applicationId: record.applicationId, workspaceId: record.workspaceId });
    for (
        const key of [
            'sessionId',
            'principalId',
            'clientInstanceId',
            'connectionGenerationId',
            'registrationId',
            'resourceId'
        ]
    ) {
        requireString(record[key], `Watch ${key}`);
    }
    requireEpoch(record.sessionIssuedAtEpochMs, 'Watch session issued time');
    requireEpoch(record.expiresAtEpochMs, 'Watch expiry');
    if (record.expiresAtEpochMs <= record.sessionIssuedAtEpochMs) {
        throw new TypeError('Stored view watch family or lifetime is invalid');
    }
    const value: ViewWatchRegistration = {
        ...scope,
        family: decodeViewWatchFamily(record.family),
        sessionId: record.sessionId as string,
        principalId: record.principalId as string,
        clientInstanceId: record.clientInstanceId as string,
        connectionGenerationId: record.connectionGenerationId as string,
        registrationId: record.registrationId as string,
        resourceId: record.resourceId as string,
        sessionIssuedAtEpochMs: record.sessionIssuedAtEpochMs,
        expiresAtEpochMs: record.expiresAtEpochMs
    };
    if (
        entry.key !== (kind === 'slot' ? viewWatchSlotKey(value) : viewWatchResourceKey(value)) ||
        entry.expireAtTimestamp !== value.expiresAtEpochMs
    ) {
        throw new TypeError('Stored view watch differs from its exact slot or auth lifetime');
    }
    return { entry, value };
}
