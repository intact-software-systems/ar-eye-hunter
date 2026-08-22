import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { toAppQueueCreatedBy } from '../../../services/app-inbox-queue-key.ts';
import type { LogoutAuthSessionCommand } from '../auth-mutation-contracts.ts';

export function toAuthLogoutOutbox(
    command: LogoutAuthSessionCommand,
    serviceId: string
): ResourceEntry {
    const message = {
        id: {
            v: 2,
            msgId: `auth-logout:${command.requestId}`,
            ts: command.capturedAtEpochMs,
            senderId: serviceId
        },
        route: {
            topicId: 'auth.session.logout',
            resourceId: command.requestId,
            contextId: command.expected.sessionId
        },
        targets: { mode: 'unicast', toPeerId: command.expected.sessionId },
        constraints: { expiresAtMs: command.expected.expiresAtEpochMs },
        payload: {
            typeId: 'auth.session.logout.v1',
            contentType: 'application/json',
            resource: JSON.stringify({
                sessionId: command.expected.sessionId,
                closeCode: 1000,
                reason: 'auth-logout'
            })
        },
        audit: { createdBy: serviceId, createdTs: command.capturedAtEpochMs }
    } as const;
    const createdTs = Temporal.Instant.fromEpochMilliseconds(command.capturedAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key: message.route,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(serviceId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(command.expected.expiresAtEpochMs)
        },
        dequeueAudit: { attempts: 0 }
    };
}
