import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarStateEventListener } from '@shared-web/browser/rallar-message-contracts.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type {
    RallarListPeopleEventsOptions,
    RallarPeopleEventOptions,
    RallarPeopleState,
    RallarPerson,
    RallarReplayPeopleEventsOptions
} from '@shared-web/browser/rallar-people-contracts.ts';
import type { RallarStateEventsPort } from '@shared-web/browser/rallar-runtime/state-events.ts';
import type {
    RallarStatePort,
    RallarStateSnapshotAcceptanceInput
} from '@shared-web/browser/rallar-runtime/state-store.ts';
import type {
    RallarOnChangeOptions,
    RallarReplayEventsResult,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import { refreshStateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export interface CreateRallarPeopleControllerOptions {
    readonly stateStore: RallarStatePort;
    readonly stateEvents: RallarStateEventsPort;
    resolveOperationOptions<T extends RallarOperationOptions>(options: T): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
    connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
    acceptSnapshots(input: RallarStateSnapshotAcceptanceInput): Promise<void>;
}

export interface RallarPeopleController {
    readonly operations: RallarPeopleOperations;
}

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

export function createRallarPeopleController(
    options: CreateRallarPeopleControllerOptions
): RallarPeopleController {
    const refresh = async (
        input?: StateScope | RallarScopedOperationOptions
    ): Promise<RallarPeopleState> =>
        await options.runAuthAwareOperation(async () => {
            const refreshOptions = toRallarScopedOperationOptions(input);
            const operationOptions = options.resolveOperationOptions(refreshOptions);
            const ctx = await options.connect(operationOptions);
            const operationScope = options.resolveOperationScope(
                refreshOptions.scope
            );
            const { clients, groups } = await refreshStateSnapshots(
                operationScope,
                toRallarWorkflowPolicies(operationOptions)
            );
            await options.acceptSnapshots({ context: ctx, clients, groups, scope: operationScope });
            return options.stateStore.peopleState();
        });

    return {
        operations: {
            state: () => options.stateStore.peopleState(),
            list: () => options.stateStore.peopleState().people,
            refresh,
            listEvents: async (principalId, eventOptions = {}) =>
                await options.stateEvents.listPeopleEvents(principalId, eventOptions),
            listEventPage: async (principalId, eventOptions = {}) =>
                await options.stateEvents.listPeopleEventPage(
                    principalId,
                    eventOptions
                ),
            replayEvents: async (principalId, eventOptions = {}, listener) =>
                await options.stateEvents.replayPeopleEventsFromFacade(
                    principalId,
                    eventOptions,
                    listener
                ),
            get: (principalId) => options.stateStore.person(principalId),
            onChange: (listener, changeOptions = {}) => options.stateStore.onPeopleChange(listener, changeOptions),
            onEvent: (listener, eventOptions = {}) => options.stateEvents.onPeopleEvent(listener, eventOptions)
        }
    };
}

function toRallarScopedOperationOptions(
    input?: StateScope | RallarScopedOperationOptions
): RallarScopedOperationOptions {
    if (!input) {
        return {};
    }
    return isStateScope(input) ? { scope: input } : input;
}

function isStateScope(
    input: StateScope | RallarScopedOperationOptions
): input is StateScope {
    return (
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input) &&
        'applicationId' in input &&
        typeof input.applicationId === 'string'
    );
}
