import * as api from '@shared-web/browser/api-integration.ts';
import type {
    RallarListPeopleEventsOptions,
    RallarListRoomEventsInput,
    RallarListRoomEventsOptions,
    RallarMessage,
    RallarPeopleEventListener,
    RallarPeopleEventOptions,
    RallarReplayEventsResult,
    RallarReplayPeopleEventsOptions,
    RallarReplayRoomEventsInput,
    RallarReplayRoomEventsOptions,
    RallarRoomEventListener,
    RallarRoomEventOptions,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-facade-contract.ts';
import {
    type RallarOperationOptions,
    toRallarCommandOptions,
} from '@shared-web/browser/rallar-operation-options.ts';
import { toRallarMessage } from '@shared-web/browser/rallar-runtime/message-conversion.ts';
import type { RallarStateEventsPort } from '@shared-web/browser/rallar-runtime/contracts.ts';
import { notifyStateEventListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import {
    newALBroadcastMessage,
    newALRoute,
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type {
    StateEventCursor,
    StateEventPage,
} from '@shared/api/state-event-types.ts';
import {
    DEFAULT_STATE_WORKSPACE_ID,
    type StateScope,
} from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';

const MAX_RALLAR_STATE_EVENT_DEDUPE_KEYS = 1_000;
const DEFAULT_RALLAR_REPLAY_MAX_PAGES = 1;
const MAX_RALLAR_REPLAY_MAX_PAGES = 50;

type RallarRoomEventSubscription = Readonly<{
    listener: RallarRoomEventListener;
    options: RallarRoomEventOptions;
}>;

type RallarPeopleEventSubscription = Readonly<{
    listener: RallarPeopleEventListener;
    options: RallarPeopleEventOptions;
}>;

export type CreateRallarStateEventsOptions = Readonly<{
    wsInbox: RallarWsInbox;
    readDefaultScope: () => StateScope | undefined;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T,
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
}>;

export function createRallarStateEvents(
    options: CreateRallarStateEventsOptions,
): RallarStateEventsPort {
    return new RallarStateEventsController(options);
}

class RallarStateEventsController implements RallarStateEventsPort {
    private readonly roomEventSubscriptions =
        new Set<RallarRoomEventSubscription>();
    private readonly peopleEventSubscriptions =
        new Set<RallarPeopleEventSubscription>();
    private readonly seenGroupEventKeys = new Set<string>();
    private readonly seenClientEventKeys = new Set<string>();
    private stopWsInbox: RallarUnsubscribe | undefined;

    constructor(private readonly options: CreateRallarStateEventsOptions) {}

    async listRoomEvents(
        input: RallarListRoomEventsInput,
    ): Promise<readonly GroupEvent[]> {
        const options = typeof input === 'string'
            ? { roomId: input }
            : input;
        const operationOptions = this.resolveOperationOptions(options);
        const roomId = options.roomRef?.groupId ?? options.roomId;
        if (!roomId) {
            throw new Error(
                'Cannot list room events: roomId or roomRef is required.',
            );
        }

        const scope = this.resolveRoomEventListScope(options);
        return await this.runAuthAwareOperation(async () =>
            await runRallarCommand(
                async (signal) =>
                    await api.listStateGroupEvents(
                        roomId,
                        scope,
                        toStateEventListRequestOptions(options, signal),
                    ),
                operationOptions,
            )
        );
    }

    async listRoomEventPage(
        input: RallarListRoomEventsInput,
    ): Promise<StateEventPage<GroupEvent>> {
        const options = typeof input === 'string'
            ? { roomId: input }
            : input;
        const operationOptions = this.resolveOperationOptions(options);
        const roomId = options.roomRef?.groupId ?? options.roomId;
        if (!roomId) {
            throw new Error(
                'Cannot list room event page: roomId or roomRef is required.',
            );
        }

        const scope = this.resolveRoomEventListScope(options);
        return await this.runAuthAwareOperation(async () =>
            await runRallarCommand(
                async (signal) =>
                    await api.listStateGroupEventPage(
                        roomId,
                        scope,
                        toStateEventListRequestOptions(options, signal),
                    ),
                operationOptions,
            )
        );
    }

    async replayRoomEventsInput(
        input: RallarReplayRoomEventsInput,
        listener?: RallarRoomEventListener,
    ): Promise<RallarReplayEventsResult<GroupEvent>> {
        const options = typeof input === 'string'
            ? { roomId: input }
            : input;
        return await this.replayRoomEvents(
            options,
            listener ?? options.listener,
        );
    }

    async listPeopleEvents(
        principalId: string,
        options: RallarListPeopleEventsOptions = {},
    ): Promise<readonly ClientEvent[]> {
        const operationOptions = this.resolveOperationOptions(options);
        const scope = this.resolveOperationScope(options.scope) ??
            api.defaultStateScope();
        return await this.runAuthAwareOperation(async () =>
            await runRallarCommand(
                async (signal) =>
                    await api.listStateClientEvents(
                        principalId,
                        scope,
                        toStateEventListRequestOptions(options, signal),
                    ),
                operationOptions,
            )
        );
    }

    async listPeopleEventPage(
        principalId: string,
        options: RallarListPeopleEventsOptions = {},
    ): Promise<StateEventPage<ClientEvent>> {
        const operationOptions = this.resolveOperationOptions(options);
        const scope = this.resolveOperationScope(options.scope) ??
            api.defaultStateScope();
        return await this.runAuthAwareOperation(async () =>
            await runRallarCommand(
                async (signal) =>
                    await api.listStateClientEventPage(
                        principalId,
                        scope,
                        toStateEventListRequestOptions(options, signal),
                    ),
                operationOptions,
            )
        );
    }

    async replayPeopleEventsFromFacade(
        principalId: string,
        options: RallarReplayPeopleEventsOptions = {},
        listener?: RallarPeopleEventListener,
    ): Promise<RallarReplayEventsResult<ClientEvent>> {
        return await this.replayPeopleEvents(
            principalId,
            options,
            listener ?? options.listener,
        );
    }

    onRoomEvent(
        listener: RallarRoomEventListener,
        options: RallarRoomEventOptions,
    ): RallarUnsubscribe {
        const subscription: RallarRoomEventSubscription = {
            listener,
            options,
        };
        this.roomEventSubscriptions.add(subscription);
        this.registerStateEventCallbacks();

        return () => {
            this.roomEventSubscriptions.delete(subscription);
            this.unregisterStateEventCallbacksIfUnused();
        };
    }

    onPeopleEvent(
        listener: RallarPeopleEventListener,
        options: RallarPeopleEventOptions,
    ): RallarUnsubscribe {
        const subscription: RallarPeopleEventSubscription = {
            listener,
            options,
        };
        this.peopleEventSubscriptions.add(subscription);
        this.registerStateEventCallbacks();

        return () => {
            this.peopleEventSubscriptions.delete(subscription);
            this.unregisterStateEventCallbacksIfUnused();
        };
    }

    private async replayRoomEvents(
        options: RallarReplayRoomEventsOptions,
        listener?: RallarRoomEventListener,
    ): Promise<RallarReplayEventsResult<GroupEvent>> {
        const operationOptions = this.resolveOperationOptions(options);
        const roomId = options.roomRef?.groupId ?? options.roomId;
        if (!roomId) {
            throw new Error(
                'Cannot replay room events: roomId or roomRef is required.',
            );
        }

        const scope = this.resolveRoomEventListScope(options);
        return await this.runAuthAwareOperation(async () =>
            await runRallarCommand(
                async (signal) => {
                    let after = options.after;
                    let hasMore = false;
                    let nextCursor: StateEventCursor | undefined;
                    let pageCount = 0;
                    let duplicateCount = 0;
                    const replayedEvents: GroupEvent[] = [];
                    const maxPages = toReplayMaxPages(options.maxPages);

                    while (pageCount < maxPages) {
                        const page = await api.listStateGroupEventPage(
                            roomId,
                            scope,
                            toStateEventListRequestOptions(
                                {
                                    ...options,
                                    after,
                                },
                                signal,
                            ),
                        );
                        pageCount += 1;
                        hasMore = page.hasMore;
                        nextCursor = page.nextCursor;

                        for (const event of page.events) {
                            const result = await this.replayRoomEvent(event, listener);
                            if (result === 'duplicate') {
                                duplicateCount += 1;
                            } else if (result === 'replayed') {
                                replayedEvents.push(event);
                            }
                        }

                        if (!page.hasMore || !page.nextCursor) {
                            break;
                        }
                        after = page.nextCursor;
                    }
                    return {
                        events: replayedEvents,
                        ...(nextCursor ? { nextCursor } : {}),
                        hasMore,
                        pageCount,
                        replayedCount: replayedEvents.length,
                        duplicateCount,
                    };
                },
                operationOptions,
            )
        );
    }

    private async replayPeopleEvents(
        principalId: string,
        options: RallarReplayPeopleEventsOptions,
        listener?: RallarPeopleEventListener,
    ): Promise<RallarReplayEventsResult<ClientEvent>> {
        const operationOptions = this.resolveOperationOptions(options);
        const scope = this.resolveOperationScope(options.scope) ??
            api.defaultStateScope();
        return await this.runAuthAwareOperation(async () =>
            await runRallarCommand(
                async (signal) => {
                    let after = options.after;
                    let hasMore = false;
                    let nextCursor: StateEventCursor | undefined;
                    let pageCount = 0;
                    let duplicateCount = 0;
                    const replayedEvents: ClientEvent[] = [];
                    const maxPages = toReplayMaxPages(options.maxPages);

                    while (pageCount < maxPages) {
                        const page = await api.listStateClientEventPage(
                            principalId,
                            scope,
                            toStateEventListRequestOptions(
                                {
                                    ...options,
                                    after,
                                },
                                signal,
                            ),
                        );
                        pageCount += 1;
                        hasMore = page.hasMore;
                        nextCursor = page.nextCursor;

                        for (const event of page.events) {
                            const result = await this.replayPeopleEvent(event, listener);
                            if (result === 'duplicate') {
                                duplicateCount += 1;
                            } else if (result === 'replayed') {
                                replayedEvents.push(event);
                            }
                        }

                        if (!page.hasMore || !page.nextCursor) {
                            break;
                        }
                        after = page.nextCursor;
                    }

                    return {
                        events: replayedEvents,
                        ...(nextCursor ? { nextCursor } : {}),
                        hasMore,
                        pageCount,
                        replayedCount: replayedEvents.length,
                        duplicateCount,
                    };
                },
                operationOptions,
            )
        );
    }

    private async replayRoomEvent(
        event: GroupEvent,
        listener?: RallarRoomEventListener,
    ): Promise<'replayed' | 'duplicate' | 'no-listeners'> {
        if (!isGroupEventPayload(event)) {
            return 'no-listeners';
        }

        const dedupeKey = toGroupStateEventDedupeKey(event);
        if (this.seenGroupEventKeys.has(dedupeKey)) {
            return 'duplicate';
        }

        const message = toReplayGroupStateEventMessage(event);
        if (listener) {
            rememberStateEventKey(this.seenGroupEventKeys, dedupeKey);
            await notifyStateEventListener(listener, event, message);
            return 'replayed';
        }

        const subscriptions = [...this.roomEventSubscriptions]
            .filter((subscription) =>
                this.matchesRoomEventSubscription(subscription, event)
            );
        if (subscriptions.length === 0) {
            return 'no-listeners';
        }

        rememberStateEventKey(this.seenGroupEventKeys, dedupeKey);
        await Promise.all(
            subscriptions.map(async (subscription) =>
                await notifyStateEventListener(
                    subscription.listener,
                    event,
                    message,
                )
            ),
        );
        return 'replayed';
    }

    private async replayPeopleEvent(
        event: ClientEvent,
        listener?: RallarPeopleEventListener,
    ): Promise<'replayed' | 'duplicate' | 'no-listeners'> {
        if (!isClientEventPayload(event)) {
            return 'no-listeners';
        }

        const dedupeKey = toClientStateEventDedupeKey(event);
        if (this.seenClientEventKeys.has(dedupeKey)) {
            return 'duplicate';
        }

        const message = toReplayClientStateEventMessage(event);
        if (listener) {
            rememberStateEventKey(this.seenClientEventKeys, dedupeKey);
            await notifyStateEventListener(listener, event, message);
            return 'replayed';
        }

        const subscriptions = [...this.peopleEventSubscriptions]
            .filter((subscription) =>
                this.matchesPeopleEventSubscription(subscription, event)
            );
        if (subscriptions.length === 0) {
            return 'no-listeners';
        }

        rememberStateEventKey(this.seenClientEventKeys, dedupeKey);
        await Promise.all(
            subscriptions.map(async (subscription) =>
                await notifyStateEventListener(
                    subscription.listener,
                    event,
                    message,
                )
            ),
        );
        return 'replayed';
    }

    private async dispatchStateEventMessage(
        message: RallarMessage<unknown>,
    ): Promise<void> {
        if (message.typeId === AppTopics.groupStateEvent) {
            await this.dispatchRoomStateEvent(
                message as RallarMessage<GroupEvent>,
            );
            return;
        }

        if (message.typeId === AppTopics.clientStateEvent) {
            await this.dispatchPeopleStateEvent(
                message as RallarMessage<ClientEvent>,
            );
        }
    }

    private async dispatchRoomStateEvent(
        message: RallarMessage<GroupEvent>,
    ): Promise<void> {
        const event = message.payload;
        if (!isGroupEventPayload(event)) {
            return;
        }

        const subscriptions = [...this.roomEventSubscriptions]
            .filter((subscription) =>
                this.matchesRoomEventSubscription(subscription, event)
            );
        if (subscriptions.length === 0) {
            return;
        }

        const dedupeKey = toGroupStateEventDedupeKey(event);
        if (this.seenGroupEventKeys.has(dedupeKey)) {
            return;
        }
        rememberStateEventKey(this.seenGroupEventKeys, dedupeKey);

        await Promise.all(
            subscriptions.map(async (subscription) =>
                await notifyStateEventListener(
                    subscription.listener,
                    event,
                    message,
                )
            ),
        );
    }

    private async dispatchPeopleStateEvent(
        message: RallarMessage<ClientEvent>,
    ): Promise<void> {
        const event = message.payload;
        if (!isClientEventPayload(event)) {
            return;
        }

        const subscriptions = [...this.peopleEventSubscriptions]
            .filter((subscription) =>
                this.matchesPeopleEventSubscription(subscription, event)
            );
        if (subscriptions.length === 0) {
            return;
        }

        const dedupeKey = toClientStateEventDedupeKey(event);
        if (this.seenClientEventKeys.has(dedupeKey)) {
            return;
        }
        rememberStateEventKey(this.seenClientEventKeys, dedupeKey);

        await Promise.all(
            subscriptions.map(async (subscription) =>
                await notifyStateEventListener(
                    subscription.listener,
                    event,
                    message,
                )
            ),
        );
    }

    private matchesRoomEventSubscription(
        subscription: RallarRoomEventSubscription,
        event: GroupEvent,
    ): boolean {
        const { options } = subscription;
        if (
            options.eventTypes &&
            !options.eventTypes.includes(event.eventType)
        ) {
            return false;
        }

        if (
            options.roomRef &&
            !isSameStateGroupRef(event, options.roomRef)
        ) {
            return false;
        }

        if (
            !options.roomRef &&
            options.roomId &&
            event.groupId !== options.roomId
        ) {
            return false;
        }

        const scope = options.scope ?? this.defaultScope;
        return isSameStateScopeValue(event, scope);
    }

    private matchesPeopleEventSubscription(
        subscription: RallarPeopleEventSubscription,
        event: ClientEvent,
    ): boolean {
        const { options } = subscription;
        if (
            options.eventTypes &&
            !options.eventTypes.includes(event.eventType)
        ) {
            return false;
        }

        if (options.principalId && event.principalId !== options.principalId) {
            return false;
        }

        const scope = options.scope ?? this.defaultScope;
        return isSameStateScopeValue(event, scope);
    }

    private resolveRoomEventListScope(
        options: RallarListRoomEventsOptions,
    ): StateScope {
        if (options.roomRef) {
            return {
                applicationId: options.roomRef.applicationId,
                workspaceId: options.roomRef.workspaceId ??
                    DEFAULT_STATE_WORKSPACE_ID,
            };
        }

        return this.resolveOperationScope(options.scope) ??
            api.defaultStateScope();
    }

    private registerStateEventCallbacks(): void {
        if (this.stopWsInbox || !this.hasStateEventSubscriptions()) {
            return;
        }
        this.stopWsInbox = this.options.wsInbox.subscribe({
            id: 'state-events',
            order: 10,
            onMessage: async (message) => {
                await this.dispatchStateEventMessage(
                    toRallarMessage('ws', message),
                );
            },
        });
    }

    private unregisterStateEventCallbacksIfUnused(): void {
        if (this.hasStateEventSubscriptions()) {
            return;
        }
        this.stopWsInbox?.();
        this.stopWsInbox = undefined;
    }

    private hasStateEventSubscriptions(): boolean {
        return this.roomEventSubscriptions.size > 0 ||
            this.peopleEventSubscriptions.size > 0;
    }

    private resolveOperationOptions<T extends RallarOperationOptions>(
        operationOptions: T,
    ): T & RallarOperationOptions {
        return this.options.resolveOperationOptions(operationOptions);
    }

    private resolveOperationScope(scope?: StateScope): StateScope | undefined {
        return this.options.resolveOperationScope(scope);
    }

    private runAuthAwareOperation<T>(
        operation: () => Promise<T>,
    ): Promise<T> {
        return this.options.runAuthAwareOperation(operation);
    }

    private get defaultScope(): StateScope | undefined {
        return this.options.readDefaultScope();
    }
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions,
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}

function toStateEventListRequestOptions<TEventType extends string>(
    options: Readonly<{
        eventTypes?: readonly TEventType[];
        limit?: number;
        after?: StateEventCursor;
    }>,
    signal?: AbortSignal,
): Readonly<{
    eventTypes?: readonly TEventType[];
    limit?: number;
    after?: StateEventCursor;
    signal?: AbortSignal;
}> {
    return {
        ...(options.eventTypes !== undefined ? { eventTypes: options.eventTypes } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.after !== undefined ? { after: options.after } : {}),
        ...(signal ? { signal } : {}),
    };
}

function isGroupEventPayload(value: unknown): value is GroupEvent {
    return isRecord(value) &&
        typeof value.applicationId === 'string' &&
        typeof value.groupId === 'string' &&
        typeof value.eventId === 'string' &&
        typeof value.eventType === 'string' &&
        typeof value.snapshotVersion === 'number';
}

function isClientEventPayload(value: unknown): value is ClientEvent {
    return isRecord(value) &&
        typeof value.applicationId === 'string' &&
        typeof value.principalId === 'string' &&
        typeof value.eventId === 'string' &&
        typeof value.eventType === 'string' &&
        typeof value.snapshotVersion === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isSameStateGroupRef(
    left: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
    right: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
): boolean {
    return left.groupId === right.groupId &&
        isSameStateScopeValue(left, right);
}

function isSameStateScopeValue(
    value: Pick<StateScope, 'applicationId'> & { workspaceId?: string },
    scope?: Pick<StateScope, 'applicationId'> & { workspaceId?: string },
): boolean {
    if (!scope) {
        return true;
    }

    return value.applicationId === scope.applicationId &&
        normalizeStateWorkspaceId(value.workspaceId) ===
        normalizeStateWorkspaceId(scope.workspaceId);
}

function normalizeStateWorkspaceId(workspaceId?: string): string {
    return workspaceId ?? DEFAULT_STATE_WORKSPACE_ID;
}

function toReplayGroupStateEventMessage(event: GroupEvent): RallarMessage<GroupEvent> {
    return toRallarMessage(
        'replay',
        newALBroadcastMessage(
            'rallar:replay',
            newALRoute(
                AppTopics.groupStateEvent,
                event.groupId,
                event.eventId,
            ),
            'all',
            AppTopics.groupStateEvent,
            event,
        ),
    );
}

function toReplayClientStateEventMessage(
    event: ClientEvent,
): RallarMessage<ClientEvent> {
    return toRallarMessage(
        'replay',
        newALBroadcastMessage(
            'rallar:replay',
            newALRoute(
                AppTopics.clientStateEvent,
                event.principalId,
                event.eventId,
            ),
            'all',
            AppTopics.clientStateEvent,
            event,
        ),
    );
}

function toGroupStateEventDedupeKey(event: GroupEvent): string {
    return [
        event.applicationId,
        normalizeStateWorkspaceId(event.workspaceId),
        event.groupId,
        event.eventId,
    ].join('/');
}

function toClientStateEventDedupeKey(event: ClientEvent): string {
    return [
        event.applicationId,
        normalizeStateWorkspaceId(event.workspaceId),
        event.principalId,
        event.eventId,
    ].join('/');
}

function toReplayMaxPages(value?: number): number {
    if (value === undefined) {
        return DEFAULT_RALLAR_REPLAY_MAX_PAGES;
    }

    if (!Number.isSafeInteger(value) || value < 1) {
        return DEFAULT_RALLAR_REPLAY_MAX_PAGES;
    }

    return Math.min(value, MAX_RALLAR_REPLAY_MAX_PAGES);
}

function rememberStateEventKey(keys: Set<string>, key: string): void {
    keys.add(key);
    while (keys.size > MAX_RALLAR_STATE_EVENT_DEDUPE_KEYS) {
        const oldest = keys.values().next().value;
        if (oldest === undefined) {
            break;
        }
        keys.delete(oldest);
    }
}
