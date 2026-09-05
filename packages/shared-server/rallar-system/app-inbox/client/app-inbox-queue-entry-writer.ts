import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toAppQueueCreatedBy } from '@shared/queuebox/AppQueueIdentity.ts';
import { isCompletedOrFailed, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import { serializeCanonicalMutationCommand } from '../../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';
import type { AppInboxEntryRepository } from '../app-inbox-persistence-ports.ts';
import { toPhysicalAppInboxQueueKey } from '../app-inbox-queue-entry.ts';
import { assertMatchingAppInboxCommand } from '../assert-matching-app-inbox-command.ts';
import { toLogicalAppInboxCommand } from '../logical-app-inbox-command.ts';

export namespace AppInboxQueueEntryWriter {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly repository: AppInboxEntryRepository;
    }

    export interface Config {
        readonly serviceId: string;
        readonly defaultTopicId: string;
        readonly wakeOwningQueue?: () => void;
    }
}

export class AppInboxQueueEntryWriter {
    private readonly inboxQueueReader: InboxQueueReader;
    private readonly repository: AppInboxEntryRepository;
    private readonly serviceId: string;
    private readonly defaultTopicId: string;
    private readonly wakeOwningQueue: (() => void) | undefined;

    constructor(
        dependencies: AppInboxQueueEntryWriter.Dependencies,
        config: AppInboxQueueEntryWriter.Config
    ) {
        this.inboxQueueReader = dependencies.inboxQueueReader;
        this.repository = dependencies.repository;
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

    async enqueueReplacingTerminal(enqueue: AppInboxEnqueueInput): Promise<Key> {
        const key = this.toKey(enqueue);
        const replacement = QueueBoxUtilities.toResourceEntryFromMsg(
            this.toMessage(key, enqueue),
            InboxQueueReader.INBOX_ENQUEUE_TYPE
        );
        const observed = await this.inboxQueueReader.inbox.getItem(key);
        if (observed === undefined) {
            const inserted = await this.repository.tryWriteIfAbsentOrReplaceExpired(replacement);
            if (inserted !== null) {
                this.wakeOwningQueue?.();
            }
            return key;
        }
        if (!isCompletedOrFailed(observed.status)) {
            return key;
        }
        const replaced = await this.repository.replaceIfObserved(observed, replacement);
        if (replaced !== null) {
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
