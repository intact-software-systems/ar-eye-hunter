import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/ALOutboundMessageRuntime.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import {
    recordRallarTiming,
    type RallarTimingSink,
} from './services/timing.ts';

export type StateSyncPublisher = Readonly<{
    publishClientSnapshot(
        snapshot: ClientSnapshot,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void | StateSyncSnapshotPublishResult>;
    publishClientEvent(
        event: ClientEvent,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void>;
    publishGroupSnapshot(
        snapshot: GroupSnapshot,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void | StateSyncSnapshotPublishResult>;
    publishGroupEvent(
        event: GroupEvent,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void>;
}>;

export type StateSyncSnapshotPublishResult = Readonly<{
    effectiveSnapshotRevision: number;
}>;

export type CreateWsStateSyncPublisherOptions = Readonly<{
    serverId: string;
    timing?: RallarTimingSink;
}>;

export function createWsStateSyncPublisher(
    wsQBoxServerService: WsQueueBoxServerService,
    options: CreateWsStateSyncPublisherOptions,
): StateSyncPublisher {
    return {
        publishClientSnapshot: async (snapshot, senderId, deliveryId) => {
            const result = await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.principal.principalId,
                AppTopics.clientStateSnapshot,
                snapshot.principal.principalId,
                snapshot.principal.principalId,
                snapshot,
                {
                    requireLiveRoute: hasActiveClientSessions(snapshot),
                    timing: options.timing,
                    deliveryId,
                },
            );
            return readStateSyncSnapshotPublishResult(result);
        },
        publishClientEvent: async (event, senderId, deliveryId) => {
            const snapshot = clientStateSnapshotsRepository
                .findClientStateSnapshotByPrincipalId(event.principalId);
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? mutationActorSenderId(event.actor),
                AppTopics.clientStateEvent,
                event.principalId,
                event.eventId,
                event,
                {
                    requireLiveRoute: snapshot
                        ? hasActiveClientSessions(snapshot)
                        : false,
                    timing: options.timing,
                    deliveryId,
                },
            );
        },
        publishGroupSnapshot: async (snapshot, senderId, deliveryId) => {
            const stateResult = await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.group.groupId,
                AppTopics.groupStateSnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
                snapshot,
                {
                    requireLiveRoute: hasActiveGroupSessions(snapshot),
                    timing: options.timing,
                    deliveryId,
                },
            );
            const directoryResult = await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.group.groupId,
                AppTopics.groupDirectorySnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
                snapshot,
                {
                    timing: options.timing,
                    deliveryId,
                },
            );
            return combineStateSyncSnapshotPublishResults(
                readStateSyncSnapshotPublishResult(stateResult),
                readStateSyncSnapshotPublishResult(directoryResult),
            );
        },
        publishGroupEvent: async (event, senderId, deliveryId) => {
            const snapshot = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(
                {
                    applicationId: event.applicationId,
                    workspaceId: event.workspaceId,
                    groupId: event.groupId,
                },
            );
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? mutationActorSenderId(event.actor),
                AppTopics.groupStateEvent,
                event.groupId,
                event.eventId,
                event,
                {
                    requireLiveRoute: snapshot
                        ? hasActiveGroupSessions(snapshot)
                        : false,
                    timing: options.timing,
                    deliveryId,
                },
            );
        },
    };
}

async function enqueueBroadcast<T>(
    wsQBoxServerService: WsQueueBoxServerService,
    senderId: string,
    topicId: string,
    contextId: string,
    resourceId: string,
    payload: T,
    options: Readonly<{
        requireLiveRoute?: boolean;
        timing?: RallarTimingSink;
        deliveryId?: string;
    }> = {},
): Promise<ALOutboundEnqueueResult> {
    const message = newALBroadcastMessage<T>(
        senderId,
        newALEventRoute(topicId, contextId, resourceId),
        'all',
        topicId,
        payload,
    );
    const result = await wsQBoxServerService.enqueueOutboxIfAbsent(
        options.deliveryId
            ? {
                ...message,
                id: {
                    ...message.id,
                    msgId: toStateSyncMessageId(options.deliveryId, topicId),
                },
            }
            : message,
    );

    assertStateSyncPublishResult(result, {
        topicId,
        resourceId,
        requireLiveRoute: options.requireLiveRoute ?? false,
        timing: options.timing,
    });
    return result;
}

export function toStateSyncMessageId(
    deliveryId: string,
    topicId: string,
): string {
    return `state-sync-${fnv1a64(`${deliveryId}\u0000${topicId}`)}`;
}

function readStateSyncSnapshotPublishResult(
    result: ALOutboundEnqueueResult,
): StateSyncSnapshotPublishResult | undefined {
    // The current AL duplicate result can reconstruct entry.resource from the
    // retry candidate while retaining only the persisted winner's key. Until
    // that boundary marks winner provenance explicitly, only a fresh enqueue
    // proves that the returned resource is the effective durable payload.
    if (result.status !== 'enqueued') {
        return undefined;
    }
    const entries = result.entries.length > 0
        ? result.entries
        : result.entry
        ? [result.entry]
        : [];
    if (entries.length === 0) {
        return undefined;
    }
    const revisions = entries.map((entry) => {
        const message = JSON.parse(entry.resource) as {
            payload?: { resource?: string };
        };
        const snapshot = JSON.parse(message.payload?.resource ?? 'null') as {
            stateRevision?: unknown;
        } | null;
        const revision = snapshot?.stateRevision;
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
            throw new TypeError(
                'State sync durable winner has an invalid snapshot revision',
            );
        }
        return revision as number;
    });
    return {
        effectiveSnapshotRevision: Math.min(...revisions),
    };
}

function combineStateSyncSnapshotPublishResults(
    ...results: readonly (StateSyncSnapshotPublishResult | undefined)[]
): StateSyncSnapshotPublishResult | undefined {
    if (results.some((result) => result === undefined)) {
        return undefined;
    }
    return {
        effectiveSnapshotRevision: Math.min(
            ...results.map((result) => result!.effectiveSnapshotRevision),
        ),
    };
}

function assertStateSyncPublishResult(
    result: ALOutboundEnqueueResult,
    input: Readonly<{
        topicId: string;
        resourceId: string;
        requireLiveRoute: boolean;
        timing?: RallarTimingSink;
    }>,
): void {
    switch (result.status) {
        case 'enqueued':
        case 'sent-immediate':
        case 'duplicate':
            return;
        case 'skipped':
        case 'superseded':
        case 'expired':
            if (!input.requireLiveRoute) {
                return;
            }
            break;
        case 'no-route':
            if (input.requireLiveRoute) {
                console.warn('State sync publish missed live route', {
                    topicId: input.topicId,
                    resourceId: input.resourceId,
                    status: result.status,
                    reason: result.reason,
                });
                recordRallarTiming(
                    input.timing,
                    {
                        component: 'state-sync',
                        operation: 'no-route',
                        details: {
                            topicId: input.topicId,
                            resourceId: input.resourceId,
                            reason: result.reason,
                        },
                    },
                    'ok',
                    0,
                );
            }
            return;
        case 'failed':
        case 'rate-limited':
        case 'circuit-open':
            break;
    }

    throw new Error(
        `State sync publish failed for ${input.topicId}/${input.resourceId}: ${result.status}` +
        (result.reason ? ` (${result.reason})` : ''),
    );
}

function hasActiveClientSessions(snapshot: ClientSnapshot): boolean {
    return snapshot.activeSessions.length > 0 ||
        snapshot.activeSessionCount > 0 ||
        snapshot.isOnline;
}

function hasActiveGroupSessions(snapshot: GroupSnapshot): boolean {
    return snapshot.activeSessions.length > 0 ||
        snapshot.onlineMemberCount > 0;
}

function mutationActorSenderId(actor: MutationActor): string {
    return actor.kind === 'service' ? actor.serviceId : actor.principalId;
}

function fnv1a64(value: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(36);
}
