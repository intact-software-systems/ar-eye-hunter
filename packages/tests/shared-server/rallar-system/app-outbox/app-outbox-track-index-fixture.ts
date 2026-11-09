import { Temporal } from '@js-temporal/polyfill';

import { toServerWsQBoxALOutboundAdmissionNamespace } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { WsOutboxProvenanceFacts } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { newALMulticastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export const TRACK_INDEX_NAMESPACE = toServerWsQBoxALOutboundAdmissionNamespace('default-qbox-server');

export interface TrackIndexTestEntryInput {
    readonly typeId: string;
    readonly resourceId: string;
    readonly seq: number | undefined;
    readonly expiresAt: Temporal.Instant;
}

/** A Relic-shaped round transition: an outbox row whose message names `ordering.seq` when `seq` is given. */
export function createTrackIndexTestEntry(input: TrackIndexTestEntryInput): ResourceEntry {
    const message = newALMulticastMessage(
        'server-1',
        newALRoute('room.relic.round', 'game-1', input.resourceId),
        { applicationId: 'relic', workspaceId: 'workspace', groupId: 'game-1' },
        'relic.round.v1',
        { round: 1 },
        { orderingKey: 'round', seq: input.seq }
    );
    const createdTs = Temporal.Now.plainDateTimeISO('UTC');
    return {
        key: message.route,
        resource: JSON.stringify(message),
        typeId: input.typeId,
        status: EntityStatus.NEW,
        audit: { date: createdTs.toPlainTime(), createdBy: 'server-1', createdTs, expiryTs: input.expiresAt },
        dequeueAudit: { attempts: 0 }
    };
}

export function toTrackIndexTestMessage(entry: ResourceEntry): ALMessage {
    return JSON.parse(entry.resource) as ALMessage;
}

/** A room-application proof of the entry's round broadcast, expiring with the row. */
export function toTrackIndexTestProvenanceFacts(entry: ResourceEntry): WsOutboxProvenanceFacts {
    return {
        message: toTrackIndexTestMessage(entry),
        producerKind: 'room-application',
        target: {
            kind: 'scoped-room-broadcast',
            groupRef: { applicationId: 'relic', workspaceId: 'workspace', groupId: 'game-1' },
            admittedAudience: ['b']
        },
        expiresAtMs: entry.audit.expiryTs.epochMilliseconds
    };
}
