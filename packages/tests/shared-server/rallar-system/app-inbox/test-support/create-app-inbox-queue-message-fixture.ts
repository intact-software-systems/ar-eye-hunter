import type { AppInboxQueueMessageCreationDto } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import {
    newALRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { toAppQueueCreatedBy } from '@shared/queuebox/AppQueueIdentity.ts';

export function createAppInboxQueueMessageFixture(creation: AppInboxQueueMessageCreationDto): ALMessage {
    return newALUntargetedMessage(
        toAppQueueCreatedBy(creation.serviceId),
        newALRoute(creation.key.topicId, creation.key.contextId, creation.key.resourceId),
        creation.enqueue.type,
        creation.enqueue
    );
}
