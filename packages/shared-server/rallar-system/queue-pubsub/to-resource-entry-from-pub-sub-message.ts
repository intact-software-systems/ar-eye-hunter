import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import type { QueueBoxPubSubEntryMessage } from './queue-box-pub-sub-contracts.ts';

export function toResourceEntryFromPubSubMessage(
    message: QueueBoxPubSubEntryMessage
): ResourceEntry {
    try {
        return QueueBoxUtilities.toResourceEntryFromMsg(
            JSON.parse(message.payload) as ALMessage,
            message.typeId
        );
    }
    catch (error) {
        console.warn(
            'Failed to parse published payload as ALMessage. ' +
                'Falling back to raw queue entry reconstruction.',
            error
        );
        return toResourceEntryWithRawPayload(message);
    }
}

function toResourceEntryWithRawPayload(
    message: QueueBoxPubSubEntryMessage
): ResourceEntry {
    return {
        key: message.key,
        resource: message.payload,
        typeId: message.typeId,
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0
        },
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: message.publisherId,
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: NEVER_EXPIRE_TS
        }
    };
}
