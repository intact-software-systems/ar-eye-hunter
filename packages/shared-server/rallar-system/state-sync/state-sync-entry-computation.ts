import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    isValidGroupCausalRevision,
    validateClientStateSyncEffect,
    validateComputedStateSyncFacts,
    validateGroupStateSyncEffect
} from './validate-state-sync.ts';

export type StateSyncAudience = Readonly<{
    kind: 'principal' | 'group';
    applicationId: string;
    workspaceId: string;
    resourceId: string;
}>;

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

export type ComputedClientStateSync = Readonly<{
    commandId: string;
    aggregateRef: ClientPrincipalRef;
    acceptedCausalRevision: number;
    audience: StateSyncAudience;
    createdAtEpochMs: number;
    expireAtEpochMs: number;
    effects: readonly ComputedClientStateSyncEffect[];
}>;

export type ComputedGroupStateSync = Readonly<{
    commandId: string;
    aggregateRef: GroupRef;
    acceptedCausalRevision: GroupStateCausalRevision;
    audience: StateSyncAudience;
    createdAtEpochMs: number;
    expireAtEpochMs: number;
    effects: readonly ComputedGroupStateSyncEffect[];
}>;

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
    return computed.effects.map((effect) =>
        toStateSyncEntry({
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
    return computed.effects.map((effect) => {
        const topicId = effect.payloadKind === 'snapshot'
            ? effect.effectKind === 'scope-directory'
                ? AppTopics.groupDirectorySnapshot
                : AppTopics.groupStateSnapshot
            : AppTopics.groupStateEvent;
        return toStateSyncEntry({
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

function toStateSyncEntry(input: ToStateSyncEntryInput): ResourceEntry {
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
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: messageId,
            ts: computed.createdAtEpochMs,
            senderId
        },
        route: key,
        targets: computed.audience.kind === 'group'
            ? {
                mode: 'broadcast',
                scope: 'room',
                groupRef: {
                    applicationId: computed.audience.applicationId,
                    workspaceId: computed.audience.workspaceId,
                    groupId: computed.audience.resourceId
                }
            }
            : {
                mode: 'broadcast',
                scope: 'principal',
                principalRef: {
                    applicationId: computed.audience.applicationId,
                    workspaceId: computed.audience.workspaceId,
                    principalId: computed.audience.resourceId
                }
            },
        constraints: { expiresAtMs: computed.expireAtEpochMs },
        ordering: {
            orderingKey: key.contextId,
            epoch,
            seq: sequence
        },
        delivery: {
            ownership: 'shared',
            reliability: 'at-least-once',
            ack: 'none'
        },
        payload: {
            typeId: topicId,
            contentType: 'application/json',
            resource: JSON.stringify(effect.payload)
        },
        audit: {
            createdBy: senderId,
            createdTs: computed.createdAtEpochMs
        }
    };
    const createdTs = Temporal.Instant
        .fromEpochMilliseconds(computed.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(senderId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(
                computed.expireAtEpochMs
            )
        },
        dequeueAudit: { attempts: 0 }
    };
}
