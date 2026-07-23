import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
    RALLAR_CRDT_PROTOCOL_VERSION,
    RALLAR_CRDT_UPDATE_TYPE_ID,
} from '@shared/crdt/mod.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toAppQueueCreatedBy } from './app-inbox-queue-key.ts';
import type {
    CrdtAppendCommand,
    CrdtEraseCommand,
    CrdtMutationResult,
} from './crdt-mutation-contracts.ts';

export function toAppendOutbox(
    command: CrdtAppendCommand,
    response: CrdtMutationResult,
    serviceId: string,
): readonly ResourceEntry[] {
    return [
        toWsOutbox(command, serviceId, 'reply', RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID, {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            requestId: command.update.updateId,
            document: command.document,
            acceptedAtEpochMs: command.capturedAtEpochMs,
            results: [response],
        }),
        toWsOutbox(
            command,
            serviceId,
            'fanout',
            RALLAR_CRDT_UPDATE_TYPE_ID,
            command.update,
        ),
    ];
}

function toWsOutbox(
    command: CrdtAppendCommand,
    serviceId: string,
    effect: 'reply' | 'fanout',
    typeId: string,
    payload: unknown,
): ResourceEntry {
    const message = {
        id: {
            v: 2,
            msgId: `crdt:${command.commandId}:${effect}`,
            ts: command.capturedAtEpochMs,
            senderId: serviceId,
        },
        route: {
            topicId: command.responseAudience.topicId,
            resourceId: `crdt:${command.commandId}:${effect}`,
            contextId: command.responseAudience.contextId,
        },
        targets: toTargets(command, effect),
        constraints: { expiresAtMs: command.expireAtEpochMs },
        payload: { typeId, contentType: 'application/json', resource: JSON.stringify(payload) },
        audit: { createdBy: serviceId, createdTs: command.capturedAtEpochMs },
    };
    return toResourceEntry(
        message,
        EnqueuedType.WS_OUTBOX,
        command.capturedAtEpochMs,
        command.expireAtEpochMs,
        serviceId,
    );
}

function toTargets(command: CrdtAppendCommand, effect: 'reply' | 'fanout') {
    if (effect === 'reply' || command.responseAudience.kind === 'principal') {
        return { mode: 'unicast' as const, toPeerId: command.responseAudience.senderSessionId };
    }
    if (command.responseAudience.kind === 'room' && command.document.roomRef) {
        return {
            mode: 'broadcast' as const,
            scope: 'room' as const,
            groupRef: command.document.roomRef,
            exceptPeerIds: [command.responseAudience.senderSessionId],
        };
    }
    return {
        mode: 'broadcast' as const,
        scope: 'world' as const,
        exceptPeerIds: [command.responseAudience.senderSessionId],
    };
}

export function toAuditOutbox(command: CrdtEraseCommand, serviceId: string): ResourceEntry {
    const message = {
        id: {
            v: 2,
            msgId: `crdt:${command.commandId}:audit`,
            ts: command.capturedAtEpochMs,
            senderId: serviceId,
        },
        route: {
            topicId: 'crdt.audit',
            resourceId: `crdt:${command.commandId}:audit`,
            contextId: command.documentKey,
        },
        targets: { mode: 'all', scope: 'global' },
        constraints: { expiresAtMs: command.expireAtEpochMs },
        payload: {
            typeId: 'CRDT_ERASURE_AUDIT',
            contentType: 'application/json',
            resource: JSON.stringify({
                commandId: command.commandId,
                document: command.document,
                requestedBy: command.actor.principalId,
                requestedAtEpochMs: command.capturedAtEpochMs,
                reason: command.reason,
                mode: command.mode,
            }),
        },
        audit: { createdBy: serviceId, createdTs: command.capturedAtEpochMs },
    };
    return toResourceEntry(
        message,
        EnqueuedType.APP_OUTBOX,
        command.capturedAtEpochMs,
        command.expireAtEpochMs,
        serviceId,
    );
}

function toResourceEntry(
    message: { route: ResourceEntry['key'] },
    typeId: EnqueuedType,
    created: number,
    expiry: number,
    serviceId: string,
): ResourceEntry {
    const createdTs = Temporal.Instant.fromEpochMilliseconds(created)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key: message.route,
        resource: JSON.stringify(message),
        typeId,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(serviceId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(expiry),
        },
        dequeueAudit: { attempts: 0 },
    };
}
