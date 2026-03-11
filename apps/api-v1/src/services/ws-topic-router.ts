import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

const DYNAMIC_TOPIC_ROUTER_CALLBACK_ID = 'dynamic-ws-topic-router';
const DEFAULT_ALLOWED_TOPIC_PREFIXES = ['app.', 'room.', 'rallar.'] as const;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const RESERVED_TOPIC_IDS = new Set<string>(Object.values(AppTopics));

export type DynamicWsTopicRouterOptions = Readonly<{
    allowedTopicPrefixes?: readonly string[];
    maxPayloadBytes?: number;
}>;

export function initDynamicWsTopicRouter(
    wsQBoxServerService: WsQueueBoxServerService,
    options: DynamicWsTopicRouterOptions = {},
): void {
    const router = new DynamicWsTopicRouter(wsQBoxServerService, options);

    wsQBoxServerService.onAnyInboxMessageDo(
        DYNAMIC_TOPIC_ROUTER_CALLBACK_ID,
        {
            onMessage: (
                message: ALMessage,
                entry: ResourceEntry,
                server: JsonWebSocketServer,
            ) => {
                router.handle(message, entry, server);
                return Promise.resolve();
            },
        },
    );
}

class DynamicWsTopicRouter {
    private readonly allowedTopicPrefixes: readonly string[];
    private readonly maxPayloadBytes: number;

    constructor(
        private readonly wsQBoxServerService: WsQueueBoxServerService,
        options: DynamicWsTopicRouterOptions,
    ) {
        this.allowedTopicPrefixes = options.allowedTopicPrefixes ??
            DEFAULT_ALLOWED_TOPIC_PREFIXES;
        this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    }

    handle(
        message: ALMessage,
        _entry: ResourceEntry,
        _server: JsonWebSocketServer,
    ): void {
        if (this.isReservedMessage(message)) {
            return;
        }

        if (!this.isAllowedDynamicTopic(message.route.topicId)) {
            console.warn(`Rejected dynamic WS topic: ${message.route.topicId}`);
            return;
        }

        if (!message.targets) {
            console.warn(
                `Rejected dynamic WS message without targets: ${message.route.topicId}`,
            );
            return;
        }

        if (!this.isPayloadSizeAllowed(message)) {
            console.warn(
                `Rejected oversized dynamic WS payload: ${message.route.topicId}`,
            );
            return;
        }

        if (!this.isAuthorisedForDynamicTopic(message)) {
            console.warn(
                `Rejected unauthorised dynamic WS topic: ${message.route.topicId}`,
            );
            return;
        }

        const sent = this.wsQBoxServerService.sendToTargets(message);
        if (sent === 0) {
            console.warn(
                `Dynamic WS topic had no recipients: ${message.route.topicId}`,
            );
        }
    }

    private isReservedMessage(message: ALMessage): boolean {
        return RESERVED_TOPIC_IDS.has(message.route.topicId);
    }

    private isAllowedDynamicTopic(topicId: string): boolean {
        return this.allowedTopicPrefixes.some((prefix) => topicId.startsWith(prefix));
    }

    private isPayloadSizeAllowed(message: ALMessage): boolean {
        return new TextEncoder().encode(message.payload.resource).length <=
            this.maxPayloadBytes;
    }

    private isAuthorisedForDynamicTopic(message: ALMessage): boolean {
        if (!this.isRoomScoped(message)) {
            return true;
        }

        const groupId = this.readRoomId(message);
        if (!groupId) {
            return false;
        }

        const snapshot = groupStateSnapshotsRepository.findGroupStateSnapshotById(
            groupId,
        );

        return !!snapshot &&
            isGroupActive(snapshot) &&
            isSessionInGroup(snapshot, message.id.senderId);
    }

    private isRoomScoped(message: ALMessage): boolean {
        return message.route.topicId.startsWith('room.') ||
            message.targets?.mode === 'multicast' ||
            (message.targets?.mode === 'broadcast' &&
                message.targets.scope === 'room');
    }

    private readRoomId(message: ALMessage): string | undefined {
        if (message.targets?.mode === 'multicast') {
            return message.targets.groupId;
        }

        if (
            message.targets?.mode === 'broadcast' && message.targets.scope === 'room'
        ) {
            return message.route.contextId;
        }

        if (message.route.topicId.startsWith('room.')) {
            return message.route.contextId;
        }

        return undefined;
    }
}
