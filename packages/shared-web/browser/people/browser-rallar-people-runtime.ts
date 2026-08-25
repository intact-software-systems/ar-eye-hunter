import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarStateEventListener } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type {
    RallarListPeopleEventsOptions,
    RallarPeopleEventOptions,
    RallarPeopleOperations,
    RallarPeopleState,
    RallarPerson,
    RallarReplayPeopleEventsOptions
} from '@shared-web/browser/people/rallar-people-contracts.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
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
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export namespace BrowserRallarPeopleRuntime {
    export interface Input {
        readonly stateStore: RallarStatePort;
        readonly stateEvents: RallarStateEventsPort;
        resolveOperationOptions<T extends RallarOperationOptions>(
            options: T
        ): T & RallarOperationOptions;
        resolveOperationScope(scope?: StateScope): StateScope | undefined;
        runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
        connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
        acceptSnapshots(input: RallarStateSnapshotAcceptanceInput): Promise<void>;
    }
}

/** Owns browser people state reads, refresh, and event access. */
export class BrowserRallarPeopleRuntime implements RallarPeopleOperations {
    private readonly input: BrowserRallarPeopleRuntime.Input;

    public constructor(input: BrowserRallarPeopleRuntime.Input) {
        this.input = input;
    }

    public state(): RallarPeopleState {
        return this.input.stateStore.peopleState();
    }

    public list(): readonly RallarPerson[] {
        return this.input.stateStore.peopleState().people;
    }

    public async refresh(
        input?: StateScope | RallarScopedOperationOptions
    ): Promise<RallarPeopleState> {
        return await this.input.runAuthAwareOperation(async () => {
            const refreshOptions = toRallarScopedOperationOptions(input);
            const operationOptions = this.input.resolveOperationOptions(refreshOptions);
            const context = await this.input.connect(operationOptions);
            const operationScope = this.input.resolveOperationScope(
                refreshOptions.scope
            );
            const { clients, groups } = await refreshStateSnapshots(
                operationScope,
                toRallarWorkflowPolicies(operationOptions)
            );
            await this.input.acceptSnapshots({
                context,
                clients,
                groups,
                scope: operationScope
            });
            return this.input.stateStore.peopleState();
        });
    }

    public async listEvents(
        principalId: string,
        options: RallarListPeopleEventsOptions = {}
    ): Promise<readonly ClientEvent[]> {
        return await this.input.stateEvents.listPeopleEvents(principalId, options);
    }

    public async listEventPage(
        principalId: string,
        options: RallarListPeopleEventsOptions = {}
    ): Promise<StateEventPage<ClientEvent>> {
        return await this.input.stateEvents.listPeopleEventPage(principalId, options);
    }

    public async replayEvents(
        principalId: string,
        options: RallarReplayPeopleEventsOptions = {},
        listener?: RallarStateEventListener<ClientEvent>
    ): Promise<RallarReplayEventsResult<ClientEvent>> {
        return await this.input.stateEvents.replayPeopleEventsFromFacade(
            principalId,
            options,
            listener
        );
    }

    public get(principalId: string): RallarPerson | undefined {
        return this.input.stateStore.person(principalId);
    }

    public onChange(
        listener: RallarStateListener<RallarPeopleState>,
        options: RallarOnChangeOptions = {}
    ): RallarUnsubscribe {
        return this.input.stateStore.onPeopleChange(listener, options);
    }

    public onEvent(
        listener: RallarStateEventListener<ClientEvent>,
        options: RallarPeopleEventOptions = {}
    ): RallarUnsubscribe {
        return this.input.stateEvents.onPeopleEvent(listener, options);
    }
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
