import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import {
    isRuntimeStateReadBatchRepositoryLike,
    type RuntimeStateReadBatchSelector
} from '../../../runtime-state/RuntimeStateReadBatch.ts';
import {
    resolveRuntimeStateReadBatchLiveValues,
    type RuntimeStateReadBatchLiveSelection
} from '../../../runtime-state/RuntimeStateReadBatchLiveValues.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/RuntimeStateRepository.ts';
import type { GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
import {
    GROUPS_NAMESPACE,
    IDEMPOTENT_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from './group-state-storage-keys.ts';

export type GroupStateMutationExactReadInput = Readonly<{
    aggregateRef: GroupRef;
    includeGroup: boolean;
    includePresenceSummary: boolean;
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

export type GroupStateMutationExactReadResult =
    | Readonly<{ status: 'fallback'; }>
    | Readonly<{
        status: 'stable';
        groups: readonly RuntimeStateEntryValue<Group>[];
        expiredGroupEntry: RuntimeStateEntry | null;
        presenceSummaries: readonly RuntimeStateEntryValue<GroupPresenceSummary>[];
        idempotency: readonly ExactEntry<string, GroupMutationIdempotencyRecord>[];
        members: readonly ExactEntry<string, GroupMember>[];
        presenceSessions: readonly ExactEntry<string, GroupPresenceSession>[];
        admissions: readonly ExactEntry<string, GroupPresenceAdmission>[];
    }>;

export type GroupStateMutationExactReadDecoders = Readonly<{
    group(entry: RuntimeStateEntryValue<unknown>): RuntimeStateEntryValue<Group>;
    presenceSummary(
        entry: RuntimeStateEntryValue<unknown>
    ): RuntimeStateEntryValue<GroupPresenceSummary>;
    idempotency(
        requestId: string,
        entry: RuntimeStateEntryValue<unknown>
    ): RuntimeStateEntryValue<GroupMutationIdempotencyRecord>;
    member(
        principalId: string,
        entry: RuntimeStateEntryValue<unknown>
    ): RuntimeStateEntryValue<GroupMember>;
    presenceSession(
        sessionId: string,
        entry: RuntimeStateEntryValue<unknown>
    ): RuntimeStateEntryValue<GroupPresenceSession>;
    admission(
        principalId: string,
        entry: RuntimeStateEntryValue<unknown>
    ): RuntimeStateEntryValue<GroupPresenceAdmission>;
}>;

type ReadSlot =
    | Readonly<{ kind: 'group'; }>
    | Readonly<{ kind: 'presence-summary'; }>
    | Readonly<{ kind: 'idempotency'; identity: string; }>
    | Readonly<{ kind: 'member'; identity: string; }>
    | Readonly<{ kind: 'presence'; identity: string; }>
    | Readonly<{ kind: 'admission'; identity: string; }>;

interface ExactReadAccumulator {
    readonly status: 'stable';
    readonly groups: RuntimeStateEntryValue<Group>[];
    expiredGroupEntry: RuntimeStateEntry | null;
    readonly presenceSummaries: RuntimeStateEntryValue<GroupPresenceSummary>[];
    readonly idempotency: ExactEntry<string, GroupMutationIdempotencyRecord>[];
    readonly members: ExactEntry<string, GroupMember>[];
    readonly presenceSessions: ExactEntry<string, GroupPresenceSession>[];
    readonly admissions: ExactEntry<string, GroupPresenceAdmission>[];
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

export async function readGroupStateMutationExactEntries(
    repository: RuntimeStateRepositoryLike,
    input: GroupStateMutationExactReadInput,
    toLiveEntryValue: (
        namespace: string,
        entry: RuntimeStateEntry
    ) => Promise<RuntimeStateEntryValue<unknown> | undefined>,
    decoders: GroupStateMutationExactReadDecoders
): Promise<GroupStateMutationExactReadResult> {
    const requestIds = requireUniqueDenseStrings(input.requestIds, 'request IDs');
    const memberIds = requireUniqueDenseStrings(input.memberPrincipalIds, 'member principal IDs');
    const sessionIds = requireUniqueDenseStrings(input.presenceSessionIds, 'presence session IDs');
    const admissionIds = requireUniqueDenseStrings(
        input.admissionPrincipalIds,
        'admission principal IDs'
    );
    const { selectors, slots } = createSelectors(input, {
        requestIds,
        memberIds,
        sessionIds,
        admissionIds
    });
    if (!isRuntimeStateReadBatchRepositoryLike(repository)) {
        return { status: 'fallback' };
    }
    const resolved = await resolveRuntimeStateReadBatchLiveValues(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        toLiveEntryValue
    );
    if (resolved.status === 'changed') {
        return { status: 'fallback' };
    }
    return toExactReadResult(slots, resolved.selections, decoders);
}

function toExactReadResult(
    slots: readonly ReadSlot[],
    selections: readonly RuntimeStateReadBatchLiveSelection<unknown>[],
    decoders: GroupStateMutationExactReadDecoders
): Extract<GroupStateMutationExactReadResult, { status: 'stable'; }> {
    const result: ExactReadAccumulator = {
        status: 'stable',
        groups: [],
        expiredGroupEntry: null,
        presenceSummaries: [],
        idempotency: [],
        members: [],
        presenceSessions: [],
        admissions: []
    };
    slots.forEach((slot, index) => {
        const selection = selections[index];
        const entry = selection.entries[0];
        switch (slot.kind) {
            case 'group':
                if (entry) {
                    result.groups.push(decoders.group(entry));
                }
                result.expiredGroupEntry = selection.expiredEntries[0] ?? null;
                break;
            case 'presence-summary':
                if (entry) {
                    result.presenceSummaries.push(decoders.presenceSummary(entry));
                }
                break;
            case 'idempotency':
                result.idempotency.push({
                    identity: slot.identity,
                    entry: entry ? decoders.idempotency(slot.identity, entry) : null,
                    expiredEntry: selection.expiredEntries[0] ?? null
                });
                break;
            case 'member':
                result.members.push({
                    identity: slot.identity,
                    entry: entry ? decoders.member(slot.identity, entry) : null,
                    expiredEntry: selection.expiredEntries[0] ?? null
                });
                break;
            case 'presence':
                result.presenceSessions.push({
                    identity: slot.identity,
                    entry: entry ? decoders.presenceSession(slot.identity, entry) : null,
                    expiredEntry: selection.expiredEntries[0] ?? null
                });
                break;
            case 'admission':
                result.admissions.push({
                    identity: slot.identity,
                    entry: entry ? decoders.admission(slot.identity, entry) : null,
                    expiredEntry: selection.expiredEntries[0] ?? null
                });
        }
    });
    return result;
}

function createSelectors(
    input: GroupStateMutationExactReadInput,
    identities: ExactReadIdentities
): ExactReadSelectorSet {
    const singleton = createSingletonSelectors(input);
    const identity = createIdentitySelectors(input, identities);
    return {
        selectors: [...singleton.selectors, ...identity.selectors],
        slots: [...singleton.slots, ...identity.slots]
    };
}

function createSingletonSelectors(input: GroupStateMutationExactReadInput): ExactReadSelectorSet {
    const selectors: RuntimeStateReadBatchSelector[] = [];
    const slots: ReadSlot[] = [];
    const add = (selector: RuntimeStateReadBatchSelector, slot: ReadSlot): void => {
        selectors.push(selector);
        slots.push(slot);
    };
    const groupKey = groupStateGroupStorageKey(input.aggregateRef);
    if (input.includeGroup) {
        add(
            { selectorId: 'group', kind: 'key', namespace: GROUPS_NAMESPACE, key: groupKey },
            { kind: 'group' }
        );
    }
    if (input.includePresenceSummary) {
        add(
            {
                selectorId: 'presence-summary',
                kind: 'key',
                namespace: PRESENCE_SUMMARIES_NAMESPACE,
                key: groupKey
            },
            { kind: 'presence-summary' }
        );
    }
    return { selectors, slots };
}

function createIdentitySelectors(
    input: GroupStateMutationExactReadInput,
    identities: ExactReadIdentities
): ExactReadSelectorSet {
    const selectors: RuntimeStateReadBatchSelector[] = [];
    const slots: ReadSlot[] = [];
    const add = (selector: RuntimeStateReadBatchSelector, slot: ReadSlot): void => {
        selectors.push(selector);
        slots.push(slot);
    };
    identities.requestIds.forEach((requestId, index) =>
        add(
            {
                selectorId: `idempotency:${index}`,
                kind: 'key',
                namespace: IDEMPOTENT_NAMESPACE,
                key: groupStateIdempotencyStorageKey(input.aggregateRef, requestId)
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
                key: groupStateMemberStorageKey({ ...input.aggregateRef, principalId })
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
                key: groupStatePresenceSessionStorageKey({ ...input.aggregateRef, sessionId })
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
                key: groupStatePresenceAdmissionStorageKey({
                    ...input.aggregateRef,
                    principalId
                })
            },
            { kind: 'admission', identity: principalId }
        )
    );
    return { selectors, slots };
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
