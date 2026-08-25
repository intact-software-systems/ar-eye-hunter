import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import type { QueueBoxPubSubEntryMessage } from './queue-box-pub-sub-contracts.ts';

export function toResourceEntryFromPubSubMessage(
    message: QueueBoxPubSubEntryMessage
): ResourceEntry {
    return QueueBoxUtilities.toResourceEntryFromMsg(
        decodePersistedALMessage(message.payload),
        message.typeId
    );
}
