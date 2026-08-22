import * as api from '@shared-web/browser/api-integration.ts';
import type { RallarMessage } from '@shared-web/browser/rallar-messages-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { toRallarMessage } from '@shared-web/browser/rallar-runtime/message-conversion.ts';
import {
    rememberStateEventKey,
    replayStateEventPages,
    runRallarStateEventCommand,
    toStateEventListRequestOptions
} from '@shared-web/browser/rallar-runtime/state-events.ts';
import { notifyStateEventListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarReplayEventsResult, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupEvent } from '@shared/api/authoritative-state-validation.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';

import type {
    RallarListRoomEventsInput,
    RallarListRoomEventsOptions,
    RallarReplayRoomEventsInput,
    RallarReplayRoomEventsOptions,
    RallarRoomEventListener,
    RallarRoomEventOptions
} from './rallar-room-contracts.ts';
import type { GroupEvent, GroupRef, StateEventPage, StateScope } from './room-group-state-translation.ts';

interface RallarRoomEventSubscription {
    readonly listener: RallarRoomEventListener;
    readonly options: RallarRoomEventOptions;
}

type UnvalidatedRallarMessage = ReturnType<typeof toRallarMessage>;

export interface RallarRoomEventsPort {
    list(input: RallarListRoomEventsInput): Promise<readonly GroupEvent[]>;
    listPage(input: RallarListRoomEventsInput): Promise<StateEventPage<GroupEvent>>;
    replay(
        input: RallarReplayRoomEventsInput,
        listener?: RallarRoomEventListener
    ): Promise<RallarReplayEventsResult<GroupEvent>>;
    onEvent(listener: RallarRoomEventListener, options: RallarRoomEventOptions): RallarUnsubscribe;
    dispatch(message: UnvalidatedRallarMessage): Promise<void>;
}

export interface CreateRoomEventsInput {
    readonly retainWsInboxSubscription: () => RallarUnsubscribe;
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
                        await api.listStateGroupEvents(
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
                        await api.listStateGroupEventPage(
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
        listener?: RallarRoomEventListener
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
                                await api.listStateGroupEventPage(
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

    onEvent(listener: RallarRoomEventListener, options: RallarRoomEventOptions): RallarUnsubscribe {
        const subscription = { listener, options };
        this.#subscriptions.add(subscription);
        const releaseWsInbox = this.#input.retainWsInboxSubscription();
        let active = true;
        return () => {
            if (!active) {
                return;
            }
            active = false;
            this.#subscriptions.delete(subscription);
            releaseWsInbox();
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
        listener?: RallarRoomEventListener
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
        return this.#input.resolveOperationScope(options.scope) ?? api.defaultStateScope();
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

// Under dual-emit/delta-primary the `group-state.event` payload is a
// GroupStateDeltaEnvelope wrapping the GroupEvent; legacy rows carry the bare
// event. The envelope's wrapper keys are disjoint from GroupEvent's, so a
// light structural check routes both forms to the same validated GroupEvent.
function resolveDispatchedGroupEvent(value: unknown): GroupEvent | undefined {
    if (isGroupEventPayload(value)) {
        return value;
    }
    if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !('event' in value) ||
        !('predecessorCausalRevision' in value) ||
        !('resultingCausalRevision' in value)
    ) {
        return undefined;
    }
    return isGroupEventPayload(value.event) ? value.event : undefined;
}

function isSameStateGroupRef(
    left: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
    right: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>
): boolean {
    return left.groupId === right.groupId && isSameStateScopeValue(left, right);
}

function isSameStateScopeValue(
    value: Pick<StateScope, 'applicationId'> & { workspaceId?: string; },
    scope?: Pick<StateScope, 'applicationId'> & { workspaceId?: string; }
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
