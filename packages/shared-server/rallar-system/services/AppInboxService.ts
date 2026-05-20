import { ALMessage, newALRoute, newALUntargetedMessage, } from '@shared/al-contracts/al-contract.ts';
import type {
    ConnectGroupPresenceSessionRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    StateScope,
    UpdateGroupRequest,
    UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
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
import type {
    GroupMutationWritten,
    GroupStateService,
    GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';

export const SIMPLER_GROUP_STATE_APP_INBOX_TOPIC = 'app-inbox.group-state';

export enum AppInboxType {
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

export type GroupCreateAppInboxPayload = Readonly<{
    scope: StateScope;
    request: CreateGroupRequest;
}>;

export type GroupUpdateAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: UpdateGroupRequest;
}>;

export type GroupMemberUpsertAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: UpsertGroupMemberRequest;
}>;

export type GroupPresenceConnectAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: ConnectGroupPresenceSessionRequest;
}>;

export type GroupPresenceHeartbeatAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: HeartbeatGroupPresenceSessionRequest;
}>;

export type GroupPresenceDisconnectAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: DisconnectGroupPresenceSessionRequest;
}>;

export class AppInboxService {
    static MAX_ELAPSED_MSECS = 10_000;

    constructor(
        public readonly inbox: InboxQueueReader,
        public readonly resourceInbox: ResourceInboxRepository,
        public readonly resourceInboxResults: ResourceInboxResultsRepository,
        public readonly groupStateService: GroupStateService,
        public readonly stateSyncPublisher: StateSyncPublisher,
        public readonly serviceId: string,
    ) {
        this.onGroupStateMessage<GroupCreateAppInboxPayload>(
            AppInboxType.GROUP_CREATE,
            async (groupCreate) => {
                const groupStateWritten = await this.groupStateService.createGroup(
                    groupCreate.scope,
                    groupCreate.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onGroupStateMessage<GroupUpdateAppInboxPayload>(
            AppInboxType.GROUP_UPDATE,
            async (update) => {
                const groupStateWritten = await this.groupStateService.updateGroup(
                    update.scope,
                    update.groupId,
                    update.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onGroupStateMessage<GroupMemberUpsertAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_UPSERT,
            async (member) => {
                const groupStateWritten = await this.groupStateService.upsertMember(
                    member.scope,
                    member.groupId,
                    member.principalId,
                    member.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onGroupStateMessage<GroupPresenceConnectAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_CONNECT,
            async (presence) => {
                const groupStateWritten =
                    await this.groupStateService.connectPresenceSession(
                        presence.scope,
                        presence.groupId,
                        presence.sessionId,
                        presence.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onGroupStateMessage<GroupPresenceHeartbeatAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            async (presence) => {
                const groupStateWritten =
                    await this.groupStateService.heartbeatPresenceSession(
                        presence.scope,
                        presence.groupId,
                        presence.sessionId,
                        presence.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onGroupStateMessage<GroupPresenceDisconnectAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_DISCONNECT,
            async (presence) => {
                const groupStateWritten =
                    await this.groupStateService.disconnectPresenceSession(
                        presence.scope,
                        presence.groupId,
                        presence.sessionId,
                        presence.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
    }

    public async processEntryNoWaiting<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ) {
        this.processEntryUntilCompletionInternal(enqueue, false)
            .catch((err) => {
                console.error(`Error processing entry without waiting: ${err}`);
            });
    }

    public async processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): Promise<Either<string, R>> {
        return this.processEntryUntilCompletionInternal(enqueue, true);
    }

    public async processEntryUntilCompletionInternal<V, R = V>(
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

        const isCompleted =
            await tryWithPolicy<boolean>(
                async () => {
                    const isCompleted = await this.resourceInbox.isEntryWithStatus(key, [
                        EntityStatus.COMPLETED,
                        EntityStatus.FAILED,
                    ]);

                    if (!isCompleted) {
                        throw new Error('App inbox entry not found');
                    }

                    return true;
                },
                TryWithPolicy.defaults()
                    .maxElapsedMsecs(AppInboxService.MAX_ELAPSED_MSECS)
            );

        if (!isCompleted) {
            return Either.ofLeft('App inbox entry not completed');
        }

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

    private onGroupStateMessage<V>(
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

    private async publishGroupStateWritten(
        groupStateWritten: GroupStateWritten,
    ): Promise<void> {
        const result = groupStateWritten.result as
            | GroupStateWritten['result']
            | {
            left?: string;
            right?: GroupMutationWritten;
        };

        if ('fold' in result && typeof result.fold === 'function') {
            await result.fold(
                async () => undefined,
                async (written) => await this.publishGroupMutation(written),
            );
            return;
        }

        if (result.right) {
            await this.publishGroupMutation(result.right);
        }
    }

    private async publishGroupMutation(
        written: GroupMutationWritten,
    ): Promise<void> {
        if (!written.event) {
            return;
        }

        await this.stateSyncPublisher.publishGroupSnapshot(
            written.snapshot,
            this.serviceId,
        );

        await this.stateSyncPublisher.publishGroupEvent(
            written.event,
            this.serviceId,
        );
    }

    private toKey<V>(enqueue: AppInboxEnqueueInput<V>) {
        return {
            topicId: toQueueKeyPart(
                enqueue.topicId ?? SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
                36,
            ),
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
