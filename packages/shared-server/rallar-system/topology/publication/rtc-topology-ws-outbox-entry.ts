import { Temporal } from '@js-temporal/polyfill';

import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    computeAppOutboxInsert,
    writeAppOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
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
    const message = decodePersistedALMessageValue({
        ...publicationMessage,
        targets: {
            ...publicationMessage.targets,
            recipientPeerIds: [...publication.recipientSessionIds]
        }
    });
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

export function assertRtcTopologyPublicationOutbox(
    publication: RtcTopologyPublication,
    outbox: ResourceEntry
): void {
    const expected = computeRtcTopologyPublicationOutbox(publication);
    if (
        !isKeysEqual(outbox.key, expected.key) ||
        outbox.resource !== expected.resource ||
        outbox.typeId !== expected.typeId ||
        outbox.audit.expiryTs.epochMilliseconds !== expected.audit.expiryTs.epochMilliseconds
    ) {
        throw new TypeError('RTC topology delivery outbox differs from its publication');
    }
}

export async function writeRtcTopologyPublicationOutbox(
    transaction: PSqlSql,
    computed: AppOutboxInsert
): Promise<ResourceEntry> {
    await writeAppOutboxInsert(transaction, computed);
    return computed.entry;
}

export function computeRtcTopologyPublicationOutboxInsert(
    publication: RtcTopologyPublication
): AppOutboxInsert {
    return computeAppOutboxInsert(computeRtcTopologyPublicationOutbox(publication));
}
