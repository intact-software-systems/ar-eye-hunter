import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toAppQueueCreatedBy } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { serializeCanonicalMutationCommand } from '../../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';
import { toPhysicalAppInboxQueueKey } from '../app-inbox-queue-entry.ts';
import { assertMatchingAppInboxCommand } from '../assert-matching-app-inbox-command.ts';
import { toLogicalAppInboxCommand } from '../logical-app-inbox-command.ts';

export namespace AppInboxQueueEntryWriter {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
    }

    export interface Config {
        readonly serviceId: string;
        readonly defaultTopicId: string;
        readonly wakeOwningQueue?: () => void;
    }
}

export class AppInboxQueueEntryWriter {
    private readonly inboxQueueReader: InboxQueueReader;
    private readonly serviceId: string;
    private readonly defaultTopicId: string;
    private readonly wakeOwningQueue: (() => void) | undefined;

    constructor(
        dependencies: AppInboxQueueEntryWriter.Dependencies,
        config: AppInboxQueueEntryWriter.Config
    ) {
        this.inboxQueueReader = dependencies.inboxQueueReader;
        this.serviceId = config.serviceId;
        this.defaultTopicId = config.defaultTopicId;
        this.wakeOwningQueue = config.wakeOwningQueue;
    }

    async enqueue(enqueue: AppInboxEnqueueInput): Promise<ResourceEntry> {
        const key = this.toKey(enqueue);
        const receivedIdentity = serializeCanonicalMutationCommand(
            toLogicalAppInboxCommand(enqueue)
        );
        const entry = await this.inboxQueueReader.enqueueIfAbsent(
            this.toMessage(key, enqueue)
        );
        this.wakeOwningQueue?.();
        await assertMatchingAppInboxCommand(entry, enqueue, receivedIdentity);
        return entry;
    }

    async enqueueReplacingWhen(
        enqueue: AppInboxEnqueueInput,
        replaceExistingWhen: (entry: ResourceEntry) => boolean
    ): Promise<Key> {
        const key = this.toKey(enqueue);
        let replacedExistingEntry = false;
        const existing = await this.inboxQueueReader.enqueueIf(
            this.toMessage(key, enqueue),
            (entry) => {
                replacedExistingEntry = replaceExistingWhen(entry);
                return replacedExistingEntry;
            }
        );
        if (existing === undefined || replacedExistingEntry) {
            this.wakeOwningQueue?.();
        }
        return key;
    }

    private toKey(enqueue: AppInboxEnqueueInput): Key {
        return toPhysicalAppInboxQueueKey(enqueue, this.defaultTopicId);
    }

    private toMessage(key: Key, enqueue: AppInboxEnqueueInput): ALMessage {
        return newALUntargetedMessage(
            toAppQueueCreatedBy(this.serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            enqueue.type,
            enqueue
        );
    }
}
