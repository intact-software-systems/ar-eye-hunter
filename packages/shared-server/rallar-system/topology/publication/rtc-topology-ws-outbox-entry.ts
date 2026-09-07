import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { computeAppOutboxInsert, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { materializeRtcOverlayTopologyMessages } from '../planning/materialize-rtc-overlay-topology-messages.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication.ts';
import { validateRtcTopologyPublication } from './validate-rtc-topology-publication.ts';

export function computeRtcTopologyPublicationOutbox(publication: RtcTopologyPublication): readonly ResourceEntry[] {
    validateRtcTopologyPublication(publication, publication.groupRef);
    return materializeRtcOverlayTopologyMessages(publication).map((message) =>
        toPublicationPageOutbox(publication, message)
    );
}

function toPublicationPageOutbox(publication: RtcTopologyPublication, message: ALMessage): ResourceEntry {
    const createdTs = Temporal.Instant.fromEpochMilliseconds(publication.createdAtEpochMs)
        .toZonedDateTimeISO('UTC').toPlainDateTime();
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
            createdBy: toAppQueueCreatedBy('rallar-server'),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(publication.expiresAtEpochMs)
        },
        dequeueAudit: { attempts: 0 }
    };
}

export function assertRtcTopologyPublicationOutbox(
    publication: RtcTopologyPublication,
    outbox: readonly (ResourceEntry | undefined)[]
): void {
    const expected = computeRtcTopologyPublicationOutbox(publication);
    if (outbox.length !== expected.length) {
        throw new TypeError('RTC topology publication has incomplete durable pages');
    }
    for (const [index, page] of expected.entries()) {
        const actual = outbox[index];
        if (
            !actual || !isKeysEqual(actual.key, page.key) || actual.resource !== page.resource ||
            actual.typeId !== page.typeId ||
            actual.audit.expiryTs.epochMilliseconds !== page.audit.expiryTs.epochMilliseconds
        ) {
            throw new TypeError('RTC topology delivery page differs from its publication');
        }
    }
}

export function computeRtcTopologyPublicationOutboxWrites(
    publication: RtcTopologyPublication
): readonly AppOutboxInsert[] {
    return computeRtcTopologyPublicationOutbox(publication).map(computeAppOutboxInsert);
}
