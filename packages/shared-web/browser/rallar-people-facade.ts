import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarStateEventListener } from '@shared-web/browser/rallar-messages-facade.ts';
import type {
    RallarOnChangeOptions,
    RallarReplayEventsResult,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ClientEvent, ClientEventType, ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateEventCursor, StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export type RallarPerson = Readonly<{
    principalId: string;
    username: string;
    displayName?: string;
    isOnline: boolean;
    activeSessionCount: number;
    activeSessionIds: readonly string[];
    snapshot: ClientSnapshot;
}>;

export type RallarPeopleState = Readonly<{
    people: readonly RallarPerson[];
    clients: readonly ClientSnapshot[];
}>;

export type RallarPeopleEventOptions = Readonly<{
    scope?: StateScope;
    principalId?: string;
    eventTypes?: readonly ClientEventType[];
}>;

export type RallarListPeopleEventsOptions =
    & RallarScopedOperationOptions
    & Readonly<{
        eventTypes?: readonly ClientEventType[];
        limit?: number;
        after?: StateEventCursor;
    }>;

export type RallarReplayPeopleEventsOptions =
    & RallarListPeopleEventsOptions
    & Readonly<{
        maxPages?: number;
        listener?: RallarPeopleEventListener;
    }>;

export type RallarPeopleEventListener = RallarStateEventListener<ClientEvent>;

export type RallarPeopleFacade = Readonly<{
    state(): RallarPeopleState;
    list(): readonly RallarPerson[];
    refresh(input?: StateScope | RallarScopedOperationOptions): Promise<RallarPeopleState>;
    listEvents(
        principalId: string,
        options?: RallarListPeopleEventsOptions
    ): Promise<readonly ClientEvent[]>;
    listEventPage(
        principalId: string,
        options?: RallarListPeopleEventsOptions
    ): Promise<StateEventPage<ClientEvent>>;
    replayEvents(
        principalId: string,
        options?: RallarReplayPeopleEventsOptions,
        listener?: RallarPeopleEventListener
    ): Promise<RallarReplayEventsResult<ClientEvent>>;
    get(principalId: string): RallarPerson | undefined;
    onChange(
        listener: RallarStateListener<RallarPeopleState>,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
    onEvent(
        listener: RallarPeopleEventListener,
        options?: RallarPeopleEventOptions
    ): RallarUnsubscribe;
}>;

export type CreateRallarPeopleFacadeOptions = RallarPeopleFacade;

export function createRallarPeopleFacade(
    operations: CreateRallarPeopleFacadeOptions
): RallarPeopleFacade {
    return {
        state: (): RallarPeopleState => operations.state(),
        list: (): readonly RallarPerson[] => operations.list(),
        refresh: async (input): Promise<RallarPeopleState> => await operations.refresh(input),
        listEvents: async (
            principalId,
            options = {}
        ): Promise<readonly ClientEvent[]> => await operations.listEvents(principalId, options),
        listEventPage: async (
            principalId,
            options = {}
        ): Promise<StateEventPage<ClientEvent>> => await operations.listEventPage(principalId, options),
        replayEvents: async (
            principalId,
            options = {},
            listener
        ): Promise<RallarReplayEventsResult<ClientEvent>> =>
            await operations.replayEvents(principalId, options, listener),
        get: (principalId): RallarPerson | undefined => operations.get(principalId),
        onChange: (
            listener,
            options = {}
        ): RallarUnsubscribe => operations.onChange(listener, options),
        onEvent: (
            listener,
            options = {}
        ): RallarUnsubscribe => operations.onEvent(listener, options)
    };
}
