import { ALMessage, newALRoute, newALUntargetedMessage, } from '@shared/al-contracts/al-contract.ts';
import {
    EntityStatus,
    Key,
    ResourceEntry,
    toResourceEntryWithUpdatedResource,
} from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { TryWithPolicy, tryWithPolicy } from '@shared/resilience/TryWith.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';

export const SIMPLER_GROUP_STATE_APP_INBOX_TOPIC = 'app-inbox.group-state';
export const SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC = 'app-inbox.client-state';

export enum AppInboxType {
    CLIENT_PRINCIPAL_UPSERT = 'CLIENT_PRINCIPAL_UPSERT',
    CLIENT_INSTANCE_UPSERT = 'CLIENT_INSTANCE_UPSERT',
    CLIENT_SESSION_CONNECT = 'CLIENT_SESSION_CONNECT',
    CLIENT_SESSION_HEARTBEAT = 'CLIENT_SESSION_HEARTBEAT',
    CLIENT_SESSION_DISCONNECT = 'CLIENT_SESSION_DISCONNECT',
    GROUP_CREATE = 'GROUP_CREATE',
    GROUP_UPDATE = 'GROUP_UPDATE',
    GROUP_MEMBER_UPSERT = 'GROUP_MEMBER_UPSERT',
    GROUP_PRESENCE_CONNECT = 'GROUP_PRESENCE_CONNECT',
    GROUP_PRESENCE_HEARTBEAT = 'GROUP_PRESENCE_HEARTBEAT',
    GROUP_PRESENCE_DISCONNECT = 'GROUP_PRESENCE_DISCONNECT',
}

export type AppInboxEnqueueInput<V> = {
    type: AppInboxType;
    topicId?: string;
    resourceId?: string;
    contextId?: string;
    senderId?: string;
    data: V;
};

export class AppInboxService {
    public static readonly MAX_ELAPSED_MSECS = 10_000;

    constructor(
        public readonly inbox: InboxQueueReader,
        public readonly resourceInbox: ResourceInboxRepository,
        public readonly resourceInboxResults: ResourceInboxResultsRepository,
        public readonly serviceId: string,
        private readonly defaultTopicId: string = SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
    ) {
    }

    public processEntryNoWaiting<V, R = V>(enqueue: AppInboxEnqueueInput<V>) {
        this.processEntryUntilCompletionInternal(enqueue, false).catch((err) => {
            console.error(`Error processing entry without waiting: ${err}`);
        });
    }

    public async processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): Promise<Either<string, R>> {
        return await this.processEntryUntilCompletionInternal(enqueue, true);
    }

    private async processEntryUntilCompletionInternal<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        waitForCompletion: boolean,
    ): Promise<Either<string, R>> {
        const key: Key = this.toKey(enqueue);

        await this.inbox.enqueueIfAbsent(
            newALUntargetedMessage(
                toQueueKeyPart(this.serviceId, 16),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                enqueue.type.toString(),
                enqueue,
            ),
        );

        if (!waitForCompletion) {
            return Either.ofLeft('No waiting for completion');
        }

        const isCompleted = await tryWithPolicy<boolean>(async () => {
            const isCompleted = await this.resourceInbox.isEntryWithStatus(key, [
                EntityStatus.COMPLETED,
                EntityStatus.FAILED,
            ]);

            if (!isCompleted) {
                throw new Error('App inbox entry not found');
            }

            return true;
        }, TryWithPolicy.defaults().maxElapsedMsecs(AppInboxService.MAX_ELAPSED_MSECS));

        if (!isCompleted) {
            return Either.ofLeft('App inbox entry not completed');
        }

        return await this.findByKeyAndReturnEither<R>(key);
    }

    private async findByKeyAndReturnEither<R>(
        key: Key,
    ): Promise<Either<string, R>> {
        const result = await this.resourceInboxResults.findByKey(key);
        if (result === undefined) {
            return Either.ofLeft('App inbox entry not found');
        }
        if (result.status === EntityStatus.FAILED) {
            return Either.ofLeft(toAppInboxErrorMessage(result.resource));
        }
        if (result.status !== EntityStatus.COMPLETED) {
            return Either.ofLeft('App inbox entry not completed');
        }

        return Either.ofRight(JSON.parse(result.resource) as R);
    }

    onStateMessage<V>(
        type: AppInboxType,
        handler: (data: V) => Promise<unknown>,
    ): void {
        this.inbox.onInboxMessageDo(type, {
            onMessage: async (message: ALMessage, entry: ResourceEntry) => {
                const enqueue = JSON.parse(
                    message.payload.resource,
                ) as AppInboxEnqueueInput<V>;

                try {
                    const result = await handler(enqueue.data);
                    await this.writeAppInboxResult(entry, EntityStatus.COMPLETED, result);
                } catch (error) {
                    // TODO: Only FAILED if it is a non-retryable error
                    await this.writeAppInboxResult(
                        entry,
                        EntityStatus.FAILED,
                        error instanceof Error ? error.message : String(error),
                    );
                }
            },
        });
    }

    private async writeAppInboxResult(
        entry: ResourceEntry,
        status: EntityStatus.COMPLETED | EntityStatus.FAILED,
        value: unknown,
    ): Promise<void> {
        await this.resourceInboxResults.writeIfAbsentOrReplaceExpired(
            toResourceEntryWithUpdatedResource(entry, status, value),
        );
    }

    private toKey<V>(enqueue: AppInboxEnqueueInput<V>) {
        return {
            topicId: toQueueKeyPart(enqueue.topicId ?? this.defaultTopicId, 36),
            resourceId: toQueueKeyPart(
                enqueue.resourceId ?? crypto.randomUUID().toString(),
                36,
            ),
            contextId: toQueueKeyPart(
                enqueue.contextId ?? enqueue.senderId ?? 'rallar-server',
                35,
            ),
        };
    }
}

function toAppInboxErrorMessage(resource: string): string {
    try {
        const parsed = JSON.parse(resource) as unknown;
        if (typeof parsed === 'string') {
            return parsed;
        }
        if (
            parsed &&
            typeof parsed === 'object' &&
            'error' in parsed &&
            typeof parsed.error === 'string'
        ) {
            return parsed.error;
        }
        return JSON.stringify(parsed);
    } catch {
        return resource;
    }
}

function toQueueKeyPart(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    const hash = fnv1a64(value);
    const separator = '-';
    const prefixLength = Math.max(0, maxLength - hash.length - separator.length);
    const prefix = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, prefixLength);

    return `${prefix}${separator}${hash}`.slice(0, maxLength);
}

function fnv1a64(value: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;

    for (let i = 0; i < value.length; i += 1) {
        hash ^= BigInt(value.charCodeAt(i));
        hash = BigInt.asUintN(64, hash * prime);
    }

    return hash.toString(36);
}
