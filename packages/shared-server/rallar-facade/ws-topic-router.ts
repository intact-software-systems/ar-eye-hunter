import { type ALMessage, type ALTargets, readALTargetGroupRef, } from '@shared/al-contracts/al-contract.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { isALControlTypeId, newALNackControlMessage, } from '@shared/al-contracts/al-control.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { ALOutboundEnqueueResult, ALOutboundEnqueueStatus, } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import {
    WsQueueBoxServerService,
    type WsServerLiveSendFailure,
    type WsServerLiveSendResult,
    type WsServerResolvedRecipient,
} from '@shared/services/WsQueueBoxServerService.ts';

const DYNAMIC_TOPIC_ROUTER_CALLBACK_ID = 'dynamic-ws-topic-router';
const DEFAULT_USER_TOPIC_PREFIXES = ['app.', 'room.'] as const;
const RESERVED_SYSTEM_TOPIC_PREFIXES = ['rallar.'] as const;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const RESERVED_TOPIC_IDS = new Set<string>(Object.values(AppTopics));
const AL_CONTROL_TOPIC_ID = 'al-control';

export type RallarServerWsFanout = 'live-only' | 'outbox' | 'none';

export type RallarServerWsPublishStatus =
    | 'sent-live'
    | 'queued-outbox'
    | 'none'
    | 'no-recipients'
    | 'partial-failure'
    | 'skipped'
    | 'duplicate'
    | 'superseded'
    | 'expired'
    | 'no-route'
    | 'rate-limited'
    | 'circuit-open'
    | 'failed';

export type RallarServerWsPublishResult = Readonly<{
    fanout: RallarServerWsFanout;
    status: RallarServerWsPublishStatus;
    message: ALMessage;
    sentCount?: number;
    recipientCount?: number;
    failedCount?: number;
    recipients?: readonly WsServerResolvedRecipient[];
    failures?: readonly WsServerLiveSendFailure[];
    entry?: ResourceEntry;
    entries: readonly ResourceEntry[];
    enqueueStatus?: ALOutboundEnqueueStatus;
    reason?: string;
}>;

export type RallarServerWsConnectionStatus = Readonly<{
    connectionId: string;
    isOpen: boolean;
}>;

export type RallarServerWsStatus = Readonly<{
    transport: 'ws-server';
    connectionCount: number;
    openConnectionCount: number;
    connectionIds: readonly string[];
    openConnectionIds: readonly string[];
    connections: readonly RallarServerWsConnectionStatus[];
}>;

export type RallarServerWsTopicScope = 'app' | 'room' | 'world';

export type RallarServerWsSelector = Readonly<{
    topicId?: string;
    typeId?: string;
}>;

export type RallarServerWsMessage<T = unknown> = Readonly<{
    payload: T;
    raw: ALMessage;
    receivedAtEpochMs: number;
}>;

export type RallarServerWsValidator<T = unknown> = (
    value: unknown,
    context: RallarServerWsMessageContext<T>,
) => boolean | Promise<boolean>;

export type RallarServerWsAuthorizer<T = unknown> = (
    message: RallarServerWsMessage<T>,
    context: RallarServerWsMessageContext<T>,
) => boolean | Promise<boolean>;

export type RallarServerWsRoomAuthorizationInput = Readonly<{
    message: ALMessage;
    definition?: RallarServerWsTopicDefinition<unknown>;
    roomId: string;
    roomRef?: GroupRef;
    senderId: string;
    topicId: string;
    typeId: string;
    minSnapshotVersion?: number;
}>;

export type RallarServerWsRoomAuthorizationDecision =
    | boolean
    | Readonly<{
    authorized: true;
}>
    | Readonly<{
    authorized: false;
    reason?: ALNackReason;
    logMessage?: string;
    serverSnapshotVersion?: number;
}>;

export type RallarServerWsRoomAuthorizer = (
    input: RallarServerWsRoomAuthorizationInput,
) =>
    | RallarServerWsRoomAuthorizationDecision
    | Promise<RallarServerWsRoomAuthorizationDecision>;

export type RallarServerWsHandler<T = unknown> = (
    message: RallarServerWsMessage<T>,
    context: RallarServerWsMessageContext<T>,
) => void | Promise<void>;

export type RallarServerWsTopicDefinition<T = unknown> = Readonly<{
    topicId: string;
    typeId?: string;
    scope?: RallarServerWsTopicScope;
    validate?: RallarServerWsValidator<T>;
    authorize?: RallarServerWsAuthorizer<T>;
    maxPayloadBytes?: number;
    fanout?: RallarServerWsFanout;
}>;

export type RallarServerWsProxyRule<T = unknown> = Readonly<{
    id?: string;
    from: RallarServerWsSelector;
    authorize?: RallarServerWsAuthorizer<T>;
    transform?: (
        message: RallarServerWsMessage<T>,
        context: RallarServerWsMessageContext<T>,
    ) => ALMessage | Promise<ALMessage>;
    targets?: (
        message: RallarServerWsMessage<T>,
        context: RallarServerWsMessageContext<T>,
    ) => ALTargets | Promise<ALTargets>;
    fanout?: RallarServerWsFanout;
    suppressDefaultFanout?: boolean;
}>;

export type RallarServerWsFacadeOptions = Readonly<{
    maxPayloadBytes?: number;
    sendNacks?: boolean;
    allowImplicitUserTopics?: boolean;
    defaultFanout?: RallarServerWsFanout;
    authorizeRoomMessage?: RallarServerWsRoomAuthorizer;
}>;

export type DynamicWsTopicRouterOptions = RallarServerWsFacadeOptions;

export type RallarServerWsMessageContext<T = unknown> = Readonly<{
    service: WsQueueBoxServerService;
    definition?: RallarServerWsTopicDefinition<T>;
    roomId?: string;
    roomRef?: GroupRef;
    senderId: string;
    proxy: RallarServerWsProxyContext;
}>;

export type RallarServerWsProxyContext = Readonly<{
    toTargets(
        message: ALMessage,
        fanout?: RallarServerWsFanout,
    ): Promise<RallarServerWsPublishResult>;
    toPeer(
        peerId: string,
        message: ALMessage,
        fanout?: RallarServerWsFanout,
    ): Promise<RallarServerWsPublishResult>;
    toRoom(
        roomId: string,
        message: ALMessage,
        options?: Readonly<{
            exceptPeerIds?: readonly string[];
            fanout?: RallarServerWsFanout;
        }>,
    ): Promise<RallarServerWsPublishResult>;
    toAll(
        message: ALMessage,
        options?: Readonly<{
            exceptPeerIds?: readonly string[];
            fanout?: RallarServerWsFanout;
        }>,
    ): Promise<RallarServerWsPublishResult>;
}>;

type RegisteredHandler = Readonly<{
    selector: RallarServerWsSelector;
    handler: RallarServerWsHandler<unknown>;
}>;

export function initDynamicWsTopicRouter(
    wsQBoxServerService: WsQueueBoxServerService,
    options: DynamicWsTopicRouterOptions = {},
): RallarServerWsFacade {
    return new RallarServerWsFacade(wsQBoxServerService, options).install();
}

export class RallarServerWsFacade {
    private readonly definitions: RallarServerWsTopicDefinition<unknown>[] = [];
    private readonly handlers = new Map<string, RegisteredHandler>();
    private readonly proxyRules = new Map<
        string,
        RallarServerWsProxyRule<unknown>
    >();
    private readonly maxPayloadBytes: number;
    private readonly sendNacks: boolean;
    private readonly allowImplicitUserTopics: boolean;
    private readonly defaultFanout: RallarServerWsFanout;
    private readonly authorizeRoomMessage?: RallarServerWsRoomAuthorizer;
    private installed = false;

    constructor(
        private readonly wsQBoxServerService: WsQueueBoxServerService,
        options: RallarServerWsFacadeOptions = {},
    ) {
        this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
        this.sendNacks = options.sendNacks ?? true;
        this.allowImplicitUserTopics = options.allowImplicitUserTopics ?? true;
        this.defaultFanout = options.defaultFanout ?? 'live-only';
        this.authorizeRoomMessage = options.authorizeRoomMessage;
    }

    install(): this {
        if (this.installed) {
            return this;
        }

        this.wsQBoxServerService.onAnyInboxMessageDo(
            DYNAMIC_TOPIC_ROUTER_CALLBACK_ID,
            {
                onMessage: async (
                    message: ALMessage,
                    entry: ResourceEntry,
                    server: JsonWebSocketServer,
                ) => {
                    await this.handle(message, entry, server);
                },
            },
        );
        this.installed = true;
        return this;
    }

    uninstall(): boolean {
        this.installed = false;
        return this.wsQBoxServerService.removeAnyInboxMessageCallback(
            DYNAMIC_TOPIC_ROUTER_CALLBACK_ID,
        );
    }

    defineTopic<T>(definition: RallarServerWsTopicDefinition<T>): this {
        this.assertUserTopic(definition.topicId);

        const exists = this.definitions.some((registered) =>
            registered.topicId === definition.topicId &&
            registered.typeId === definition.typeId
        );
        if (exists) {
            throw new Error(
                `Rallar WS topic already defined: ${toSelectorKey(definition)}`,
            );
        }

        this.definitions.push(
            definition as RallarServerWsTopicDefinition<unknown>,
        );
        return this;
    }

    removeTopic(selector: RallarServerWsSelector): boolean {
        const index = this.definitions.findIndex((definition) =>
            matchesSelector(selector, {
                route: { topicId: definition.topicId },
                payload: { typeId: definition.typeId ?? '' },
            })
        );
        if (index < 0) {
            return false;
        }

        this.definitions.splice(index, 1);
        return true;
    }

    on<T>(
        selector: RallarServerWsSelector,
        handler: RallarServerWsHandler<T>,
    ): () => boolean {
        assertSelector(selector);

        const id = `handler:${crypto.randomUUID()}`;
        this.handlers.set(id, {
            selector,
            handler: handler as RallarServerWsHandler<unknown>,
        });
        return () => this.handlers.delete(id);
    }

    proxy<T>(rule: RallarServerWsProxyRule<T>): () => boolean {
        assertSelector(rule.from);

        const id = rule.id ?? `proxy:${crypto.randomUUID()}`;
        if (this.proxyRules.has(id)) {
            throw new Error(`Rallar WS proxy rule already exists: ${id}`);
        }

        this.proxyRules.set(id, rule as RallarServerWsProxyRule<unknown>);
        return () => this.proxyRules.delete(id);
    }

    async publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout,
    ): Promise<RallarServerWsPublishResult> {
        return await this.dispatchFanout(message, fanout ?? this.defaultFanout);
    }

    status(): RallarServerWsStatus {
        const socketConnections = this.wsQBoxServerService.socket.connections;
        const connections: readonly RallarServerWsConnectionStatus[] =
            socketConnections instanceof Map
                ? [...socketConnections.values()].map((ctx) => ({
                    connectionId: ctx.id,
                    isOpen: ctx.isOpen,
                }))
                : [];
        const openConnectionIds = connections
            .filter((connection) => connection.isOpen)
            .map((connection) => connection.connectionId);

        return {
            transport: 'ws-server',
            connectionCount: connections.length,
            openConnectionCount: openConnectionIds.length,
            connectionIds: connections.map((connection) => connection.connectionId),
            openConnectionIds,
            connections,
        };
    }

    async handle(
        message: ALMessage,
        _entry?: ResourceEntry,
        _server?: JsonWebSocketServer,
    ): Promise<void> {
        if (this.isSystemMessage(message)) {
            return;
        }

        if (this.isReservedSystemTopic(message.route.topicId)) {
            this.reject(
                message,
                'unauthorized',
                `Rejected reserved Rallar WS topic: ${message.route.topicId}`,
            );
            return;
        }

        const definition = this.findDefinition(message);
        if (!definition && !this.isImplicitUserTopic(message.route.topicId)) {
            this.reject(
                message,
                'no-route',
                `Rejected unknown WS topic: ${message.route.topicId}`,
            );
            return;
        }

        if (!message.targets) {
            this.reject(
                message,
                'no-route',
                `Rejected dynamic WS message without targets: ${message.route.topicId}`,
            );
            return;
        }

        const maxPayloadBytes = definition?.maxPayloadBytes ?? this.maxPayloadBytes;
        if (!this.isPayloadSizeAllowed(message, maxPayloadBytes)) {
            this.reject(
                message,
                'overloaded',
                `Rejected oversized dynamic WS payload: ${message.route.topicId}`,
            );
            return;
        }

        const decoded = this.decodeMessage(message);
        if (!decoded.ok) {
            this.reject(
                message,
                'no-route',
                `Rejected dynamic WS message with invalid JSON payload: ${message.route.topicId}`,
            );
            return;
        }

        const serverMessage = toRallarServerWsMessage(decoded.value, message);
        const context = this.toMessageContext(definition, message);

        const authorization = await this.authorizeDynamicTopic(message, definition);
        if (!authorization.authorized) {
            this.reject(
                message,
                authorization.reason ?? 'unauthorized',
                authorization.logMessage ??
                `Rejected unauthorised dynamic WS topic: ${message.route.topicId}`,
                {
                    serverSnapshotVersion: authorization.serverSnapshotVersion,
                },
            );
            return;
        }

        if (definition?.validate) {
            const valid = await definition.validate(decoded.value, context);
            if (!valid) {
                this.reject(
                    message,
                    'no-route',
                    `Rejected schema-invalid dynamic WS payload: ${message.route.topicId}/${message.payload.typeId}`,
                );
                return;
            }
        }

        if (definition?.authorize) {
            const authorised = await definition.authorize(serverMessage, context);
            if (!authorised) {
                this.reject(
                    message,
                    'unauthorized',
                    `Rejected policy-unauthorised dynamic WS topic: ${message.route.topicId}`,
                );
                return;
            }
        }

        await this.dispatchHandlers(serverMessage, context);
        const suppressDefaultFanout = await this.dispatchProxyRules(
            serverMessage,
            context,
        );

        if (!suppressDefaultFanout) {
            await this.dispatchFanout(
                message,
                definition?.fanout ?? this.defaultFanout,
            );
        }
    }

    private async dispatchHandlers<T>(
        message: RallarServerWsMessage<T>,
        context: RallarServerWsMessageContext<T>,
    ): Promise<void> {
        for (const registered of this.handlers.values()) {
            if (!matchesSelector(registered.selector, message.raw)) {
                continue;
            }

            try {
                await registered.handler(
                    message as RallarServerWsMessage<unknown>,
                    context as RallarServerWsMessageContext<unknown>,
                );
            } catch (error) {
                console.error(
                    `Error in Rallar WS handler for ${toSelectorKey(registered.selector)}`,
                    error,
                );
            }
        }
    }

    private async dispatchProxyRules<T>(
        message: RallarServerWsMessage<T>,
        context: RallarServerWsMessageContext<T>,
    ): Promise<boolean> {
        let suppressDefaultFanout = false;

        for (const rule of this.proxyRules.values()) {
            if (!matchesSelector(rule.from, message.raw)) {
                continue;
            }

            try {
                if (rule.authorize) {
                    const authorised = await rule.authorize(
                        message as RallarServerWsMessage<unknown>,
                        context as RallarServerWsMessageContext<unknown>,
                    );
                    if (!authorised) {
                        continue;
                    }
                }

                const transformed = rule.transform
                    ? await rule.transform(
                        message as RallarServerWsMessage<unknown>,
                        context as RallarServerWsMessageContext<unknown>,
                    )
                    : message.raw;
                const targets = rule.targets
                    ? await rule.targets(
                        message as RallarServerWsMessage<unknown>,
                        context as RallarServerWsMessageContext<unknown>,
                    )
                    : transformed.targets;

                if (!targets) {
                    continue;
                }

                await this.dispatchFanout(
                    {
                        ...transformed,
                        targets,
                    },
                    rule.fanout ?? context.definition?.fanout ?? this.defaultFanout,
                );

                suppressDefaultFanout = suppressDefaultFanout ||
                    (rule.suppressDefaultFanout ?? false);
            } catch (error) {
                console.error(
                    `Error in Rallar WS proxy for ${toSelectorKey(rule.from)}`,
                    error,
                );
            }
        }

        return suppressDefaultFanout;
    }

    private async dispatchFanout(
        message: ALMessage,
        fanout: RallarServerWsFanout,
    ): Promise<RallarServerWsPublishResult> {
        switch (fanout) {
            case 'none':
                return {
                    fanout,
                    status: 'none',
                    message,
                    sentCount: 0,
                    entries: [],
                };
            case 'outbox': {
                const result = await this.wsQBoxServerService.enqueueOutboxIfAbsent(
                    message,
                );
                return toOutboxPublishResult(message, fanout, result);
            }
            case 'live-only': {
                const result = this.wsQBoxServerService.sendToTargetsWithResult(
                    message,
                );
                if (result.status === 'no-recipients') {
                    console.warn(
                        `Dynamic WS topic had no recipients: ${message.route.topicId}`,
                    );
                }
                return toLivePublishResult(message, fanout, result);
            }
        }
    }

    private toMessageContext<T>(
        definition: RallarServerWsTopicDefinition<T> | undefined,
        message: ALMessage,
    ): RallarServerWsMessageContext<T> {
        return {
            service: this.wsQBoxServerService,
            definition,
            roomId: this.readRoomId(message),
            roomRef: this.readRoomRef(message),
            senderId: message.id.senderId,
            proxy: {
                toTargets: async (targetMessage, fanout) =>
                    await this.dispatchFanout(
                        targetMessage,
                        fanout ?? definition?.fanout ?? this.defaultFanout,
                    ),
                toPeer: async (peerId, targetMessage, fanout) =>
                    await this.dispatchFanout(
                        {
                            ...targetMessage,
                            targets: {
                                mode: 'unicast',
                                toPeerId: peerId,
                            },
                        },
                        fanout ?? definition?.fanout ?? this.defaultFanout,
                    ),
                toRoom: async (roomId, targetMessage, options) =>
                    await this.dispatchFanout(
                        {
                            ...targetMessage,
                            route: {
                                ...targetMessage.route,
                                contextId: roomId,
                            },
                            targets: {
                                mode: 'broadcast',
                                scope: 'room',
                                exceptPeerIds: options?.exceptPeerIds,
                            },
                        },
                        options?.fanout ?? definition?.fanout ?? this.defaultFanout,
                    ),
                toAll: async (targetMessage, options) =>
                    await this.dispatchFanout(
                        {
                            ...targetMessage,
                            targets: {
                                mode: 'broadcast',
                                scope: 'all',
                                exceptPeerIds: options?.exceptPeerIds,
                            },
                        },
                        options?.fanout ?? definition?.fanout ?? this.defaultFanout,
                    ),
            },
        };
    }

    private findDefinition(
        message: ALMessage,
    ): RallarServerWsTopicDefinition<unknown> | undefined {
        return this.definitions.find((definition) =>
            definition.topicId === message.route.topicId &&
            (definition.typeId === undefined ||
                definition.typeId === message.payload.typeId)
        );
    }

    private assertUserTopic(topicId: string): void {
        if (this.isReservedSystemTopic(topicId)) {
            throw new Error(`Rallar system WS topic is reserved: ${topicId}`);
        }

        if (!this.isUserTopic(topicId)) {
            throw new Error(
                `Rallar user WS topic must start with ${DEFAULT_USER_TOPIC_PREFIXES.join(' or ')}: ${topicId}`,
            );
        }
    }

    private isSystemMessage(message: ALMessage): boolean {
        return RESERVED_TOPIC_IDS.has(message.route.topicId) ||
            message.route.topicId === AL_CONTROL_TOPIC_ID ||
            isALControlTypeId(message.payload.typeId);
    }

    private isReservedSystemTopic(topicId: string): boolean {
        return RESERVED_SYSTEM_TOPIC_PREFIXES.some((prefix) =>
            topicId.startsWith(prefix)
        );
    }

    private isImplicitUserTopic(topicId: string): boolean {
        return this.allowImplicitUserTopics && this.isUserTopic(topicId);
    }

    private isUserTopic(topicId: string): boolean {
        return DEFAULT_USER_TOPIC_PREFIXES.some((prefix) => topicId.startsWith(prefix));
    }

    private isPayloadSizeAllowed(
        message: ALMessage,
        maxPayloadBytes: number,
    ): boolean {
        return new TextEncoder().encode(message.payload.resource).length <=
            maxPayloadBytes;
    }

    private async authorizeDynamicTopic(
        message: ALMessage,
        definition?: RallarServerWsTopicDefinition<unknown>,
    ): Promise<Readonly<{
        authorized: boolean;
        reason?: ALNackReason;
        logMessage?: string;
        serverSnapshotVersion?: number;
    }>> {
        if (!this.isRoomScoped(message, definition)) {
            return { authorized: true };
        }

        const roomId = this.readRoomId(message);
        if (!roomId || !this.authorizeRoomMessage) {
            return { authorized: false };
        }

        return normalizeRoomAuthorizationDecision(
            await this.authorizeRoomMessage({
                message,
                definition,
                roomId,
                roomRef: this.readRoomRef(message),
                senderId: message.id.senderId,
                topicId: message.route.topicId,
                typeId: message.payload.typeId,
                minSnapshotVersion: this.readMinSnapshotVersion(message),
            }),
            message,
        );
    }

    private isRoomScoped(
        message: ALMessage,
        definition?: RallarServerWsTopicDefinition<unknown>,
    ): boolean {
        return definition?.scope === 'room' ||
            message.route.topicId.startsWith('room.') ||
            message.targets?.mode === 'multicast' ||
            (message.targets?.mode === 'broadcast' &&
                message.targets.scope === 'room');
    }

    private readRoomId(message: ALMessage): string | undefined {
        const groupRef = readALTargetGroupRef(message);
        if (groupRef) {
            return groupRef.groupId;
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

    private readRoomRef(message: ALMessage): GroupRef | undefined {
        const roomId = this.readRoomId(message);
        return roomId
            ? readALTargetGroupRef(message)
            : undefined;
    }

    private readMinSnapshotVersion(message: ALMessage): number | undefined {
        const targets = message.targets;
        if (
            targets?.mode === 'multicast' ||
            targets?.mode === 'broadcast'
        ) {
            return targets.minSnapshotVersion;
        }

        return undefined;
    }

    private decodeMessage(message: ALMessage):
        | Readonly<{
        ok: true;
        value: unknown;
    }>
        | Readonly<{
        ok: false;
    }> {
        try {
            return {
                ok: true,
                value: JSON.parse(message.payload.resource),
            };
        } catch {
            return { ok: false };
        }
    }

    private reject(
        message: ALMessage,
        reason: ALNackReason,
        logMessage: string,
        nackOptions: Readonly<{
            serverSnapshotVersion?: number;
        }> = {},
    ): void {
        console.warn(logMessage);
        if (!this.sendNacks) {
            return;
        }

        this.trySendNack(message, reason, nackOptions);
    }

    private trySendNack(
        message: ALMessage,
        reason: ALNackReason,
        options: Readonly<{
            serverSnapshotVersion?: number;
        }> = {},
    ): void {
        try {
            const nack = newALNackControlMessage(
                this.wsQBoxServerService.name,
                message.id.senderId,
                message.id.msgId,
                reason,
                undefined,
                options,
            );
            const sent = this.wsQBoxServerService.sendToTargets(nack);
            if (sent === 0) {
                console.warn(
                    `Could not send WS NACK to ${message.id.senderId} for ${message.id.msgId}`,
                );
            }
        } catch (error) {
            console.warn(
                `Failed to send WS NACK to ${message.id.senderId} for ${message.id.msgId}`,
                error,
            );
        }
    }
}

function toLivePublishResult(
    message: ALMessage,
    fanout: RallarServerWsFanout,
    result: WsServerLiveSendResult,
): RallarServerWsPublishResult {
    return {
        fanout,
        status: result.status,
        message,
        sentCount: result.sentCount,
        recipientCount: result.recipientCount,
        failedCount: result.failedCount,
        recipients: result.recipients,
        failures: result.failures,
        entries: [],
    };
}

function toOutboxPublishResult(
    message: ALMessage,
    fanout: RallarServerWsFanout,
    result: ALOutboundEnqueueResult,
): RallarServerWsPublishResult {
    return {
        fanout,
        status: toOutboxPublishStatus(result.status),
        message,
        entry: result.entry,
        entries: result.entries,
        enqueueStatus: result.status,
        reason: result.reason,
    };
}

function toOutboxPublishStatus(
    status: ALOutboundEnqueueStatus,
): RallarServerWsPublishStatus {
    switch (status) {
        case 'enqueued':
            return 'queued-outbox';
        case 'sent-immediate':
            return 'sent-live';
        case 'skipped':
        case 'duplicate':
        case 'superseded':
        case 'expired':
        case 'no-route':
        case 'rate-limited':
        case 'circuit-open':
        case 'failed':
            return status;
    }
}

function toRallarServerWsMessage<T>(
    payload: T,
    raw: ALMessage,
): RallarServerWsMessage<T> {
    return {
        payload,
        raw,
        receivedAtEpochMs: Date.now(),
    };
}

function normalizeRoomAuthorizationDecision(
    decision: RallarServerWsRoomAuthorizationDecision,
    message: ALMessage,
): Readonly<{
    authorized: boolean;
    reason?: ALNackReason;
    logMessage?: string;
    serverSnapshotVersion?: number;
}> {
    if (typeof decision === 'boolean') {
        return {
            authorized: decision,
        };
    }

    if (decision.authorized) {
        return {
            authorized: true,
        };
    }

    return {
        authorized: false,
        reason: decision.reason,
        logMessage: decision.logMessage ??
            `Rejected unauthorised dynamic WS topic: ${message.route.topicId}`,
        serverSnapshotVersion: decision.serverSnapshotVersion,
    };
}

function assertSelector(selector: RallarServerWsSelector): void {
    if (!selector.topicId && !selector.typeId) {
        throw new Error('Rallar WS selector requires topicId or typeId.');
    }
}

function matchesSelector(
    selector: RallarServerWsSelector,
    message: Readonly<{
        route: Pick<ALMessage['route'], 'topicId'>;
        payload: Pick<ALMessage['payload'], 'typeId'>;
    }>,
): boolean {
    return (selector.topicId === undefined ||
            selector.topicId === message.route.topicId) &&
        (selector.typeId === undefined ||
            selector.typeId === message.payload.typeId);
}

function toSelectorKey(selector: RallarServerWsSelector): string {
    return `${selector.topicId ?? '*'}/${selector.typeId ?? '*'}`;
}
