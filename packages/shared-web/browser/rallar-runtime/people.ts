import * as apiWorkflows from '@shared-web/browser/api-workflows.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarRefreshOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { CreateRallarPeopleFacadeOptions, RallarPeopleState } from '@shared-web/browser/rallar-people-facade.ts';
import type { RallarStateEventsPort } from '@shared-web/browser/rallar-runtime/state-events.ts';
import type { RallarStatePort } from '@shared-web/browser/rallar-runtime/state-store.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export type CreateRallarPeopleControllerOptions = Readonly<{
    stateStore: RallarStatePort;
    stateEvents: RallarStateEventsPort;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
    connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
    acceptSnapshots(
        ctx: ApiMiddleware,
        clients: readonly ClientSnapshot[],
        groups: readonly GroupSnapshot[],
        scope?: StateScope
    ): Promise<void>;
}>;

export type RallarPeopleController = Readonly<{
    operations: CreateRallarPeopleFacadeOptions;
}>;

export function createRallarPeopleController(
    options: CreateRallarPeopleControllerOptions
): RallarPeopleController {
    const refresh = async (
        input?: StateScope | RallarRefreshOptions
    ): Promise<RallarPeopleState> =>
        await options.runAuthAwareOperation(async () => {
            const refreshOptions = toRallarRefreshOptions(input);
            const operationOptions = options.resolveOperationOptions(
                refreshOptions
            );
            const ctx = await options.connect(operationOptions);
            const operationScope = options.resolveOperationScope(
                refreshOptions.scope
            );
            const { clients, groups } = await apiWorkflows.refreshStateSnapshots(
                operationScope,
                toRallarWorkflowPolicies(operationOptions)
            );
            await options.acceptSnapshots(
                ctx,
                clients,
                groups,
                operationScope
            );
            return options.stateStore.peopleState();
        });

    return {
        operations: {
            state: () => options.stateStore.peopleState(),
            list: () => options.stateStore.peopleState().people,
            refresh,
            listEvents: async (principalId, eventOptions = {}) =>
                await options.stateEvents.listPeopleEvents(
                    principalId,
                    eventOptions
                ),
            listEventPage: async (principalId, eventOptions = {}) =>
                await options.stateEvents.listPeopleEventPage(
                    principalId,
                    eventOptions
                ),
            replayEvents: async (
                principalId,
                eventOptions = {},
                listener
            ) => await options.stateEvents.replayPeopleEventsFromFacade(
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

function toRallarRefreshOptions(
    input?: StateScope | RallarRefreshOptions
): RallarRefreshOptions {
    if (!input) {
        return {};
    }
    return isStateScope(input) ? { scope: input } : input;
}

function isStateScope(
    input: StateScope | RallarRefreshOptions
): input is StateScope {
    return typeof input === 'object' && input !== null &&
        !Array.isArray(input) &&
        typeof (input as { applicationId?: unknown; }).applicationId === 'string';
}
