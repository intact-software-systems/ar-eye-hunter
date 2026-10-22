import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
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

    /** The entry its key keeps, and whether this write created it. */
    export interface Written {
        readonly entry: ResourceEntry;
        readonly winner: boolean;
    }
}

interface AppInboxWrittenMessage {
    readonly entry: ResourceEntry;
    readonly message: ALMessage;
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

    /** Writes the command's entry and wakes the owning queue, for a caller that does not wait for its completion. */
    async enqueue(enqueue: AppInboxEnqueueInput): Promise<ResourceEntry> {
        const { entry } = await this.writeMessage(enqueue);
        this.wakeOwningQueue?.();
        return entry;
    }

    /**
     * Writes the command's entry without waking the owning queue: the waiter subscribes to its completion first and
     * wakes the queue only for an entry this write created.
     */
    async writeIfAbsent(enqueue: AppInboxEnqueueInput): Promise<AppInboxQueueEntryWriter.Written> {
        const { entry, message } = await this.writeMessage(enqueue);
        // A message carries a fresh id, so only an entry this write created keeps its serialized message. A created
        // entry misread as an earlier write's costs its waiter a first read and the queue wake: the entry then waits
        // for the engine's next idle pass, up to its 3 s idle ceiling plus jitter.
        return { entry, winner: entry.resource === JSON.stringify(message) };
    }

    private async writeMessage(enqueue: AppInboxEnqueueInput): Promise<AppInboxWrittenMessage> {
        const key = this.createKey(enqueue);
        const receivedIdentity = serializeCanonicalMutationCommand(
            toLogicalAppInboxCommand(enqueue)
        );
        const message = this.createMessage({ key, enqueue, serviceId: this.serviceId });
        const entry = await this.inboxQueueReader.enqueueIfAbsent(message);
        assertMatchingAppInboxCommand(entry, enqueue, receivedIdentity);
        return { entry, message };
    }

    private createKey(enqueue: AppInboxEnqueueInput): Key {
        return toPhysicalAppInboxQueueKey(
            { ...enqueue, resourceId: enqueue.resourceId ?? this.newResourceId() },
            this.defaultTopicId
        );
    }
}
