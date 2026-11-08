import { Temporal } from '@js-temporal/polyfill';
import type { RelicTournamentParticipation } from '../src/relic-tournament-participation.ts';
import { relicMutationPlayerId } from './relic-tournament.ts';

import {
    computeWsOutboxInsert,
    type AppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import type { WsOutboxProvenance } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    toRelicRoomGroupRef,
    toRelicRoundTrackKey,
    type RelicGameState
} from '../mod.ts';
import { toRelicCommand } from './relic-game-move.ts';
import type { RelicGameMutationService } from './relic-game-mutation-service.ts';
import {
    toRelicActionRecordedEvent,
    toRelicCommandRefusedEvent
} from './relic-hunter-events.ts';
import { toRelicRoundTransitionEvent } from './to-relic-round-transition-event.ts';

const RELIC_SNAPSHOT_TTL_MS = 15_000;
const RELIC_EVENT_TTL_MS = 60_000;

interface RelicGamePublicationInput {
    readonly read: RelicGameMutationService.Attempt;
    readonly admissionNamespace: string;
    readonly participation: RelicTournamentParticipation | null;
    readonly previous: RelicGameState | null;
    readonly next: RelicGameState | null;
    readonly refusal: string | null;
}

interface RelicGameNotification {
    readonly effect: 'snapshot' | 'hunter' | 'transition';
    readonly topicId: string;
    readonly typeId: string;
    readonly payload: object;
    readonly ttlMs: number;
    readonly principalId: string | null;
    readonly ordering: ALMessage['ordering'] | null;
}

export interface RelicGamePublications {
    readonly outboxWrites: readonly AppOutboxInsert[];
}

/** Domain transitions have one position each: a round starts at 1 and resolves at 2; finish enters the next epoch. */
export function computeRelicGamePublications(input: RelicGamePublicationInput): RelicGamePublications {
    return { outboxWrites: toNotifications(input).map((notification) => toRelicGamePublication(input, notification)) };
}

/** Captures the eligible sessions from the same read used for the mutation decision. */
function toRelicGameAudience(
    read: RelicGameMutationService.Read,
    notification: RelicGameNotification
): readonly string[] {
    return [
        ...new Set(
            (read.group?.snapshot.activeSessions ?? [])
                .filter((session) =>
                    session.expiresAtEpochMs > read.attemptAtEpochMs && session.disconnectedAtEpochMs === null &&
                    (notification.principalId === null || session.principalId === notification.principalId)
                )
                .map((session) => session.sessionId)
        )
    ].sort();
}

/** Translates a domain notification into the existing room or principal wire contract. */
function toRelicGameMessage(
    read: RelicGameMutationService.Attempt,
    notification: RelicGameNotification,
    audience: readonly string[]
): ALMessage {
    const ref = toRelicRoomGroupRef(read.ingress.command.gameId);
    const created = read.attemptAtEpochMs;
    const identity = `relic:${computeSha256CanonicalJson(read.ingress.command).slice(0, 40)}:${notification.effect}`;
    return {
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: identity,
            ts: created,
            senderId: read.ingress.serverPeerId,
            traceId: read.traceId
        },
        route: { topicId: notification.topicId, contextId: ref.groupId, resourceId: identity },
        targets: {
            mode: 'broadcast',
            scope: notification.principalId === null ? 'room' : 'principal',
            groupRef: ref,
            ...(notification.principalId === null ? { recipientPeerIds: audience } : {
                principalRef: {
                    applicationId: ref.applicationId,
                    workspaceId: ref.workspaceId,
                    principalId: notification.principalId
                }
            })
        },
        constraints: { expiresAtMs: created + notification.ttlMs },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        ...(notification.ordering === null ? {} : { ordering: notification.ordering }),
        payload: {
            typeId: notification.typeId,
            contentType: 'application/json',
            resource: JSON.stringify(notification.payload)
        },
        audit: { createdBy: read.ingress.serverPeerId, createdTs: created }
    } satisfies ALMessage;
}

/** Encodes the final outbox row with the proof of its admitted audience before transaction entry. */
function toRelicGamePublication(
    input: RelicGamePublicationInput,
    notification: RelicGameNotification
): AppOutboxInsert {
    const { read, admissionNamespace } = input;
    const audience = toRelicGameAudience(read, notification);
    const message = toRelicGameMessage(read, notification, audience);
    const createdTs = Temporal.Instant.fromEpochMilliseconds(message.id.ts).toZonedDateTimeISO('UTC').toPlainDateTime();
    const expiresAtMs = message.id.ts + notification.ttlMs;
    const entry: ResourceEntry = {
        key: message.route,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(read.ingress.serverPeerId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(expiresAtMs)
        },
        dequeueAudit: { attempts: 0 }
    };
    return computeWsOutboxInsert({
        entry,
        admissionNamespace,
        provenance: {
            message,
            producerKind: 'room-application',
            target: toRelicGameProvenanceTarget(read, notification, audience),
            expiresAtMs
        }
    });
}

function toRelicGameProvenanceTarget(
    read: RelicGameMutationService.Attempt,
    notification: RelicGameNotification,
    audience: readonly string[]
): WsOutboxProvenance['target'] {
    const ref = toRelicRoomGroupRef(read.ingress.command.gameId);
    if (notification.principalId === null) {
        return { kind: 'scoped-room-broadcast', groupRef: ref, admittedAudience: audience };
    }
    return {
        kind: 'scoped-principal-broadcast',
        principalRef: {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            principalId: notification.principalId
        },
        admittedAudience: audience
    };
}

function toNotifications(input: RelicGamePublicationInput): readonly RelicGameNotification[] {
    const { command } = input.read.ingress;
    const sender = command.actor === null
        ? null
        : { clientId: command.actor.clientId, playerId: relicMutationPlayerId(input.read) };
    if (input.refusal !== null && command.move !== null && sender !== null) {
        return [{
            effect: 'hunter',
            topicId: RELIC_TOPICS.hunter,
            typeId: RELIC_TYPES.hunter,
            payload: toRelicCommandRefusedEvent(toRelicCommand(command.move), sender, new Error(input.refusal)),
            ttlMs: RELIC_SNAPSHOT_TTL_MS,
            principalId: sender.clientId,
            ordering: null
        }];
    }
    if (input.next === null || command.operation === 'ensure') {
        return [];
    }
    const next = input.next;
    const notifications: RelicGameNotification[] = [toSnapshotNotification(input, next)];
    if (input.previous === null) {
        return notifications;
    }
    const action = command.move === null || sender === null
        ? undefined
        : toRelicActionRecordedEvent(input.previous, toRelicCommand(command.move), sender);
    if (action !== undefined && sender !== null) {
        notifications.push({
            effect: 'hunter',
            topicId: RELIC_TOPICS.hunter,
            typeId: RELIC_TYPES.hunter,
            payload: action,
            ttlMs: RELIC_SNAPSHOT_TTL_MS,
            principalId: sender.clientId,
            ordering: null
        });
    }
    const transition = toRelicRoundTransitionEvent(input.previous, next);
    if (transition !== undefined) {
        notifications.push({
            effect: 'transition',
            topicId: RELIC_TOPICS.event,
            typeId: RELIC_TYPES.event,
            payload: transition,
            ttlMs: RELIC_EVENT_TTL_MS,
            principalId: null,
            ordering: {
                orderingKey: toRelicRoundTrackKey(next),
                epoch: transition.transition === 'finished' ? transition.round + 1 : transition.round,
                seq: transition.transition === 'round-resolved' ? 2 : 1
            }
        });
    }
    return notifications;
}

function toSnapshotNotification(input: RelicGamePublicationInput, next: RelicGameState): RelicGameNotification {
    return {
        effect: 'snapshot',
        topicId: RELIC_TOPICS.snapshot,
        typeId: RELIC_TYPES.snapshot,
        payload: {
            protocolVersion: next.protocolVersion,
            gameId: next.gameId,
            snapshot: toPublicRelicSnapshot(next, input.participation)
        },
        ttlMs: RELIC_SNAPSHOT_TTL_MS,
        principalId: null,
        ordering: null
    };
}
