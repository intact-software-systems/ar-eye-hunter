import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import {
    resolveRuntimeStateReadBatchLiveValues,
    type RuntimeStateReadBatchLiveSelection
} from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import { type RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE, authSessionKey } from '../../auth/persistence/auth-storage-keys.ts';
import {
    decodePersistedAuthSession,
    type PersistedAuthSession
} from '../../auth/persistence/persisted-auth-session.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';
import {
    GROUP_LIFECYCLE_POLICIES_NAMESPACE,
    type GroupLifecyclePolicyRead
} from './group-lifecycle-policy-repository.ts';
import {
    GROUPS_NAMESPACE,
    IDEMPOTENT_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';
import { groupStateIdempotencyStorageKey } from './idempotency/group-idempotency-storage-key.ts';
import { groupStateMemberStorageKey } from './membership/group-membership-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from './presence/group-presence-storage-keys.ts';
import { toGroupStateAuthoritySelectors, type GroupStateAuthorityBatchRead } from './read-group-state-authority.ts';

export type GroupStateMutationExactReadInput = Readonly<{
    aggregateRef: GroupRef;
    includeGroup: boolean;
    includePresenceSummary: boolean;
    includeLifecyclePolicy: boolean;
    /** The whole roster and every session as well, so the group's snapshot comes from the same statement. */
    includeGroupSnapshot: boolean;
    /** The authenticated session the attempt re-checks, selected by the same statement; null for internal authority. */
    authSessionId: string | null;
    requestIds: readonly string[];
    memberPrincipalIds: readonly string[];
    presenceSessionIds: readonly string[];
    admissionPrincipalIds: readonly string[];
}>;

type ExactEntry<Identity extends string, Value> = Readonly<{
    identity: Identity;
    entry: RuntimeStateEntryValue<Value> | null;
    expiredEntry: RuntimeStateEntry | null;
}>;

/** The group snapshot an exact read assembled from its own rows; unread when the input did not ask for it. */
export type GroupStateMutationExactSnapshot =
    | Readonly<{ status: 'unread'; }>
    | Readonly<{ status: 'read'; snapshot: GroupSnapshot | undefined; }>;

/** The authenticated session row an exact read selected; unread when the input named no session. */
export type GroupStateMutationExactAuthSession =
    | Readonly<{ status: 'unread'; }>
    | Readonly<{ status: 'read'; session: PersistedAuthSession | undefined; }>;

/** The rows one exact read selected, all from the same statement. */
export interface GroupStateMutationExactEntries {
    readonly status: 'stable';
    readonly groups: readonly RuntimeStateEntryValue<Group>[];
    readonly expiredGroupEntry: RuntimeStateEntry | null;
    readonly presenceSummaries: readonly RuntimeStateEntryValue<GroupPresenceSummary>[];
    readonly idempotency: readonly ExactEntry<string, GroupMutationIdempotencyRecord>[];
    readonly members: readonly ExactEntry<string, GroupMember>[];
    readonly presenceSessions: readonly ExactEntry<string, GroupPresenceSession>[];
    readonly admissions: readonly ExactEntry<string, GroupPresenceAdmission>[];
    readonly lifecyclePolicy: GroupLifecyclePolicyRead | null;
    readonly groupSnapshot: GroupStateMutationExactSnapshot;
    readonly authSession: GroupStateMutationExactAuthSession;
}

export type GroupStateMutationExactReadResult =
    | Readonly<{ status: 'concurrent-change'; }>
    | GroupStateMutationExactEntries;

export type GroupStateMutationExactReadDecoders = Readonly<{
    group(entry: RuntimeStateEntryValue<JsonWireValue>): RuntimeStateEntryValue<Group>;
    presenceSummary(
        entry: RuntimeStateEntryValue<JsonWireValue>
    ): RuntimeStateEntryValue<GroupPresenceSummary>;
    idempotency(
        requestId: string,
        entry: RuntimeStateEntryValue<JsonWireValue>
    ): RuntimeStateEntryValue<GroupMutationIdempotencyRecord>;
    member(
        principalId: string,
        entry: RuntimeStateEntryValue<JsonWireValue>
    ): RuntimeStateEntryValue<GroupMember>;
    presenceSession(
        sessionId: string,
        entry: RuntimeStateEntryValue<JsonWireValue>
    ): RuntimeStateEntryValue<GroupPresenceSession>;
    admission(
        principalId: string,
        entry: RuntimeStateEntryValue<JsonWireValue>
    ): RuntimeStateEntryValue<GroupPresenceAdmission>;
    lifecyclePolicy(value: JsonWireValue | undefined): GroupLifecyclePolicyRead;
    authSession(
        sessionId: string,
        entry: RuntimeStateEntryValue<JsonWireValue>
    ): RuntimeStateEntryValue<PersistedAuthSession>;
    groupSnapshot(rows: Extract<GroupStateAuthorityBatchRead, { status: 'stable'; }>): GroupSnapshot | undefined;
}>;

type IdentitySlotKind = 'idempotency' | 'member' | 'presence' | 'admission';

type ReadSlot =
    | Readonly<{ kind: 'group' | 'presence-summary' | 'lifecycle-policy' | 'roster' | 'sessions' | 'auth-session'; }>
    | Readonly<{ kind: IdentitySlotKind; identity: string; }>;

interface SlotSelection {
    readonly slot: ReadSlot;
    readonly selection: RuntimeStateReadBatchLiveSelection<JsonWireValue>;
}

interface ExactReadIdentities {
    readonly requestIds: readonly string[];
    readonly memberIds: readonly string[];
    readonly sessionIds: readonly string[];
    readonly admissionIds: readonly string[];
}

interface ExactReadSelectorSet {
    readonly selectors: readonly RuntimeStateReadBatchSelector[];
    readonly slots: readonly ReadSlot[];
}

type ExactReadSelectorSink = (selector: RuntimeStateReadBatchSelector, slot: ReadSlot) => void;

export async function readGroupStateMutationExactEntries(
    repository: RuntimeStateRepositoryLike,
    input: GroupStateMutationExactReadInput,
    toLiveEntryValue: (
        namespace: string,
        entry: RuntimeStateEntry
    ) => Promise<RuntimeStateEntryValue<JsonWireValue> | undefined>,
    decoders: GroupStateMutationExactReadDecoders
): Promise<GroupStateMutationExactReadResult> {
    const { selectors, slots } = createSelectors(input, {
        requestIds: requireUniqueDenseStrings(input.requestIds, 'request IDs'),
        memberIds: requireUniqueDenseStrings(input.memberPrincipalIds, 'member principal IDs'),
        sessionIds: requireUniqueDenseStrings(input.presenceSessionIds, 'presence session IDs'),
        admissionIds: requireUniqueDenseStrings(input.admissionPrincipalIds, 'admission principal IDs')
    });
    const resolved = await resolveRuntimeStateReadBatchLiveValues(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        toLiveEntryValue
    );
    if (resolved.status === 'changed') {
        return { status: 'concurrent-change' };
    }
    const selections = slots.map((slot, index) => ({ slot, selection: resolved.selections[index] }));
    return toExactReadResult(input, selections, decoders);
}

function toExactReadResult(
    input: GroupStateMutationExactReadInput,
    selections: readonly SlotSelection[],
    decoders: GroupStateMutationExactReadDecoders
): GroupStateMutationExactEntries {
    const group = findSlotSelection(selections, 'group');
    const summary = findSlotSelection(selections, 'presence-summary');
    return {
        status: 'stable',
        groups: (group?.entries ?? []).map((entry) => decoders.group(entry)),
        expiredGroupEntry: group?.expiredEntries[0] ?? null,
        presenceSummaries: (summary?.entries ?? []).map((entry) => decoders.presenceSummary(entry)),
        idempotency: toExactEntries(selections, 'idempotency', decoders.idempotency),
        members: toExactEntries(selections, 'member', decoders.member),
        presenceSessions: toExactEntries(selections, 'presence', decoders.presenceSession),
        admissions: toExactEntries(selections, 'admission', decoders.admission),
        lifecyclePolicy: input.includeLifecyclePolicy
            ? decoders.lifecyclePolicy(findSlotSelection(selections, 'lifecycle-policy')?.entries[0]?.value)
            : null,
        groupSnapshot: input.includeGroupSnapshot
            ? {
                status: 'read',
                snapshot: decoders.groupSnapshot({
                    status: 'stable',
                    group: group?.entries[0],
                    members: findSlotSelection(selections, 'roster')?.entries ?? [],
                    summary: summary?.entries[0],
                    sessions: findSlotSelection(selections, 'sessions')?.entries ?? []
                })
            }
            : { status: 'unread' },
        authSession: input.authSessionId === null
            ? { status: 'unread' }
            : {
                status: 'read',
                session: toAuthSession(input.authSessionId, findSlotSelection(selections, 'auth-session'), decoders)
            }
    };
}

function toAuthSession(
    sessionId: string,
    selection: RuntimeStateReadBatchLiveSelection<JsonWireValue> | undefined,
    decoders: GroupStateMutationExactReadDecoders
): PersistedAuthSession | undefined {
    const entry = selection?.entries[0];
    return entry === undefined ? undefined : decoders.authSession(sessionId, entry).value;
}

function findSlotSelection(
    selections: readonly SlotSelection[],
    kind: ReadSlot['kind']
): RuntimeStateReadBatchLiveSelection<JsonWireValue> | undefined {
    return selections.find(({ slot }) => slot.kind === kind)?.selection;
}

function toExactEntries<Value>(
    selections: readonly SlotSelection[],
    kind: IdentitySlotKind,
    decode: (identity: string, entry: RuntimeStateEntryValue<JsonWireValue>) => RuntimeStateEntryValue<Value>
): ExactEntry<string, Value>[] {
    return selections.flatMap(({ slot, selection }) => {
        if (slot.kind !== kind || !('identity' in slot)) {
            return [];
        }
        const entry = selection.entries[0];
        return [{
            identity: slot.identity,
            entry: entry ? decode(slot.identity, entry) : null,
            expiredEntry: selection.expiredEntries[0] ?? null
        }];
    });
}

function createSelectors(
    input: GroupStateMutationExactReadInput,
    identities: ExactReadIdentities
): ExactReadSelectorSet {
    const selectors: RuntimeStateReadBatchSelector[] = [];
    const slots: ReadSlot[] = [];
    const add: ExactReadSelectorSink = (selector, slot) => {
        selectors.push(selector);
        slots.push(slot);
    };
    addAggregateSelectors(input, add);
    addIdentitySelectors(input, identities, add);
    if (input.authSessionId !== null) {
        add(
            {
                selectorId: 'auth-session',
                kind: 'key',
                namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                key: authSessionKey(input.authSessionId)
            },
            { kind: 'auth-session' }
        );
    }
    return { selectors, slots };
}

function addAggregateSelectors(input: GroupStateMutationExactReadInput, add: ExactReadSelectorSink): void {
    const groupKey = groupStateGroupStorageKey(input.aggregateRef);
    if (input.includeGroupSnapshot) {
        if (!input.includeGroup || !input.includePresenceSummary) {
            throw new TypeError('A group snapshot read includes the group and its presence summary');
        }
        const [group, roster, summary, sessions] = toGroupStateAuthoritySelectors(input.aggregateRef);
        add(group, { kind: 'group' });
        add(roster, { kind: 'roster' });
        add(summary, { kind: 'presence-summary' });
        add(sessions, { kind: 'sessions' });
    }
    else {
        if (input.includeGroup) {
            add({ selectorId: 'group', kind: 'key', namespace: GROUPS_NAMESPACE, key: groupKey }, { kind: 'group' });
        }
        if (input.includePresenceSummary) {
            add(
                { selectorId: 'presence-summary', kind: 'key', namespace: PRESENCE_SUMMARIES_NAMESPACE, key: groupKey },
                { kind: 'presence-summary' }
            );
        }
    }
    if (input.includeLifecyclePolicy) {
        add(
            {
                selectorId: 'lifecycle-policy',
                kind: 'key',
                namespace: GROUP_LIFECYCLE_POLICIES_NAMESPACE,
                key: groupKey
            },
            { kind: 'lifecycle-policy' }
        );
    }
}

function addIdentitySelectors(
    input: GroupStateMutationExactReadInput,
    identities: ExactReadIdentities,
    add: ExactReadSelectorSink
): void {
    const ref = input.aggregateRef;
    identities.requestIds.forEach((requestId, index) =>
        add(
            {
                selectorId: `idempotency:${index}`,
                kind: 'key',
                namespace: IDEMPOTENT_NAMESPACE,
                key: groupStateIdempotencyStorageKey(ref, requestId)
            },
            { kind: 'idempotency', identity: requestId }
        )
    );
    identities.memberIds.forEach((principalId, index) =>
        add(
            {
                selectorId: `member:${index}`,
                kind: 'key',
                namespace: MEMBERS_NAMESPACE,
                key: groupStateMemberStorageKey({ ...ref, principalId })
            },
            { kind: 'member', identity: principalId }
        )
    );
    identities.sessionIds.forEach((sessionId, index) =>
        add(
            {
                selectorId: `presence:${index}`,
                kind: 'key',
                namespace: SESSIONS_NAMESPACE,
                key: groupStatePresenceSessionStorageKey({ ...ref, sessionId })
            },
            { kind: 'presence', identity: sessionId }
        )
    );
    identities.admissionIds.forEach((principalId, index) =>
        add(
            {
                selectorId: `admission:${index}`,
                kind: 'key',
                namespace: PRESENCE_ADMISSIONS_NAMESPACE,
                key: groupStatePresenceAdmissionStorageKey({ ...ref, principalId })
            },
            { kind: 'admission', identity: principalId }
        )
    );
}

function requireUniqueDenseStrings(input: readonly string[], label: string): readonly string[] {
    if (!Array.isArray(input)) {
        throw new TypeError(`${label} must be an array`);
    }
    const values = new Set<string>();
    for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) {
            throw new TypeError(`${label} must be dense`);
        }
        const value = input[index];
        if (typeof value !== 'string' || value.length === 0) {
            throw new TypeError(`${label} must contain non-empty strings`);
        }
        if (values.has(value)) {
            throw new TypeError(`${label} must be unique`);
        }
        values.add(value);
    }
    return [...values];
}
