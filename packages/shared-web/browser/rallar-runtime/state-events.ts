import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import type { RallarMessage, RallarStateEventListener } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { toRallarMessage } from '@shared-web/browser/messages/to-rallar-message.ts';
import type {
    RallarListPeopleEventsOptions,
    RallarPeopleEventOptions,
    RallarReplayPeopleEventsOptions
} from '@shared-web/browser/people/rallar-people-contracts.ts';
import { notifyStateEventListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import * as stateEventHttpApi from '@shared-web/browser/state-read/state-event-http-api.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { validateAuthoritativeClientEvent } from '@shared/api/authoritative-state-validation.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { StateEventCursor, StateEventPage } from '@shared/api/state-event-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';

import { toRallarCommandOptions, type RallarOperationOptions } from '../rallar-operation-options.ts';
import type { RallarReplayEventsResult, RallarUnsubscribe } from '../rallar-shared-contracts.ts';

const MAX_RALLAR_STATE_EVENT_DEDUPE_KEYS = 1_000;
const DEFAULT_RALLAR_REPLAY_MAX_PAGES = 1;
const MAX_RALLAR_REPLAY_MAX_PAGES = 50;

interface RallarPeopleEventSubscription {
    readonly listener: RallarStateEventListener<ClientEvent>;
    readonly options: RallarPeopleEventOptions;
}

interface ReplayStateEventPagesInput<TEvent> {
    readonly after?: StateEventCursor;
    readonly maxPages?: number;
    readonly readPage: (
        after?: StateEventCursor
    ) => Promise<StateEventPage<TEvent>>;
    readonly replayEvent: (
        event: TEvent
    ) => Promise<'replayed' | 'duplicate' | 'no-listeners'>;
}

export interface CreateRallarStateEventsInput {
    readonly wsInbox: BrowserWebSocketInbox;
    readonly readDefaultScope: () => StateScope | undefined;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
    readonly resolveOperationScope: (
        scope?: StateScope
    ) => StateScope | undefined;
    readonly runAuthAwareOperation: <T>(
        operation: () => Promise<T>
    ) => Promise<T>;
}

export type RallarStateEventsPort = Readonly<{
    listPeopleEvents(
        principalId: string,
        options?: RallarListPeopleEventsOptions
    ): Promise<readonly ClientEvent[]>;
    listPeopleEventPage(
        principalId: string,
        options?: RallarListPeopleEventsOptions
    ): Promise<StateEventPage<ClientEvent>>;
    replayPeopleEventsFromFacade(
        principalId: string,
        options?: RallarReplayPeopleEventsOptions,
        listener?: RallarStateEventListener<ClientEvent>
    ): Promise<RallarReplayEventsResult<ClientEvent>>;
    onPeopleEvent(
        listener: RallarStateEventListener<ClientEvent>,
        options: RallarPeopleEventOptions
    ): RallarUnsubscribe;
}>;

export const createRallarStateEvents = (
    input: CreateRallarStateEventsInput
): RallarStateEventsPort => new RallarStateEvents(input);

class RallarStateEvents implements RallarStateEventsPort {
    readonly #subscriptions = new Set<RallarPeopleEventSubscription>();
    readonly #seenEventKeys = new Set<string>();
    readonly #input: CreateRallarStateEventsInput;
    #stopWsInbox: RallarUnsubscribe | undefined;

    constructor(input: CreateRallarStateEventsInput) {
        this.#input = input;
    }

    async listPeopleEvents(
        principalId: string,
        options: RallarListPeopleEventsOptions = {}
    ): Promise<readonly ClientEvent[]> {
        const operationOptions = this.#input.resolveOperationOptions(options);
        const scope = this.resolveScope(options.scope);
        return await this.#input.runAuthAwareOperation(
            async () =>
                await runRallarStateEventCommand(
                    async (signal) =>
                        await stateEventHttpApi.listStateClientEvents(
                            principalId,
                            scope,
                            toStateEventListRequestOptions(options, signal)
                        ),
                    operationOptions
                )
        );
    }

    async listPeopleEventPage(
        principalId: string,
        options: RallarListPeopleEventsOptions = {}
    ): Promise<StateEventPage<ClientEvent>> {
        const operationOptions = this.#input.resolveOperationOptions(options);
        const scope = this.resolveScope(options.scope);
        return await this.#input.runAuthAwareOperation(
            async () =>
                await runRallarStateEventCommand(
                    async (signal) =>
                        await stateEventHttpApi.listStateClientEventPage(
                            principalId,
                            scope,
                            toStateEventListRequestOptions(options, signal)
                        ),
                    operationOptions
                )
        );
    }

    async replayPeopleEventsFromFacade(
        principalId: string,
        options: RallarReplayPeopleEventsOptions = {},
        listener?: RallarStateEventListener<ClientEvent>
    ): Promise<RallarReplayEventsResult<ClientEvent>> {
        const operationOptions = this.#input.resolveOperationOptions(options);
        const scope = this.resolveScope(options.scope);
        return await this.#input.runAuthAwareOperation(
            async () =>
                await runRallarStateEventCommand(
                    async (signal) =>
                        await replayStateEventPages({
                            after: options.after,
                            maxPages: options.maxPages,
                            readPage: async (after) =>
                                await stateEventHttpApi.listStateClientEventPage(
                                    principalId,
                                    scope,
                                    toStateEventListRequestOptions({ ...options, after }, signal)
                                ),
                            replayEvent: async (event) =>
                                await this.replayPeopleEvent(
                                    event,
                                    listener ?? options.listener
                                )
                        }),
                    operationOptions
                )
        );
    }

    onPeopleEvent(
        listener: RallarStateEventListener<ClientEvent>,
        options: RallarPeopleEventOptions
    ): RallarUnsubscribe {
        const subscription = { listener, options };
        this.#subscriptions.add(subscription);
        this.registerStateEventCallbacks();
        return () => {
            this.#subscriptions.delete(subscription);
            this.unregisterStateEventCallbacksIfUnused();
        };
    }

    private async replayPeopleEvent(
        event: ClientEvent,
        listener?: RallarStateEventListener<ClientEvent>
    ): Promise<'replayed' | 'duplicate' | 'no-listeners'> {
        if (!isClientEventPayload(event)) {
            return 'no-listeners';
        }
        const dedupeKey = toClientStateEventDedupeKey(event);
        if (this.#seenEventKeys.has(dedupeKey)) {
            return 'duplicate';
        }
        const message = toReplayClientStateEventMessage(event);
        if (listener) {
            rememberStateEventKey(this.#seenEventKeys, dedupeKey);
            await notifyStateEventListener(listener, event, message);
            return 'replayed';
        }
        const subscriptions = this.matchingSubscriptions(event);
        if (subscriptions.length === 0) {
            return 'no-listeners';
        }
        rememberStateEventKey(this.#seenEventKeys, dedupeKey);
        await Promise.all(
            subscriptions.map(
                async (subscription) => await notifyStateEventListener(subscription.listener, event, message)
            )
        );
        return 'replayed';
    }

    private async dispatchStateEventMessage(
        message: RallarMessage<unknown>
    ): Promise<void> {
        if (
            message.typeId === AppTopics.clientStateEvent &&
            isClientEventPayload(message.payload)
        ) {
            await this.dispatchPeopleStateEvent(
                message as RallarMessage<ClientEvent>
            );
        }
    }

    private async dispatchPeopleStateEvent(
        message: RallarMessage<ClientEvent>
    ): Promise<void> {
        const event = message.payload;
        const subscriptions = this.matchingSubscriptions(event);
        const dedupeKey = toClientStateEventDedupeKey(event);
        if (subscriptions.length === 0 || this.#seenEventKeys.has(dedupeKey)) {
            return;
        }
        rememberStateEventKey(this.#seenEventKeys, dedupeKey);
        await Promise.all(
            subscriptions.map(
                async (subscription) => await notifyStateEventListener(subscription.listener, event, message)
            )
        );
    }

    private matchingSubscriptions(
        event: ClientEvent
    ): RallarPeopleEventSubscription[] {
        return [...this.#subscriptions].filter((subscription) =>
            matchesPeopleEventSubscription(
                subscription,
                event,
                this.#input.readDefaultScope()
            )
        );
    }

    private registerStateEventCallbacks(): void {
        if (this.#stopWsInbox || !this.hasStateEventSubscriptions()) {
            return;
        }
        this.#stopWsInbox = this.#input.wsInbox.subscribe({
            id: 'state-events',
            order: 10,
            onMessage: async (message) => await this.dispatchStateEventMessage(toRallarMessage('ws', message))
        });
    }

    private unregisterStateEventCallbacksIfUnused(): void {
        if (this.hasStateEventSubscriptions()) {
            return;
        }
        this.#stopWsInbox?.();
        this.#stopWsInbox = undefined;
    }

    private hasStateEventSubscriptions(): boolean {
        return this.#subscriptions.size > 0;
    }

    private resolveScope(scope?: StateScope): StateScope {
        return this.#input.resolveOperationScope(scope) ?? defaultStateScope();
    }
}

export async function replayStateEventPages<TEvent>(
    input: ReplayStateEventPagesInput<TEvent>
): Promise<RallarReplayEventsResult<TEvent>> {
    let after = input.after;
    let hasMore = false;
    let nextCursor: StateEventCursor | undefined;
    let pageCount = 0;
    let duplicateCount = 0;
    const replayedEvents: TEvent[] = [];
    const maxPages = toReplayMaxPages(input.maxPages);
    while (pageCount < maxPages) {
        const page = await input.readPage(after);
        pageCount += 1;
        hasMore = page.hasMore;
        nextCursor = page.nextCursor;
        for (const event of page.events) {
            const result = await input.replayEvent(event);
            if (result === 'duplicate') {
                duplicateCount += 1;
            }
            else if (result === 'replayed') {
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
        duplicateCount
    };
}

export function runRallarStateEventCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}

export function toStateEventListRequestOptions<TEventType extends string>(
    options: Readonly<{
        eventTypes?: readonly TEventType[];
        limit?: number;
        after?: StateEventCursor;
    }>,
    signal?: AbortSignal
) {
    return {
        ...(options.eventTypes !== undefined
            ? { eventTypes: options.eventTypes }
            : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.after !== undefined ? { after: options.after } : {}),
        ...(signal ? { signal } : {})
    };
}

export function rememberStateEventKey(keys: Set<string>, key: string): void {
    keys.add(key);
    while (keys.size > MAX_RALLAR_STATE_EVENT_DEDUPE_KEYS) {
        const oldest = keys.values().next().value;
        if (oldest === undefined) {
            break;
        }
        keys.delete(oldest);
    }
}

function matchesPeopleEventSubscription(
    subscription: RallarPeopleEventSubscription,
    event: ClientEvent,
    defaultScope: StateScope | undefined
): boolean {
    const { options } = subscription;
    if (options.eventTypes && !options.eventTypes.includes(event.eventType)) {
        return false;
    }
    if (options.principalId && event.principalId !== options.principalId) {
        return false;
    }
    return isSameStateScopeValue(event, options.scope ?? defaultScope);
}

function isClientEventPayload(value: unknown): value is ClientEvent {
    try {
        validateAuthoritativeClientEvent(value);
        return true;
    }
    catch {
        return false;
    }
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
        normalizeStateWorkspaceId(value.workspaceId) ===
            normalizeStateWorkspaceId(scope.workspaceId)
    );
}

function normalizeStateWorkspaceId(workspaceId?: string): string {
    return workspaceId ?? DEFAULT_STATE_WORKSPACE_ID;
}

function toReplayClientStateEventMessage(
    event: ClientEvent
): RallarMessage<ClientEvent> {
    return toRallarMessage(
        'replay',
        newALBroadcastMessage(
            'rallar:replay',
            newALRoute(AppTopics.clientStateEvent, event.principalId, event.eventId),
            'all',
            AppTopics.clientStateEvent,
            event
        )
    );
}

function toClientStateEventDedupeKey(event: ClientEvent): string {
    return [
        event.applicationId,
        normalizeStateWorkspaceId(event.workspaceId),
        event.principalId,
        event.eventId
    ].join('/');
}

function toReplayMaxPages(value?: number): number {
    if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
        return DEFAULT_RALLAR_REPLAY_MAX_PAGES;
    }
    return Math.min(value, MAX_RALLAR_REPLAY_MAX_PAGES);
}
