import type { AuthSession } from '@shared/api/api-config.ts';
import { Either, EitherCollectors } from '@shared/resilience/Either.ts';
import type * as React from 'react';
import {
    configureDirectRallarFacade,
    createDirectRallarRuntimeEvent,
    type DirectRallarOperationContext
} from '../../../direct-rallar-operations.ts';
import type {
    RallarServerRestRequestInput,
    RallarServerRestResponse,
    RallarServerWorkbenchVariables
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { toRallarServerBlackBoxCommand } from '../../../rallar-server-workbench/to-rallar-server-black-box-command.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { json } from '../../shared/json-presentation.ts';
import { recordArray, recordValue } from '../../shared/record-value.ts';
import { writeTextToClipboard } from '../../shared/write-text-to-clipboard.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import {
    completedActionFeedback,
    runningActionFeedback,
    type CommandCenterActionFeedback
} from '../shared/action-feedback.ts';
import { findStringDeep } from '../shared/deep-string-value.ts';
import { toRestActionLogEntry, type CommandCenterRestActionLog } from '../shared/to-rest-action-log-entry.ts';
import {
    ROOMS_CLIENTS_ACTIONS,
    type RoomsClientsAction,
    type RoomsClientsActionId,
    type RoomsClientsDirectAction,
    type RoomsClientsOperations
} from './rooms-clients-contracts.ts';
import { toRoomsClientsPresetRequestInput } from './to-rooms-clients-preset-request-input.ts';
import type { RoomsClientsStateBodies } from './to-rooms-clients-rows.ts';

export namespace RoomsClientsActions {
    export interface Input {
        readonly bootstrap: RallarBlackBoxBootstrapConfig;
        readonly authSession: AuthSession | undefined;
        readonly globalValues: CommandCenterGlobalValues | undefined;
        /** Absent when the panel cannot change the shared command-center context. */
        onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
            key: K,
            value: CommandCenterGlobalValues[K]
        ): void;
        readonly apiBaseUrl: string;
        readonly variables: RallarServerWorkbenchVariables;
        readonly timeoutMs: number;
        readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setActionFeedback: React.Dispatch<React.SetStateAction<CommandCenterActionFeedback>>;
        readonly setActions: React.Dispatch<React.SetStateAction<readonly CommandCenterRestActionLog[]>>;
        readonly setBodies: React.Dispatch<React.SetStateAction<RoomsClientsStateBodies>>;
        sendRequest(request: RallarServerRestRequestInput): Promise<Either<string, RallarServerRestResponse>>;
        nowMs(): number;
    }

    export interface ActionAttempt {
        readonly label: string;
        readonly startedAtEpochMs: number;
    }

    export interface RefreshOutcome {
        readonly completed: number;
        readonly failedResponse: RallarServerRestResponse | undefined;
    }
}

const ACTION_LOG_LIMIT = 16;
const REFRESH_ACTION_IDS: readonly RoomsClientsActionId[] = [
    'list-groups',
    'list-clients',
    'read-group',
    'client-events-page',
    'group-events-page'
];
const RECIPE_ACTION_IDS: readonly RoomsClientsActionId[] = [
    'create-group',
    'join-group',
    'group-presence-connect',
    'client-session-connect',
    'group-events-page',
    'client-events-page'
];
const PROMOTING_ACTION_IDS: readonly RoomsClientsActionId[] = [
    'create-group',
    'read-group',
    'join-group',
    'group-presence-connect',
    'group-presence-heartbeat'
];
const BODY_KEY_BY_ACTION: Readonly<Partial<Record<RoomsClientsActionId, keyof RoomsClientsStateBodies>>> = {
    'list-groups': 'groupsBody',
    'create-group': 'groupsBody',
    'read-group': 'groupsBody',
    'join-group': 'groupsBody',
    'leave-group': 'groupsBody',
    'group-presence-connect': 'groupsBody',
    'group-presence-heartbeat': 'groupsBody',
    'group-presence-disconnect': 'groupsBody',
    'list-clients': 'clientsBody',
    'client-session-connect': 'clientsBody',
    'client-session-heartbeat': 'clientsBody',
    'client-session-disconnect': 'clientsBody',
    'group-events': 'groupEventsBody',
    'group-events-page': 'groupEventsBody',
    'client-events': 'clientEventsBody',
    'client-events-page': 'clientEventsBody'
};

export class RoomsClientsActions implements RoomsClientsOperations {
    private readonly input: RoomsClientsActions.Input;

    constructor(input: RoomsClientsActions.Input) {
        this.input = input;
    }

    readonly runPresetAction = async (action: RoomsClientsAction): Promise<void> => {
        if (!action.presetId) {
            return;
        }
        const attempt = this.startAttempt(action.label);
        const failed = (message: string) => this.recordFailure(attempt, action.presetId ?? '', message);
        try {
            await this.toPresetRequest(action).fold(async (message) => failed(message), async (request) => {
                this.input.setActionFeedback(
                    runningActionFeedback(action.label, request.path, 'Sending authenticated Rallar Server request.')
                );
                (await this.input.sendRequest(request)).fold(
                    failed,
                    (response) => this.recordPresetResponse(action, attempt, response)
                );
            });
        }
        catch (error) {
            failed(error instanceof Error ? error.message : String(error));
        }
        finally {
            this.input.setBusyAction(undefined);
        }
    };

    readonly refreshState = async (): Promise<void> => {
        const attempt = this.startAttempt('Refresh state');
        const target = `${this.input.apiBaseUrl}/api/state`;
        try {
            (await this.runRefreshSteps(attempt)).fold(
                (message) => this.recordFailure(attempt, target, message),
                (outcome) => this.recordRefreshOutcome(attempt, target, outcome)
            );
        }
        catch (error) {
            this.recordFailure(attempt, target, error instanceof Error ? error.message : String(error));
        }
        finally {
            this.input.setBusyAction(undefined);
        }
    };

    readonly runDirectRoomsAction = async (action: RoomsClientsDirectAction): Promise<void> => {
        const attempt = this.startAttempt(`Direct room ${action}`);
        this.input.setActionFeedback(
            runningActionFeedback(attempt.label, this.input.variables.groupId, 'Calling the browser Rallar facade.')
        );
        try {
            if (this.input.bootstrap.providerMode !== 'browser-rallar') {
                this.recordDirectFailure(attempt, action, 'Direct room actions require provider=browser-rallar.');
                return;
            }
            const facade = await loadBrowserRallarFacade();
            const context = this.toDirectContext();
            configureDirectRallarFacade(facade, context);
            await facade.start({
                connect: true,
                refreshRooms: false,
                refreshPeople: false,
                timeoutMs: this.input.timeoutMs
            });
            const body = await this.readDirectRoomResult(facade, action);
            this.applyDirectRoomResult(action, body);
            this.recordDirectCompleted({ attempt, action, context, body });
        }
        catch (error) {
            this.recordDirectFailure(attempt, action, error instanceof Error ? error.message : String(error));
        }
        finally {
            this.input.setBusyAction(undefined);
        }
    };

    readonly copyStateRecipe = async (): Promise<void> => {
        const commands = ROOMS_CLIENTS_ACTIONS.filter((action) => RECIPE_ACTION_IDS.includes(action.actionId)).map((
            action,
            index
        ) => this.toPresetRequest(action).flatMap(
            (error) => Either.ofLeft(error),
            (request) =>
                toRallarServerBlackBoxCommand({ request, commandId: `rooms-clients-${index + 1}-${action.actionId}` })
        ));
        const failure = EitherCollectors.toListFoldLefts(commands).at(0);
        if (failure !== undefined) {
            this.input.setLocalError(failure);
            return;
        }
        await this.copyText(
            json({
                schemaVersion: 1,
                recipeId: 'rallar-rooms-clients-command-center',
                name: 'Rallar rooms and clients command-center recipe',
                continueOnFailure: false,
                commands: EitherCollectors.toListFoldRights(commands)
            })
        );
    };

    private async copyText(text: string): Promise<void> {
        this.input.setLocalError(undefined);
        const written = await writeTextToClipboard(text);
        written.foldLeft(this.input.setLocalError);
    }

    private startAttempt(label: string): RoomsClientsActions.ActionAttempt {
        this.input.setBusyAction(label);
        this.input.setLocalError(undefined);
        return { label, startedAtEpochMs: this.input.nowMs() };
    }

    private toPresetRequest(action: RoomsClientsAction): Either<string, RallarServerRestRequestInput> {
        const { variables, apiBaseUrl, authSession, timeoutMs } = this.input;
        return toRoomsClientsPresetRequestInput({ action, variables, apiBaseUrl, authSession, timeoutMs });
    }

    private async runRefreshSteps(
        attempt: RoomsClientsActions.ActionAttempt
    ): Promise<Either<string, RoomsClientsActions.RefreshOutcome>> {
        let outcome: RoomsClientsActions.RefreshOutcome = { completed: 0, failedResponse: undefined };
        for (const actionId of REFRESH_ACTION_IDS) {
            const action = ROOMS_CLIENTS_ACTIONS.find((entry) => entry.actionId === actionId);
            if (!action?.presetId) {
                continue;
            }
            const step = await this.runRefreshStep(action, attempt, outcome);
            const next = step.foldRight((value) => value);
            if (next === undefined) {
                return step;
            }
            outcome = next;
        }
        return Either.ofRight(outcome);
    }

    private async runRefreshStep(
        action: RoomsClientsAction,
        attempt: RoomsClientsActions.ActionAttempt,
        outcome: RoomsClientsActions.RefreshOutcome
    ): Promise<Either<string, RoomsClientsActions.RefreshOutcome>> {
        const label = `Refresh state: ${action.label}`;
        return await this.toPresetRequest(action).fold(async (message) => Either.ofLeft(message), async (request) => {
            this.input.setActionFeedback(
                runningActionFeedback(label, request.path, `Running refresh step ${outcome.completed + 1}.`)
            );
            return (await this.input.sendRequest(request)).mapRight((response) => {
                const next = {
                    completed: outcome.completed + 1,
                    failedResponse: outcome.failedResponse ?? (response.ok ? undefined : response)
                };
                this.appendAction(toRestActionLogEntry(action.label, response, this.input.nowMs()));
                this.input.setActionFeedback(
                    toResponseFeedback(
                        { label, attempt, response },
                        response.ok ? `Refresh step ${next.completed} completed.` : 'Refresh step failed.'
                    )
                );
                this.applyResponseBody(action.actionId, response.bodyJson);
                return next;
            });
        });
    }

    private recordRefreshOutcome(
        attempt: RoomsClientsActions.ActionAttempt,
        target: string,
        { completed, failedResponse }: RoomsClientsActions.RefreshOutcome
    ): void {
        this.input.setActionFeedback(completedActionFeedback({
            label: attempt.label,
            startedAtEpochMs: attempt.startedAtEpochMs,
            target,
            ok: !failedResponse,
            status: failedResponse?.status ?? 'ok',
            statusText: failedResponse?.statusText,
            message: failedResponse
                ? `Refresh completed with a failed step: ${failedResponse.error?.message ?? failedResponse.statusText}.`
                : `${completed} state requests completed.`
        }));
    }

    private recordPresetResponse(
        action: RoomsClientsAction,
        attempt: RoomsClientsActions.ActionAttempt,
        response: RallarServerRestResponse
    ): void {
        this.appendAction(toRestActionLogEntry(action.label, response, this.input.nowMs()));
        this.input.setActionFeedback(
            toResponseFeedback(
                { label: action.label, attempt, response },
                response.ok ? 'Request completed.' : 'Request failed.'
            )
        );
        this.applyResponseBody(action.actionId, response.bodyJson);
        if (response.ok && PROMOTING_ACTION_IDS.includes(action.actionId)) {
            this.promoteGroupToGlobal(response.bodyJson);
        }
    }

    private recordFailure(attempt: RoomsClientsActions.ActionAttempt, target: string, message: string): void {
        this.input.setLocalError(message);
        this.input.setActionFeedback(completedActionFeedback({
            label: attempt.label,
            startedAtEpochMs: attempt.startedAtEpochMs,
            target,
            ok: false,
            statusText: 'error',
            message
        }));
    }

    private readDirectRoomResult(
        facade: Awaited<ReturnType<typeof loadBrowserRallarFacade>>,
        action: RoomsClientsDirectAction
    ): Promise<RoomsClientsStateBodies['groupsBody']> {
        const { variables: { applicationId, workspaceId, groupId }, timeoutMs } = this.input;
        const scope = { applicationId, workspaceId };
        switch (action) {
            case 'refresh':
                return facade.rooms.refresh({ scope, timeoutMs });
            case 'create':
                return facade.rooms.create({ displayName: groupId, scope, timeoutMs });
            case 'join':
                return facade.rooms.join(groupId, { scope, timeoutMs });
            case 'leave':
                return facade.rooms.leave({ roomId: groupId, scope, timeoutMs });
        }
    }

    private applyDirectRoomResult(action: RoomsClientsDirectAction, body: RoomsClientsStateBodies['groupsBody']): void {
        if (action === 'refresh') {
            const roomState = recordValue(body);
            this.input.setBodies((current) => ({
                ...current,
                groupsBody: recordArray(roomState.rooms).map((row) => row.snapshot ?? row),
                clientsBody: recordArray(roomState.members).map((row) => row.client ?? row)
            }));
        }
        else if (body !== undefined) {
            this.input.setBodies((current) => ({ ...current, groupsBody: body }));
        }
        if (action === 'create' || action === 'join') {
            this.promoteGroupToGlobal(body);
        }
    }

    private recordDirectCompleted(completed: DirectRoomCompletion): void {
        const { attempt, action, context, body } = completed;
        this.appendAction({
            ...toDirectActionLogBase(attempt, action, this.input.nowMs()),
            ok: true,
            status: 200,
            statusText: 'OK',
            bodyJson: body
        });
        this.input.setActionFeedback(completedActionFeedback({
            label: attempt.label,
            startedAtEpochMs: attempt.startedAtEpochMs,
            target: this.input.variables.groupId,
            ok: true,
            status: 'ok',
            message: 'Rallar facade action completed.'
        }));
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic: `rallar.direct.rooms.${action}.completed`,
                context,
                payload: { action, result: body }
            }),
            `Direct room ${action} completed`
        );
    }

    private recordDirectFailure(
        attempt: RoomsClientsActions.ActionAttempt,
        action: RoomsClientsDirectAction,
        message: string
    ): void {
        this.input.setLocalError(message);
        this.appendAction({
            ...toDirectActionLogBase(attempt, action, this.input.nowMs()),
            ok: false,
            status: 0,
            statusText: message,
            errorKind: 'direct-rallar'
        });
        this.input.setActionFeedback(completedActionFeedback({
            label: attempt.label,
            startedAtEpochMs: attempt.startedAtEpochMs,
            target: this.input.variables.groupId,
            ok: false,
            statusText: 'error',
            message
        }));
    }

    private toDirectContext(): DirectRallarOperationContext {
        const { bootstrap, apiBaseUrl, variables, authSession, timeoutMs } = this.input;
        return {
            providerMode: bootstrap.providerMode,
            apiBaseUrl,
            applicationId: variables.applicationId,
            workspaceId: variables.workspaceId,
            roomId: variables.groupId,
            actor: authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
            connection: 'rooms-clients',
            authSession,
            timeoutMs
        };
    }

    private appendAction(entry: CommandCenterRestActionLog): void {
        this.input.setActions((current) => [...current, entry].slice(-ACTION_LOG_LIMIT));
    }

    private applyResponseBody(actionId: RoomsClientsActionId, body: RoomsClientsStateBodies['groupsBody']): void {
        const key = BODY_KEY_BY_ACTION[actionId];
        if (body !== undefined && key) {
            this.input.setBodies((current) => ({ ...current, [key]: body }));
        }
    }

    private promoteGroupToGlobal(body: RoomsClientsStateBodies['groupsBody']): void {
        const { globalValues, onGlobalValueChange, variables } = this.input;
        const groupId = findStringDeep(body, ['groupId', 'roomId']) ?? variables.groupId.trim();
        if (groupId && onGlobalValueChange && globalValues?.roomId !== groupId) {
            onGlobalValueChange('roomId', groupId);
        }
    }
}

interface DirectRoomCompletion {
    readonly attempt: RoomsClientsActions.ActionAttempt;
    readonly action: RoomsClientsDirectAction;
    readonly context: DirectRallarOperationContext;
    readonly body: RoomsClientsStateBodies['groupsBody'];
}

interface ResponseFeedbackSource {
    readonly label: string;
    readonly attempt: RoomsClientsActions.ActionAttempt;
    readonly response: RallarServerRestResponse;
}

function toResponseFeedback(
    { label, attempt, response }: ResponseFeedbackSource,
    fallbackMessage: string
): CommandCenterActionFeedback {
    return completedActionFeedback({
        label,
        startedAtEpochMs: attempt.startedAtEpochMs,
        target: response.url,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        durationMs: response.durationMs,
        message: response.ok ? fallbackMessage : (response.error?.message ?? fallbackMessage)
    });
}

function toDirectActionLogBase(
    attempt: RoomsClientsActions.ActionAttempt,
    action: RoomsClientsDirectAction,
    nowMs: number
): Pick<CommandCenterRestActionLog, 'actionId' | 'label' | 'atEpochMs' | 'durationMs'> {
    return {
        actionId: `direct-room-${action}-${nowMs}`,
        label: attempt.label,
        atEpochMs: nowMs,
        durationMs: Math.max(0, nowMs - attempt.startedAtEpochMs)
    };
}
