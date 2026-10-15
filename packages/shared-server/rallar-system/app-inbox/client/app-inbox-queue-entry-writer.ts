import {
    isCompletedOrFailed,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { serializeCanonicalMutationCommand } from '../../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';
import type { AppInboxEntryRepository } from '../app-inbox-persistence-ports.ts';
import {
    toPhysicalAppInboxQueueKey,
    type AppInboxQueueMessageFactory
} from '../app-inbox-queue-entry.ts';
import { assertMatchingAppInboxCommand } from '../assert-matching-app-inbox-command.ts';
import { toLogicalAppInboxCommand } from '../logical-app-inbox-command.ts';

export namespace AppInboxQueueEntryWriter {
    export interface Dependencies {
        readonly creationNow: QueueBoxUtilities.CreationClock;
        readonly newResourceId: () => string;
        readonly createMessage: AppInboxQueueMessageFactory;
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
    private readonly creationNow: QueueBoxUtilities.CreationClock;
    private readonly newResourceId: () => string;
    private readonly createMessage: AppInboxQueueMessageFactory;
    private readonly serviceId: string;
    private readonly defaultTopicId: string;
    private readonly wakeOwningQueue: (() => void) | undefined;

    constructor(
        dependencies: AppInboxQueueEntryWriter.Dependencies,
        config: AppInboxQueueEntryWriter.Config
    ) {
        this.inboxQueueReader = dependencies.inboxQueueReader;
        this.repository = dependencies.repository;
        this.creationNow = dependencies.creationNow;
        this.newResourceId = dependencies.newResourceId;
        this.createMessage = dependencies.createMessage;
        this.serviceId = config.serviceId;
        this.defaultTopicId = config.defaultTopicId;
        this.wakeOwningQueue = config.wakeOwningQueue;
    }

    async enqueue(enqueue: AppInboxEnqueueInput): Promise<ResourceEntry> {
        const key = this.createKey(enqueue);
        const receivedIdentity = serializeCanonicalMutationCommand(
            toLogicalAppInboxCommand(enqueue)
        );
        const entry = await this.inboxQueueReader.enqueueIfAbsent(
            this.createMessage({ key, enqueue, serviceId: this.serviceId })
        );
        this.wakeOwningQueue?.();
        assertMatchingAppInboxCommand(entry, enqueue, receivedIdentity);
        return entry;
    }

    async enqueueReplacingTerminal(enqueue: AppInboxEnqueueInput): Promise<Key> {
        const key = this.createKey(enqueue);
        const replacement = QueueBoxUtilities.toResourceEntryFromMsg(
            this.createMessage({ key, enqueue, serviceId: this.serviceId }),
            InboxQueueReader.INBOX_ENQUEUE_TYPE,
            this.creationNow()
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

    private createKey(enqueue: AppInboxEnqueueInput): Key {
        return toPhysicalAppInboxQueueKey(
            { ...enqueue, resourceId: enqueue.resourceId ?? this.newResourceId() },
            this.defaultTopicId
        );
    }
}
