import type { RallarStateEventListener } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
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
        listener?: RallarStateEventListener<ClientEvent>;
    }>;

export interface RallarPeopleOperations {
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
        listener?: RallarStateEventListener<ClientEvent>
    ): Promise<RallarReplayEventsResult<ClientEvent>>;
    get(principalId: string): RallarPerson | undefined;
    onChange(
        listener: RallarStateListener<RallarPeopleState>,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
    onEvent(
        listener: RallarStateEventListener<ClientEvent>,
        options?: RallarPeopleEventOptions
    ): RallarUnsubscribe;
}
