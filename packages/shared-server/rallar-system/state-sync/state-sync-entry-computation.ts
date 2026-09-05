import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
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

export interface ComputedClientStateSync {
    readonly commandId: string;
    readonly aggregateRef: ClientPrincipalRef;
    readonly acceptedCausalRevision: number;
    readonly audience: StateSyncAudience;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly effects: readonly ComputedClientStateSyncEffect[];
}

export interface ComputedGroupStateSync {
    readonly commandId: string;
    readonly aggregateRef: GroupRef;
    readonly acceptedCausalRevision: GroupStateCausalRevision;
    readonly audience: StateSyncAudience;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly effects: readonly ComputedGroupStateSyncEffect[];
}

export function computeClientStateSyncEntries(
    computed: ComputedClientStateSync,
    senderId: string
): readonly ResourceEntry[] {
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
            sequence: computed.acceptedCausalRevision,
            epoch: 0
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
        return toStateSyncEntries({
            computed,
            effect,
            senderId,
            topicId,
            sequence: computed.acceptedCausalRevision.presenceRevision,
            epoch: computed.acceptedCausalRevision.groupRevision
        });
    });
}

type ComputedStateSync = ComputedClientStateSync | ComputedGroupStateSync;
type ComputedStateSyncEffect =
    | ComputedClientStateSyncEffect
    | ComputedGroupStateSyncEffect;

interface ToStateSyncEntryInput {
    readonly computed: ComputedStateSync;
    readonly effect: ComputedStateSyncEffect;
    readonly senderId: string;
    readonly topicId: string;
    readonly sequence: number;
    readonly epoch: number;
}

function toStateSyncEntries(input: ToStateSyncEntryInput): readonly ResourceEntry[] {
    const { computed, effect, senderId, topicId, sequence, epoch } = input;
    const causalIdentity = typeof computed.acceptedCausalRevision === 'number'
        ? `revision=${computed.acceptedCausalRevision}`
        : `group=${computed.acceptedCausalRevision.groupRevision};presence=${computed.acceptedCausalRevision.presenceRevision}`;
    const messageId = [
        computed.commandId,
        effect.effectKind,
        effect.payloadKind,
        causalIdentity
    ].join(':');
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
    const envelope = materializeStateSyncEnvelope({ key, computed, senderId, messageId });
    const messages = effect.payloadKind === 'snapshot'
        ? computeStateSnapshotPages({
            envelope,
            scope: computed.audience,
            revision: causalIdentity,
            resource: JSON.stringify(effect.payload),
            roomRecipientPeerIds: effect.effectKind === 'principal-state'
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
            }, (pages) => pages)
        : [decodePersistedALMessageValue({
            ...envelope,
            ordering: { orderingKey: key.contextId, epoch, seq: sequence },
            payload: { typeId: topicId, contentType: 'application/json', resource: JSON.stringify(effect.payload) }
        })];
    return messages.map((message) => toStateSyncPageEntry(computed, message));
}

interface StateSyncEnvelopeFacts {
    readonly key: ALMessage['route'];
    readonly computed: ComputedStateSync;
    readonly senderId: string;
    readonly messageId: string;
}

function materializeStateSyncEnvelope(facts: StateSyncEnvelopeFacts): StateSnapshotEnvelope {
    const { key, computed, senderId, messageId } = facts;
    return {
        id: {
            v: 2,
            msgId: messageId,
            ts: computed.createdAtEpochMs,
            senderId
        },
        route: key,
        targets: toStateSyncTargets(computed.audience),
        constraints: { expiresAtMs: computed.expireAtEpochMs },
        delivery: {
            ownership: 'shared',
            reliability: 'at-least-once',
            ack: 'none'
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
