import { Temporal } from '@js-temporal/polyfill';

import {
    AL_MESSAGE_ENVELOPE_VERSION,
    type ALAckMode,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import type {
    ClientEvent,
    ClientPrincipalRef,
    ClientSnapshot
} from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { computeStateSnapshotPages, type StateSnapshotEnvelope } from '@shared/api/state-snapshot-page.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { readGroupVisibility } from '../group-state/policy/group-snapshot-visibility-policy.ts';
import { isClientSnapshotSessionLive, isGroupSnapshotSessionLive } from '../presence/snapshot-presence.ts';
import {
    isValidGroupCausalRevision,
    validateClientStateSyncEffect,
    validateComputedStateSyncFacts,
    validateGroupStateSyncEffect
} from './validate-state-sync.ts';

export interface StateSyncAudience {
    readonly kind: 'principal' | 'group';
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly resourceId: string;
}

export type ComputedClientStateSyncEffect =
    | Readonly<{
        effectKind: 'principal-state';
        payloadKind: 'snapshot';
        payload: ClientSnapshot;
    }>
    | Readonly<{
        effectKind: 'principal-state';
        payloadKind: 'event';
        payload: ClientEvent;
    }>;

export type ComputedGroupStateSyncEffect =
    | Readonly<{
        effectKind: 'member-state' | 'scope-directory';
        payloadKind: 'snapshot';
        payload: GroupSnapshot;
    }>
    | Readonly<{
        effectKind: 'member-state';
        payloadKind: 'delta-envelope';
        payload: GroupStateDeltaEnvelope;
    }>;

export interface StateSyncEntry {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
}

export interface ComputedClientStateSync {
    readonly commandId: string;
    readonly aggregateRef: ClientPrincipalRef;
    readonly acceptedCausalRevision: number;
    readonly audience: StateSyncAudience;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly effects: readonly ComputedClientStateSyncEffect[];
    readonly traceId: string;
}

export interface ComputedGroupStateSync {
    readonly commandId: string;
    readonly aggregateRef: GroupRef;
    readonly acceptedCausalRevision: GroupStateCausalRevision;
    readonly audience: StateSyncAudience;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly effects: readonly ComputedGroupStateSyncEffect[];
    readonly traceId: string;
}

export function computeClientStateSyncEntries(
    computed: ComputedClientStateSync,
    senderId: string
): readonly StateSyncEntry[] {
    validateComputedStateSyncFacts(computed, senderId);
    if (
        !Number.isSafeInteger(computed.acceptedCausalRevision) ||
        computed.acceptedCausalRevision < 0
    ) {
        throw new TypeError('Computed client state sync differs from accepted authority');
    }
    for (const effect of computed.effects) {
        validateClientStateSyncEffect(computed, effect);
    }
    return computed.effects.flatMap((effect) =>
        toStateSyncEntries({
            computed,
            effect,
            senderId,
            topicId: AppTopics[
                effect.payloadKind === 'snapshot'
                    ? 'clientStateSnapshot'
                    : 'clientStateEvent'
            ],
            // A principal audience names no room for its receivers to confirm against.
            ack: 'none'
        })
    );
}

export function computeGroupStateSyncEntries(
    computed: ComputedGroupStateSync,
    senderId: string
): readonly ResourceEntry[] {
    validateComputedStateSyncFacts(computed, senderId);
    if (!isValidGroupCausalRevision(computed.acceptedCausalRevision)) {
        throw new TypeError('Computed group state sync differs from accepted authority');
    }
    for (const effect of computed.effects) {
        validateGroupStateSyncEffect(computed, effect);
    }
    return computed.effects.flatMap((effect) => {
        const topicId = effect.payloadKind === 'snapshot'
            ? effect.effectKind === 'scope-directory'
                ? AppTopics.groupDirectorySnapshot
                : AppTopics.groupStateSnapshot
            : AppTopics.groupStateEvent;
        // A delta is a room broadcast its receivers confirm; a snapshot page is superseded by the next one instead.
        const ack = effect.payloadKind === 'delta-envelope' ? 'receiver' : 'none';
        return toStateSyncEntries({ computed, effect, senderId, topicId, ack }).map(({ entry }) => entry);
    });
}

/** Whether an effect's payload fits the AL payload bound its state-sync message is decoded against. */
export function isWithinStateSyncPayloadLimit(payload: ComputedGroupStateSyncEffect['payload']): boolean {
    return UTF8_ENCODER.encode(JSON.stringify(payload)).byteLength <= AL_MESSAGE_RESOURCE_LIMITS.payloadBytes;
}

const UTF8_ENCODER = new TextEncoder();

type ComputedStateSync = ComputedClientStateSync | ComputedGroupStateSync;
type ComputedStateSyncEffect =
    | ComputedClientStateSyncEffect
    | ComputedGroupStateSyncEffect;

interface ToStateSyncEntryInput {
    readonly computed: ComputedStateSync;
    readonly effect: ComputedStateSyncEffect;
    readonly senderId: string;
    readonly topicId: string;
    readonly ack: ALAckMode;
}

function toStateSyncEntries(input: ToStateSyncEntryInput): readonly StateSyncEntry[] {
    const { computed, effect, senderId, topicId, ack } = input;
    const causalIdentity = toStateSyncCausalIdentity(computed.acceptedCausalRevision);
    const messageId = [computed.commandId, effect.effectKind, effect.payloadKind, causalIdentity].join(':');
    const key = toAppQueueKey({
        topicId,
        resourceId: messageId,
        contextId: JSON.stringify([
            computed.audience.kind,
            computed.audience.applicationId,
            computed.audience.workspaceId,
            computed.audience.resourceId
        ])
    });
    const envelope = toStateSyncEnvelope({ key, computed, senderId, messageId, ack });
    const messages = effect.payloadKind === 'snapshot'
        ? computeStateSyncSnapshotPages({ envelope, computed, effect, causalIdentity })
        : [decodePersistedALMessageValue({
            ...envelope,
            // Client revisions are scalar. Group deltas carry their own predecessor/resulting
            // causal tuples; neither component promises contiguous AL sequence numbers.
            ...(effect.payloadKind === 'event'
                ? { ordering: { orderingKey: key.contextId, epoch: 0, seq: effect.payload.snapshotVersion } }
                : {}),
            payload: { typeId: topicId, contentType: 'application/json', resource: JSON.stringify(effect.payload) }
        })];
    return messages.map((message) => ({ message, entry: toStateSyncPageEntry(computed, message) }));
}

function toStateSyncCausalIdentity(revision: ComputedStateSync['acceptedCausalRevision']): string {
    return typeof revision === 'number'
        ? `revision=${revision}`
        : `group=${revision.groupRevision};presence=${revision.presenceRevision}`;
}

interface StateSyncSnapshotPagesInput {
    readonly envelope: StateSnapshotEnvelope;
    readonly computed: ComputedStateSync;
    readonly effect: Extract<ComputedStateSyncEffect, { payloadKind: 'snapshot'; }>;
    readonly causalIdentity: string;
}

/** The pages of an effect already validated against accepted authority; a refused page set is a broken invariant. */
function computeStateSyncSnapshotPages(input: StateSyncSnapshotPagesInput): readonly ALMessage[] {
    const { envelope, computed, effect } = input;
    return computeStateSnapshotPages({
        envelope,
        scope: computed.audience,
        revision: input.causalIdentity,
        resource: JSON.stringify(effect.payload),
        groupRecipientPeerIds: effect.effectKind === 'principal-state'
            ? []
            : computeGroupSnapshotRecipients(effect.payload, computed.createdAtEpochMs),
        unicastPeerIds: effect.effectKind === 'principal-state'
            ? effect.payload.activeSessions.filter((session) =>
                isClientSnapshotSessionLive(session, computed.createdAtEpochMs)
            )
                .map((session) => session.sessionId)
            : []
    })
        .fold((issue) => {
            throw new TypeError(issue.message);
        }, (pages) => pages);
}

interface StateSyncEnvelopeFacts {
    readonly key: ALMessage['route'];
    readonly computed: ComputedStateSync;
    readonly senderId: string;
    readonly messageId: string;
    readonly ack: ALAckMode;
}

function toStateSyncEnvelope(facts: StateSyncEnvelopeFacts): StateSnapshotEnvelope {
    const { key, computed, senderId, messageId, ack } = facts;
    return {
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: messageId,
            ts: computed.createdAtEpochMs,
            senderId,
            traceId: computed.traceId
        },
        route: key,
        targets: toStateSyncTargets(computed.audience),
        constraints: { expiresAtMs: computed.expireAtEpochMs },
        delivery: {
            ownership: 'shared',
            reliability: 'at-least-once',
            ack
        },
        audit: {
            createdBy: senderId,
            createdTs: computed.createdAtEpochMs
        }
    };
}

function toStateSyncPageEntry(computed: ComputedStateSync, message: ALMessage): ResourceEntry {
    const createdTs = Temporal.Instant
        .fromEpochMilliseconds(computed.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key: toAppQueueKey({ ...message.route, resourceId: message.id.msgId }),
        resource: JSON.stringify(message),
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(message.id.senderId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(
                computed.expireAtEpochMs
            )
        },
        dequeueAudit: { attempts: 0 }
    };
}

function toStateSyncTargets(audience: StateSyncAudience): ALMessage['targets'] {
    const scope = { applicationId: audience.applicationId, workspaceId: audience.workspaceId };
    return audience.kind === 'group'
        ? { mode: 'broadcast', scope: 'room', groupRef: { ...scope, groupId: audience.resourceId } }
        : { mode: 'broadcast', scope: 'principal', principalRef: { ...scope, principalId: audience.resourceId } };
}

function computeGroupSnapshotRecipients(snapshot: GroupSnapshot, nowMs: number): readonly string[] {
    const principals = new Set(
        snapshot.members.filter((member) =>
            readGroupVisibility({ snapshot, actor: { principalId: member.principalId }, nowEpochMs: nowMs }) === 'full'
        )
            .map((member) => member.principalId)
    );
    return snapshot.activeSessions.filter((session) =>
        principals.has(session.principalId) && isGroupSnapshotSessionLive(session, nowMs)
    )
        .map((session) => session.sessionId);
}
