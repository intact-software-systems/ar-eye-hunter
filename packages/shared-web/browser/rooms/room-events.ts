import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import type { RallarMessage, RallarStateEventListener } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { toRallarMessage } from '@shared-web/browser/messages/to-rallar-message.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import {
    rememberStateEventKey,
    replayStateEventPages,
    runRallarStateEventCommand,
    toStateEventListRequestOptions
} from '@shared-web/browser/rallar-runtime/state-events.ts';
import { notifyStateEventListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarReplayEventsResult, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import * as stateEventHttpApi from '@shared-web/browser/state-read/state-event-http-api.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupEvent } from '@shared/api/authoritative-state-validation.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';

import type {
    RallarListRoomEventsInput,
    RallarListRoomEventsOptions,
    RallarReplayRoomEventsInput,
    RallarReplayRoomEventsOptions,
    RallarRoomEventOptions
} from './rallar-room-contracts.ts';
import type { GroupEvent, GroupRef, StateEventPage, StateScope } from './room-group-state-translation.ts';

interface RallarRoomEventSubscription {
    readonly listener: RallarStateEventListener<GroupEvent>;
    readonly options: RallarRoomEventOptions;
}

type UnvalidatedRallarMessage = ReturnType<typeof toRallarMessage>;

export interface RallarRoomEventsPort {
    list(input: RallarListRoomEventsInput): Promise<readonly GroupEvent[]>;
    listPage(input: RallarListRoomEventsInput): Promise<StateEventPage<GroupEvent>>;
    replay(
        input: RallarReplayRoomEventsInput,
        listener?: RallarStateEventListener<GroupEvent>
    ): Promise<RallarReplayEventsResult<GroupEvent>>;
    onEvent(listener: RallarStateEventListener<GroupEvent>, options: RallarRoomEventOptions): RallarUnsubscribe;
    dispatch(message: UnvalidatedRallarMessage): Promise<void>;
}

export interface CreateRoomEventsInput {
    readonly wsInbox: BrowserWebSocketInbox;
    readonly readDefaultScope: () => StateScope | undefined;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
    readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
    readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function createRoomEvents(input: CreateRoomEventsInput): RallarRoomEventsPort {
    return new RoomEvents(input);
}

class RoomEvents implements RallarRoomEventsPort {
    readonly #subscriptions = new Set<RallarRoomEventSubscription>();
    readonly #seenEventKeys = new Set<string>();
    readonly #input: CreateRoomEventsInput;
    #stopWsInbox: RallarUnsubscribe | undefined;

    constructor(input: CreateRoomEventsInput) {
        this.#input = input;
    }

    async list(input: RallarListRoomEventsInput): Promise<readonly GroupEvent[]> {
        const options = toRoomEventListOptions(input);
        const operationOptions = this.#input.resolveOperationOptions(options);
        const roomId = readRequiredRoomId(options, 'Cannot list room events');
        const scope = this.resolveListScope(options);
        return await this.#input.runAuthAwareOperation(
            async () =>
                await runRallarStateEventCommand(
                    async (signal) =>
                        await stateEventHttpApi.listStateGroupEvents(
                            roomId,
                            scope,
                            toStateEventListRequestOptions(options, signal)
                        ),
                    operationOptions
                )
        );
    }

    async listPage(input: RallarListRoomEventsInput): Promise<StateEventPage<GroupEvent>> {
        const options = toRoomEventListOptions(input);
        const operationOptions = this.#input.resolveOperationOptions(options);
        const roomId = readRequiredRoomId(options, 'Cannot list room event page');
        const scope = this.resolveListScope(options);
        return await this.#input.runAuthAwareOperation(
            async () =>
                await runRallarStateEventCommand(
                    async (signal) =>
                        await stateEventHttpApi.listStateGroupEventPage(
                            roomId,
                            scope,
                            toStateEventListRequestOptions(options, signal)
                        ),
                    operationOptions
                )
        );
    }

    async replay(
        input: RallarReplayRoomEventsInput,
        listener?: RallarStateEventListener<GroupEvent>
    ): Promise<RallarReplayEventsResult<GroupEvent>> {
        const options = toRoomEventListOptions(input);
        const operationOptions = this.#input.resolveOperationOptions(options);
        const roomId = readRequiredRoomId(options, 'Cannot replay room events');
        const scope = this.resolveListScope(options);
        return await this.#input.runAuthAwareOperation(
            async () =>
                await runRallarStateEventCommand(
                    async (signal) =>
                        await replayStateEventPages({
                            after: options.after,
                            maxPages: options.maxPages,
                            readPage: async (after) =>
                                await stateEventHttpApi.listStateGroupEventPage(
                                    roomId,
                                    scope,
                                    toStateEventListRequestOptions({ ...options, after }, signal)
                                ),
                            replayEvent: async (event) => await this.replayEvent(event, listener ?? options.listener)
                        }),
                    operationOptions
                )
        );
    }

    onEvent(listener: RallarStateEventListener<GroupEvent>, options: RallarRoomEventOptions): RallarUnsubscribe {
        const subscription = { listener, options };
        this.#subscriptions.add(subscription);
        this.registerWsInboxSubscription();
        let active = true;
        return () => {
            if (!active) {
                return;
            }
            active = false;
            this.#subscriptions.delete(subscription);
            this.unregisterWsInboxSubscriptionIfUnused();
        };
    }

    async dispatch(message: UnvalidatedRallarMessage): Promise<void> {
        const event = resolveDispatchedGroupEvent(message.payload);
        if (event === undefined) {
            return;
        }
        const groupMessage: RallarMessage<GroupEvent> = { ...message, payload: event };
        const subscriptions = this.matchingSubscriptions(event);
        if (subscriptions.length === 0 || this.hasSeen(event)) {
            return;
        }
        this.remember(event);
        await Promise.all(
            subscriptions.map(
                async (subscription) => await notifyStateEventListener(subscription.listener, event, groupMessage)
            )
        );
    }

    private async replayEvent(
        event: GroupEvent,
        listener?: RallarStateEventListener<GroupEvent>
    ): Promise<'replayed' | 'duplicate' | 'no-listeners'> {
        if (!isGroupEventPayload(event)) {
            return 'no-listeners';
        }
        if (this.hasSeen(event)) {
            return 'duplicate';
        }

        const message = toReplayGroupStateEventMessage(event);
        if (listener) {
            this.remember(event);
            await notifyStateEventListener(listener, event, message);
            return 'replayed';
        }
        const subscriptions = this.matchingSubscriptions(event);
        if (subscriptions.length === 0) {
            return 'no-listeners';
        }
        this.remember(event);
        await Promise.all(
            subscriptions.map(
                async (subscription) => await notifyStateEventListener(subscription.listener, event, message)
            )
        );
        return 'replayed';
    }

    private matchingSubscriptions(event: GroupEvent): RallarRoomEventSubscription[] {
        return [...this.#subscriptions].filter((subscription) =>
            matchesRoomEventSubscription(subscription, event, this.#input.readDefaultScope())
        );
    }

    private registerWsInboxSubscription(): void {
        if (this.#stopWsInbox) {
            return;
        }
        this.#stopWsInbox = this.#input.wsInbox.subscribe({
            id: 'room-events',
            order: 10,
            onMessage: async (message) => {
                const rallarMessage = toRallarMessage('ws', message);
                if (rallarMessage.typeId === AppTopics.groupStateEvent) {
                    await this.dispatch(rallarMessage);
                }
            }
        });
    }

    private unregisterWsInboxSubscriptionIfUnused(): void {
        if (this.#subscriptions.size > 0) {
            return;
        }
        this.#stopWsInbox?.();
        this.#stopWsInbox = undefined;
    }

    private hasSeen(event: GroupEvent): boolean {
        return this.#seenEventKeys.has(toGroupStateEventDedupeKey(event));
    }

    private remember(event: GroupEvent): void {
        rememberStateEventKey(this.#seenEventKeys, toGroupStateEventDedupeKey(event));
    }

    private resolveListScope(options: RallarListRoomEventsOptions): StateScope {
        if (options.roomRef) {
            return {
                applicationId: options.roomRef.applicationId,
                workspaceId: options.roomRef.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID
            };
        }
        return this.#input.resolveOperationScope(options.scope) ?? defaultStateScope();
    }
}

function toRoomEventListOptions(input: RallarListRoomEventsInput): RallarReplayRoomEventsOptions {
    return typeof input === 'string' ? { roomId: input } : input;
}

function readRequiredRoomId(options: RallarListRoomEventsOptions, operation: string): string {
    const roomId = options.roomRef?.groupId ?? options.roomId;
    if (!roomId) {
        throw new Error(`${operation}: roomId or roomRef is required.`);
    }
    return roomId;
}

function matchesRoomEventSubscription(
    subscription: RallarRoomEventSubscription,
    event: GroupEvent,
    defaultScope: StateScope | undefined
): boolean {
    const { options } = subscription;
    if (options.eventTypes && !options.eventTypes.includes(event.eventType)) {
        return false;
    }
    if (options.roomRef && !isSameStateGroupRef(event, options.roomRef)) {
        return false;
    }
    if (!options.roomRef && options.roomId && event.groupId !== options.roomId) {
        return false;
    }
    return isSameStateScopeValue(event, options.scope ?? defaultScope);
}

function isGroupEventPayload(value: unknown): value is GroupEvent {
    try {
        validateAuthoritativeGroupEvent(value);
        return true;
    }
    catch {
        return false;
    }
}

function resolveDispatchedGroupEvent(value: unknown): GroupEvent | undefined {
    try {
        validateGroupStateDeltaEnvelope(value);
        return value.event;
    }
    catch {
        return undefined;
    }
}

function isSameStateGroupRef(
    left: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
    right: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>
): boolean {
    return left.groupId === right.groupId && isSameStateScopeValue(left, right);
}

interface ComparableStateScope {
    readonly applicationId: string;
    readonly workspaceId?: string;
}

function isSameStateScopeValue(
    value: ComparableStateScope,
    scope?: ComparableStateScope
): boolean {
    if (!scope) {
        return true;
    }
    return (
        value.applicationId === scope.applicationId &&
        normalizeStateWorkspaceId(value.workspaceId) === normalizeStateWorkspaceId(scope.workspaceId)
    );
}

function normalizeStateWorkspaceId(workspaceId?: string): string {
    return workspaceId ?? DEFAULT_STATE_WORKSPACE_ID;
}

function toReplayGroupStateEventMessage(event: GroupEvent): RallarMessage<GroupEvent> {
    return toRallarMessage(
        'replay',
        newALBroadcastMessage(
            'rallar:replay',
            newALRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
            'all',
            AppTopics.groupStateEvent,
            event
        )
    );
}

function toGroupStateEventDedupeKey(event: GroupEvent): string {
    return [
        event.applicationId,
        normalizeStateWorkspaceId(event.workspaceId),
        event.groupId,
        event.eventId
    ].join('/');
}
