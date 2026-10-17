import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { serializeCanonicalMutationCommand } from '../../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';
import {
    toPhysicalAppInboxQueueKey,
    type AppInboxQueueMessageFactory
} from '../app-inbox-queue-entry.ts';
import { assertMatchingAppInboxCommand } from '../assert-matching-app-inbox-command.ts';
import { toLogicalAppInboxCommand } from '../logical-app-inbox-command.ts';

export namespace AppInboxQueueEntryWriter {
    export interface Dependencies {
        readonly newResourceId: () => string;
        readonly createMessage: AppInboxQueueMessageFactory;
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

    private createKey(enqueue: AppInboxEnqueueInput): Key {
        return toPhysicalAppInboxQueueKey(
            { ...enqueue, resourceId: enqueue.resourceId ?? this.newResourceId() },
            this.defaultTopicId
        );
    }
}
