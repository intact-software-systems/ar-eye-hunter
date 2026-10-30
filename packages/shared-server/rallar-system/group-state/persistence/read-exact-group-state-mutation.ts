import type { ClientSession } from '@shared/api/client-types.ts';
import type { GroupPublicationGrant } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';

import type { RuntimeStateReadBatchLiveSelection } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import { type RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE, authSessionKey } from '../../auth/persistence/auth-storage-keys.ts';
import type { PersistedAuthSession } from '../../auth/persistence/persisted-auth-session.ts';
import { clientStatePrincipalStorageKey } from '../../client-state/persistence/client-state-principal-storage-key.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '../../client-state/persistence/client-state-runtime-namespaces.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';
import { isRetiredGroupIdentity, type RetiredGroupIdentity } from './aggregate/retired-group-identity.ts';
import {
    GROUP_LIFECYCLE_POLICIES_NAMESPACE,
    type GroupLifecyclePolicyRead
} from './group-lifecycle-policy-repository.ts';
import { toGroupStateReadBatchLiveSelections } from './group-state-persistence-contracts.ts';
import {
    GROUPS_NAMESPACE,
    IDEMPOTENT_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    PUBLICATION_GRANTS_NAMESPACE,
    SESSIONS_NAMESPACE,
    SUBSCRIPTIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';
import { groupStateIdempotencyStorageKey } from './idempotency/group-idempotency-storage-key.ts';
import { groupStateMemberStorageKey } from './membership/group-membership-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from './presence/group-presence-storage-keys.ts';
import {
    canonicalStoredPublicationGrant,
    canonicalStoredPublicationGrants
} from './publication/group-publication-grant-codec.ts';
import { groupStatePublicationGrantStorageKey } from './publication/group-publication-grant-storage-key.ts';
import { toGroupStateAuthoritySelectors, type GroupStateAuthorityBatchRead } from './read-group-state-authority.ts';
import {
    canonicalStoredActiveClientSessions,
    canonicalStoredPrincipalTopicSubscriptions,
    canonicalStoredTopicSubscription
} from './subscription/group-topic-subscription-codec.ts';
import { groupStateTopicSubscriptionStorageKey } from './subscription/group-topic-subscription-storage-key.ts';

export interface GroupStateMutationExactReadInput {
    readonly aggregateRef: GroupRef;
    readonly includeGroup: boolean;
    readonly includePresenceSummary: boolean;
    readonly includeLifecyclePolicy: boolean;
    /** The whole roster and every session as well, so the group's snapshot comes from the same statement. */
    readonly includeGroupSnapshot: boolean;
    /** The authenticated session the attempt re-checks, selected by the same statement; null for internal authority. */
    readonly authSessionId: string | null;
    readonly requestIds: readonly string[];
    readonly memberPrincipalIds: readonly string[];
    readonly presenceSessionIds: readonly string[];
    readonly admissionPrincipalIds: readonly string[];
    readonly publicationGrantPrincipalIds: readonly string[];
    /** The (session, topic) subscription rows a subscribe or unsubscribe guards. */
    readonly topicSubscriptions: readonly GroupTopicSubscriptionIdentity[];
    /** The client-state sessions whose live generation a subscribe or unsubscribe compares, one selector each. */
    readonly clientSessions: readonly GroupClientSessionIdentity[];
    /** The principals whose every subscription row in the group a revoke of subscribe or a departure deletes. */
    readonly subscriptionPrincipalIds: readonly string[];
}

export interface GroupTopicSubscriptionIdentity {
    readonly sessionId: string;
    readonly topicId: string;
}

export interface GroupClientSessionIdentity {
    readonly principalId: string;
    readonly sessionId: string;
}

interface ExactEntry<Identity extends string, Value> {
    readonly identity: Identity;
    readonly entry: RuntimeStateEntryValue<Value> | null;
    readonly expiredEntry: RuntimeStateEntry | null;
}

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
    readonly groups: readonly RuntimeStateEntryValue<Group>[];
    readonly retiredGroup: RetiredGroupIdentity | null;
    readonly expiredGroupEntry: RuntimeStateEntry | null;
    readonly presenceSummaries: readonly RuntimeStateEntryValue<GroupPresenceSummary>[];
    readonly idempotency: readonly ExactEntry<string, GroupMutationIdempotencyRecord>[];
    readonly members: readonly ExactEntry<string, GroupMember>[];
    readonly presenceSessions: readonly ExactEntry<string, GroupPresenceSession>[];
    readonly admissions: readonly ExactEntry<string, GroupPresenceAdmission>[];
    readonly publicationGrants: readonly ExactEntry<string, GroupPublicationGrant>[];
    /** Keyed by the row's storage key. */
    readonly topicSubscriptions: readonly ExactEntry<string, GroupTopicSubscription>[];
    readonly clientSessions: readonly Readonly<{
        identity: GroupClientSessionIdentity;
        entries: readonly RuntimeStateEntryValue<ClientSession>[];
    }>[];
    readonly principalSubscriptions: readonly Readonly<{
        principalId: string;
        entries: readonly RuntimeStateEntryValue<GroupTopicSubscription>[];
    }>[];
    readonly lifecyclePolicy: GroupLifecyclePolicyRead | null;
    readonly groupSnapshot: GroupStateMutationExactSnapshot;
    readonly authSession: GroupStateMutationExactAuthSession;
}

export interface GroupStateMutationExactReadDecoders {
    group(entry: RuntimeStateEntryValue<JsonWireValue>): RuntimeStateEntryValue<Group | RetiredGroupIdentity>;
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
    groupSnapshot(rows: GroupStateAuthorityBatchRead): GroupSnapshot | undefined;
}

type IdentitySlotKind = 'idempotency' | 'member' | 'presence' | 'admission' | 'grant' | 'subscription';

type AggregateSlotKind =
    | 'group'
    | 'presence-summary'
    | 'lifecycle-policy'
    | 'roster'
    | 'sessions'
    | 'publication-grants'
    | 'auth-session';

type ReadSlot =
    | Readonly<{ kind: AggregateSlotKind; }>
    | Readonly<{ kind: IdentitySlotKind; identity: string; }>
    | Readonly<{ kind: 'client-session'; identity: GroupClientSessionIdentity; }>
    | Readonly<{ kind: 'principal-subscriptions'; identity: string; }>;

interface SlotSelection {
    readonly slot: ReadSlot;
    readonly selection: RuntimeStateReadBatchLiveSelection<JsonWireValue>;
}

interface ExactReadIdentities {
    readonly requestIds: readonly string[];
    readonly memberIds: readonly string[];
    readonly sessionIds: readonly string[];
    readonly admissionIds: readonly string[];
    readonly grantIds: readonly string[];
    readonly subscriptionKeys: readonly string[];
    readonly clientSessions: readonly GroupClientSessionIdentity[];
    readonly subscriptionPrincipalIds: readonly string[];
}

interface ExactReadSelectorSet {
    readonly selectors: readonly RuntimeStateReadBatchSelector[];
    readonly slots: readonly ReadSlot[];
}

type ExactReadSelectorSink = (selector: RuntimeStateReadBatchSelector, slot: ReadSlot) => void;

export interface GroupStateMutationExactReadRequest {
    readonly repository: RuntimeStateRepositoryLike;
    readonly input: GroupStateMutationExactReadInput;
    readonly observedAtEpochMs: number;
    readonly decoders: GroupStateMutationExactReadDecoders;
}

export async function readGroupStateMutationExactEntries({
    repository,
    input,
    observedAtEpochMs,
    decoders
}: GroupStateMutationExactReadRequest): Promise<GroupStateMutationExactEntries> {
    const { selectors, slots } = createSelectors(input, {
        requestIds: requireUniqueDenseStrings(input.requestIds, 'request IDs'),
        memberIds: requireUniqueDenseStrings(input.memberPrincipalIds, 'member principal IDs'),
        sessionIds: requireUniqueDenseStrings(input.presenceSessionIds, 'presence session IDs'),
        admissionIds: requireUniqueDenseStrings(input.admissionPrincipalIds, 'admission principal IDs'),
        grantIds: requireUniqueDenseStrings(input.publicationGrantPrincipalIds, 'publication grant principal IDs'),
        subscriptionKeys: requireUniqueDenseStrings(
            input.topicSubscriptions.map(({ sessionId, topicId }) =>
                groupStateTopicSubscriptionStorageKey(input.aggregateRef, sessionId, topicId)
            ),
            'topic subscription keys'
        ),
        clientSessions: input.clientSessions,
        subscriptionPrincipalIds: requireUniqueDenseStrings(
            input.subscriptionPrincipalIds,
            'subscription principal IDs'
        )
    });
    const liveSelections = toGroupStateReadBatchLiveSelections(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        observedAtEpochMs
    );
    const selections = slots.map((slot, index) => ({ slot, selection: liveSelections[index] }));
    return toExactReadResult(input, selections, decoders);
}

function toExactReadResult(
    input: GroupStateMutationExactReadInput,
    selections: readonly SlotSelection[],
    decoders: GroupStateMutationExactReadDecoders
): GroupStateMutationExactEntries {
    const group = findSlotSelection(selections, 'group');
    const summary = findSlotSelection(selections, 'presence-summary');
    const records = (group?.entries ?? []).map((entry) => decoders.group(entry));
    const retirement = records.find((entry) => isRetiredGroupIdentity(entry.value));
    return {
        groups: records.flatMap((entry) =>
            isRetiredGroupIdentity(entry.value) ? [] : [{ entry: entry.entry, value: entry.value }]
        ),
        retiredGroup: retirement && isRetiredGroupIdentity(retirement.value) ? retirement.value : null,
        expiredGroupEntry: group?.expiredEntries[0] ?? null,
        presenceSummaries: (summary?.entries ?? []).map((entry) => decoders.presenceSummary(entry)),
        idempotency: toExactEntries(selections, 'idempotency', decoders.idempotency),
        members: toExactEntries(selections, 'member', decoders.member),
        presenceSessions: toExactEntries(selections, 'presence', decoders.presenceSession),
        admissions: toExactEntries(selections, 'admission', decoders.admission),
        publicationGrants: toExactEntries(
            selections,
            'grant',
            (principalId, entry) => canonicalStoredPublicationGrant(entry, { ...input.aggregateRef, principalId })
        ),
        topicSubscriptions: toExactEntries(
            selections,
            'subscription',
            (_key, entry) => canonicalStoredTopicSubscription(entry, input.aggregateRef)
        ),
        clientSessions: selections.flatMap(({ slot, selection }) =>
            slot.kind === 'client-session'
                ? [{
                    identity: slot.identity,
                    entries: canonicalStoredActiveClientSessions(selection.entries, {
                        ...input.aggregateRef,
                        ...slot.identity
                    })
                }]
                : []
        ),
        principalSubscriptions: selections.flatMap(({ slot, selection }) =>
            slot.kind === 'principal-subscriptions'
                ? [{
                    principalId: slot.identity,
                    entries: canonicalStoredPrincipalTopicSubscriptions(selection.entries, {
                        ...input.aggregateRef,
                        principalId: slot.identity
                    })
                }]
                : []
        ),
        lifecyclePolicy: input.includeLifecyclePolicy
            ? decoders.lifecyclePolicy(findSlotSelection(selections, 'lifecycle-policy')?.entries[0]?.value)
            : null,
        groupSnapshot: input.includeGroupSnapshot
            ? {
                status: 'read',
                snapshot: decoders.groupSnapshot({
                    group: group?.entries[0],
                    members: findSlotSelection(selections, 'roster')?.entries ?? [],
                    summary: summary?.entries[0],
                    sessions: findSlotSelection(selections, 'sessions')?.entries ?? [],
                    publicationGrants: canonicalStoredPublicationGrants(
                        findSlotSelection(selections, 'publication-grants')?.entries ?? [],
                        input.aggregateRef
                    )
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
    addContainingSelectors(input.aggregateRef, identities, add);
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
        const [group, roster, summary, sessions, publicationGrants] = toGroupStateAuthoritySelectors(
            input.aggregateRef
        );
        add(group, { kind: 'group' });
        add(roster, { kind: 'roster' });
        add(summary, { kind: 'presence-summary' });
        add(sessions, { kind: 'sessions' });
        add(publicationGrants, { kind: 'publication-grants' });
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

interface ExactKeySelectorGroup {
    readonly kind: IdentitySlotKind;
    readonly namespace: string;
    readonly identities: readonly string[];
    readonly keys: readonly string[];
}

function addIdentitySelectors(
    input: GroupStateMutationExactReadInput,
    identities: ExactReadIdentities,
    add: ExactReadSelectorSink
): void {
    for (const group of toExactKeySelectorGroups(input.aggregateRef, identities)) {
        addKeySelectors(group, add);
    }
}

function toExactKeySelectorGroups(ref: GroupRef, identities: ExactReadIdentities): readonly ExactKeySelectorGroup[] {
    const { requestIds, memberIds, sessionIds, admissionIds, grantIds, subscriptionKeys } = identities;
    return [
        {
            kind: 'idempotency',
            namespace: IDEMPOTENT_NAMESPACE,
            identities: requestIds,
            keys: requestIds.map((requestId) => groupStateIdempotencyStorageKey(ref, requestId))
        },
        {
            kind: 'member',
            namespace: MEMBERS_NAMESPACE,
            identities: memberIds,
            keys: memberIds.map((principalId) => groupStateMemberStorageKey({ ...ref, principalId }))
        },
        {
            kind: 'presence',
            namespace: SESSIONS_NAMESPACE,
            identities: sessionIds,
            keys: sessionIds.map((sessionId) => groupStatePresenceSessionStorageKey({ ...ref, sessionId }))
        },
        {
            kind: 'admission',
            namespace: PRESENCE_ADMISSIONS_NAMESPACE,
            identities: admissionIds,
            keys: admissionIds.map((principalId) => groupStatePresenceAdmissionStorageKey({ ...ref, principalId }))
        },
        {
            kind: 'grant',
            namespace: PUBLICATION_GRANTS_NAMESPACE,
            identities: grantIds,
            keys: grantIds.map((principalId) => groupStatePublicationGrantStorageKey(ref, principalId))
        },
        {
            kind: 'subscription',
            namespace: SUBSCRIPTIONS_NAMESPACE,
            identities: subscriptionKeys,
            keys: subscriptionKeys
        }
    ];
}

/**
 * The live client session through the principal's client-state child prefix, and a principal's subscription rows
 * through the group's, each one `prefix-containing` selector in the same statement as the rest of the read.
 */
function addContainingSelectors(ref: GroupRef, identities: ExactReadIdentities, add: ExactReadSelectorSink): void {
    identities.clientSessions.forEach((identity, index) =>
        add(
            {
                selectorId: `client-session:${index}`,
                kind: 'prefix-containing',
                namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
                keyPrefix: `${clientStatePrincipalStorageKey({ ...ref, principalId: identity.principalId })}:`,
                storedValueContains: { sessionId: identity.sessionId, status: 'active' }
            },
            { kind: 'client-session', identity }
        )
    );
    identities.subscriptionPrincipalIds.forEach((principalId, index) =>
        add(
            {
                selectorId: `principal-subscriptions:${index}`,
                kind: 'prefix-containing',
                namespace: SUBSCRIPTIONS_NAMESPACE,
                keyPrefix: `${groupStateGroupStorageKey(ref)}:`,
                storedValueContains: { principalId }
            },
            { kind: 'principal-subscriptions', identity: principalId }
        )
    );
}

function addKeySelectors(group: ExactKeySelectorGroup, add: ExactReadSelectorSink): void {
    group.identities.forEach((identity, index) =>
        add(
            { selectorId: `${group.kind}:${index}`, kind: 'key', namespace: group.namespace, key: group.keys[index] },
            { kind: group.kind, identity }
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
