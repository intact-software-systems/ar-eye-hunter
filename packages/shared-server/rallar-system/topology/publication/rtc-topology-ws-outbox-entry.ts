import { Temporal } from '@js-temporal/polyfill';

import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { validatePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { ResourceInboxRepository } from '../../../queuebox/postgres/resource-inbox-repository.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication.ts';
import { validateRtcTopologyPublication } from './validate-rtc-topology-publication.ts';

export function computeRtcTopologyPublicationOutbox(
    publication: RtcTopologyPublication
): ResourceEntry {
    validateRtcTopologyPublication(publication, publication.groupRef);
    const publicationMessage = publication.message;
    if (
        publicationMessage.targets?.mode !== 'broadcast' ||
        publicationMessage.targets.scope !== 'room'
    ) {
        throw new TypeError('RTC topology publication outbox target is invalid');
    }
    const message = {
        ...publicationMessage,
        targets: {
            ...publicationMessage.targets,
            recipientPeerIds: [...publication.recipientSessionIds]
        }
    };
    validatePersistedALMessage(message);
    const createdBy = message.audit?.createdBy;
    const expiresAtMs = message.constraints?.expiresAtMs;
    if (
        typeof createdBy !== 'string' ||
        createdBy.length === 0 ||
        typeof expiresAtMs !== 'number' ||
        !Number.isSafeInteger(expiresAtMs)
    ) {
        throw new TypeError('RTC topology publication message persistence is incomplete');
    }
    const createdTs = Temporal.Instant
        .fromEpochMilliseconds(publication.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key: toAppQueueKey({
            topicId: message.route.topicId,
            resourceId: message.id.msgId,
            contextId: message.route.contextId
        }),
        resource: JSON.stringify(message),
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(createdBy),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(
                expiresAtMs
            )
        },
        dequeueAudit: { attempts: 0 }
    };
}

export async function writeRtcTopologyPublicationOutbox(
    transaction: PSqlSql,
    publication: RtcTopologyPublication
): Promise<ResourceEntry> {
    const entry = computeRtcTopologyPublicationOutbox(publication);
    await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(entry);
    return entry;
}
