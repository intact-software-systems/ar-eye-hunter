import { useEffect, useMemo, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import {
    configureDirectRallarFacade,
    createDirectRallarRuntimeEvent,
} from '../../../direct-rallar-operations.ts';
import {
    defaultRallarServerWorkbenchVariables,
    executeRallarServerRestRequest,
    toRallarServerBlackBoxCommand,
    type RallarServerRestResponse,
    type RallarServerWorkbenchVariables,
} from '../../../rallar-server-workbench.ts';
import { deriveRtcDiagnostics } from '../../../rtc-diagnostics.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxRuntimeStore,
} from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { json } from '../../shared/json-presentation.ts';
import {
    recordArray,
    recordValue as optionalRecord,
} from '../../shared/record-value.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import {
    type CommandCenterActionFeedback,
    completedActionFeedback,
    idleActionFeedback,
    runningActionFeedback,
} from '../shared/action-feedback.ts';
import { findStringDeep } from '../shared/deep-string-value.ts';
import {
    type CommandCenterRestActionLog,
    restLogEntry,
} from '../shared/rest-action-log.ts';
import {
    ROOMS_CLIENTS_ACTIONS,
    type ClientSortId,
    type GroupSortId,
    type RoomsClientsAction,
    type RoomsClientsActionId,
} from './rooms-clients-contracts.ts';
import {
    rowsFromClientSnapshots,
    rowsFromGroupSnapshots,
    rowsFromStateEvents,
    sortClientRows,
    sortGroupRows,
} from './rooms-clients-derivations.ts';
import { buildPresetRequestInput } from './rooms-clients-request.ts';

export type UseRoomsClientsControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
}>;

export function useRoomsClientsController({
    state,
    bootstrap,
    authSession,
    globalValues,
    onGlobalValueChange,
}: UseRoomsClientsControllerInput) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const diagnostics = useMemo(() => deriveRtcDiagnostics(state), [state]);
    const defaultVariables = useMemo(
        () =>
            defaultRallarServerWorkbenchVariables({
                applicationId: globalValues?.applicationId,
                workspaceId: globalValues?.workspaceId,
                principalId:
                    globalValues?.clientId ??
                    authSession?.clientId ??
                    config?.actor ??
                    bootstrap.actor,
                sessionId:
                    globalValues?.sessionId ??
                    authSession?.sessionId ??
                    config?.sessionId ??
                    bootstrap.sessionId,
                groupId:
                    globalValues?.roomId ?? config?.roomId ?? bootstrap.roomId,
                username:
                    authSession?.username ??
                    globalValues?.clientId ??
                    config?.actor ??
                    bootstrap.actor,
            }),
        [
            authSession?.clientId,
            authSession?.sessionId,
            authSession?.username,
            bootstrap.actor,
            bootstrap.roomId,
            bootstrap.sessionId,
            config?.actor,
            config?.roomId,
            config?.sessionId,
            globalValues?.applicationId,
            globalValues?.clientId,
            globalValues?.roomId,
            globalValues?.sessionId,
            globalValues?.workspaceId,
        ],
    );
    const [apiBaseUrl, setApiBaseUrl] = useState(
        globalValues?.apiBaseUrl ?? config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
    );
    const [variables, setVariables] =
        useState<RallarServerWorkbenchVariables>(defaultVariables);
    const [timeoutMs, setTimeoutMs] = useState(5_000);
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [actionFeedback, setActionFeedback] =
        useState<CommandCenterActionFeedback>(() =>
            idleActionFeedback(
                'Run a Groups/Clients operation to see request status.',
            ),
        );
    const [actions, setActions] = useState<
        readonly CommandCenterRestActionLog[]
    >([]);
    const [groupsBody, setGroupsBody] = useState<unknown>();
    const [clientsBody, setClientsBody] = useState<unknown>();
    const [groupEventsBody, setGroupEventsBody] = useState<unknown>();
    const [clientEventsBody, setClientEventsBody] = useState<unknown>();
    const [onlyGroupsWithMembers, setOnlyGroupsWithMembers] = useState(false);
    const [onlyOnlineClients, setOnlyOnlineClients] = useState(false);
    const [groupSort, setGroupSort] = useState<GroupSortId>('active-desc');
    const [clientSort, setClientSort] =
        useState<ClientSortId>('online-active-desc');
    const [expectedOtherClient, setExpectedOtherClient] = useState('bob');

    useEffect(() => {
        setApiBaseUrl(
            globalValues?.apiBaseUrl ??
                config?.apiBaseUrl ??
                bootstrap.apiBaseUrl,
        );
    }, [bootstrap.apiBaseUrl, config?.apiBaseUrl, globalValues?.apiBaseUrl]);

    useEffect(() => {
        setVariables((current) => ({
            ...current,
            applicationId: globalValues
                ? defaultVariables.applicationId
                : current.applicationId || defaultVariables.applicationId,
            workspaceId: globalValues
                ? defaultVariables.workspaceId
                : current.workspaceId || defaultVariables.workspaceId,
            principalId: globalValues
                ? defaultVariables.principalId
                : current.principalId || defaultVariables.principalId,
            sessionId: globalValues
                ? defaultVariables.sessionId
                : current.sessionId || defaultVariables.sessionId,
            groupId: globalValues
                ? defaultVariables.groupId
                : current.groupId || defaultVariables.groupId,
            username: globalValues
                ? defaultVariables.username
                : current.username || defaultVariables.username,
            clientInstanceId:
                current.clientInstanceId || defaultVariables.clientInstanceId,
        }));
    }, [defaultVariables, globalValues]);

    const updateVariable = <K extends keyof RallarServerWorkbenchVariables>(
        key: K,
        value: RallarServerWorkbenchVariables[K],
    ): void => {
        setVariables((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const appendAction = (entry: CommandCenterRestActionLog): void => {
        setActions((current) => [...current, entry].slice(-16));
    };

    const promoteGroupToGlobal = (body?: unknown): void => {
        const groupId =
            findStringDeep(body, ['groupId', 'roomId']) ??
            variables.groupId.trim();
        if (
            groupId &&
            onGlobalValueChange &&
            globalValues?.roomId !== groupId
        ) {
            onGlobalValueChange('roomId', groupId);
        }
    };

    const applyResponseBody = (
        actionId: RoomsClientsActionId,
        body: unknown,
    ): void => {
        if (
            actionId === 'list-groups' ||
            actionId === 'create-group' ||
            actionId === 'read-group' ||
            actionId === 'join-group' ||
            actionId === 'leave-group' ||
            actionId === 'group-presence-connect' ||
            actionId === 'group-presence-heartbeat' ||
            actionId === 'group-presence-disconnect'
        ) {
            setGroupsBody(body);
        }
        if (
            actionId === 'list-clients' ||
            actionId === 'client-session-connect' ||
            actionId === 'client-session-heartbeat' ||
            actionId === 'client-session-disconnect'
        ) {
            setClientsBody(body);
        }
        if (actionId === 'group-events' || actionId === 'group-events-page') {
            setGroupEventsBody(body);
        }
        if (actionId === 'client-events' || actionId === 'client-events-page') {
            setClientEventsBody(body);
        }
    };

    const runPresetAction = async (
        action: RoomsClientsAction,
    ): Promise<void> => {
        if (!action.presetId) {
            return;
        }
        setBusyAction(action.label);
        setLocalError(undefined);
        const startedAtEpochMs = Date.now();
        try {
            const requestInput = buildPresetRequestInput({
                presetId: action.presetId,
                variables,
                apiBaseUrl,
                authSession,
                timeoutMs,
                query: action.query,
            });
            setActionFeedback(
                runningActionFeedback(
                    action.label,
                    requestInput.path,
                    'Sending authenticated Rallar Server request.',
                ),
            );
            const response = await executeRallarServerRestRequest(requestInput);
            appendAction(restLogEntry(action.label, response));
            setActionFeedback(
                completedActionFeedback({
                    label: action.label,
                    startedAtEpochMs,
                    target: response.url,
                    ok: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    durationMs: response.durationMs,
                    message: response.ok
                        ? 'Request completed.'
                        : (response.error?.message ?? 'Request failed.'),
                }),
            );
            if (response.bodyJson !== undefined) {
                applyResponseBody(action.actionId, response.bodyJson);
            }
            if (
                response.ok &&
                [
                    'create-group',
                    'read-group',
                    'join-group',
                    'group-presence-connect',
                    'group-presence-heartbeat',
                ].includes(action.actionId)
            ) {
                promoteGroupToGlobal(response.bodyJson);
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label: action.label,
                    startedAtEpochMs,
                    target: action.presetId,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const refreshState = async (): Promise<void> => {
        setBusyAction('Refresh state');
        setLocalError(undefined);
        const startedAtEpochMs = Date.now();
        let completed = 0;
        let failedResponse: RallarServerRestResponse | undefined;
        try {
            for (const actionId of [
                'list-groups',
                'list-clients',
                'read-group',
                'client-events-page',
                'group-events-page',
            ] as const) {
                const action = ROOMS_CLIENTS_ACTIONS.find(
                    (entry) => entry.actionId === actionId,
                );
                if (!action?.presetId) {
                    continue;
                }
                const requestInput = buildPresetRequestInput({
                    presetId: action.presetId,
                    variables,
                    apiBaseUrl,
                    authSession,
                    timeoutMs,
                    query: action.query,
                });
                setActionFeedback(
                    runningActionFeedback(
                        `Refresh state: ${action.label}`,
                        requestInput.path,
                        `Running refresh step ${completed + 1}.`,
                    ),
                );
                const response =
                    await executeRallarServerRestRequest(requestInput);
                appendAction(restLogEntry(action.label, response));
                completed += 1;
                if (!response.ok && !failedResponse) {
                    failedResponse = response;
                }
                setActionFeedback(
                    completedActionFeedback({
                        label: `Refresh state: ${action.label}`,
                        startedAtEpochMs,
                        target: response.url,
                        ok: response.ok,
                        status: response.status,
                        statusText: response.statusText,
                        durationMs: response.durationMs,
                        message: response.ok
                            ? `Refresh step ${completed} completed.`
                            : (response.error?.message ??
                              'Refresh step failed.'),
                    }),
                );
                if (response.bodyJson !== undefined) {
                    applyResponseBody(action.actionId, response.bodyJson);
                }
            }
            setActionFeedback(
                completedActionFeedback({
                    label: 'Refresh state',
                    startedAtEpochMs,
                    target: `${apiBaseUrl}/api/state`,
                    ok: !failedResponse,
                    status: failedResponse?.status ?? 'ok',
                    statusText: failedResponse?.statusText,
                    message: failedResponse
                        ? `Refresh completed with a failed step: ${failedResponse.error?.message ?? failedResponse.statusText}.`
                        : `${completed} state requests completed.`,
                }),
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Refresh state',
                    startedAtEpochMs,
                    target: `${apiBaseUrl}/api/state`,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const runDirectRoomsAction = async (
        action: 'refresh' | 'create' | 'join' | 'leave',
    ): Promise<void> => {
        const providerMode = bootstrap.providerMode;
        setBusyAction(`Direct room ${action}`);
        setLocalError(undefined);
        const label = `Direct room ${action}`;
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                variables.groupId,
                'Calling the browser Rallar facade.',
            ),
        );
        try {
            if (providerMode !== 'browser-rallar') {
                throw new Error(
                    'Direct room actions require provider=browser-rallar.',
                );
            }
            const facade = await loadBrowserRallarFacade();
            const context = {
                providerMode,
                apiBaseUrl,
                applicationId: variables.applicationId,
                workspaceId: variables.workspaceId,
                roomId: variables.groupId,
                actor:
                    authSession?.username ??
                    authSession?.clientId ??
                    bootstrap.actor,
                connection: 'rooms-clients',
                authSession,
                timeoutMs,
            };
            configureDirectRallarFacade(facade, context);
            await facade.start({
                connect: true,
                refreshRooms: false,
                refreshPeople: false,
                timeoutMs,
            });

            let body: unknown;
            if (action === 'refresh') {
                body = await facade.rooms.refresh({
                    scope: {
                        applicationId: variables.applicationId,
                        workspaceId: variables.workspaceId,
                    },
                    timeoutMs,
                });
            } else if (action === 'create') {
                body = await facade.rooms.create({
                    displayName: variables.groupId,
                    scope: {
                        applicationId: variables.applicationId,
                        workspaceId: variables.workspaceId,
                    },
                    timeoutMs,
                });
            } else if (action === 'join') {
                body = await facade.rooms.join(variables.groupId, {
                    scope: {
                        applicationId: variables.applicationId,
                        workspaceId: variables.workspaceId,
                    },
                    timeoutMs,
                });
            } else {
                body = await facade.rooms.leave({
                    roomId: variables.groupId,
                    scope: {
                        applicationId: variables.applicationId,
                        workspaceId: variables.workspaceId,
                    },
                    timeoutMs,
                });
            }

            if (action === 'refresh') {
                const roomState = optionalRecord(body);
                setGroupsBody(
                    recordArray(roomState.rooms).map(
                        (row) => optionalRecord(row).snapshot ?? row,
                    ),
                );
                setClientsBody(
                    recordArray(roomState.members).map(
                        (row) => optionalRecord(row).client ?? row,
                    ),
                );
            } else if (body !== undefined) {
                setGroupsBody(body);
            }
            if (action === 'create' || action === 'join') {
                promoteGroupToGlobal(body);
            }
            appendAction({
                actionId: `direct-room-${action}-${Date.now()}`,
                label,
                atEpochMs: Date.now(),
                ok: true,
                status: 200,
                statusText: 'OK',
                durationMs: Math.max(0, Date.now() - startedAtEpochMs),
                bodyJson: body,
            });
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: variables.groupId,
                    ok: true,
                    status: 'ok',
                    message: 'Rallar facade action completed.',
                }),
            );
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                createDirectRallarRuntimeEvent({
                    topic: `rallar.direct.rooms.${action}.completed`,
                    context,
                    payload: {
                        action,
                        result: body,
                    },
                }),
                `Direct room ${action} completed`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            appendAction({
                actionId: `direct-room-${action}-${Date.now()}`,
                label,
                atEpochMs: Date.now(),
                ok: false,
                status: 0,
                statusText: message,
                durationMs: Math.max(0, Date.now() - startedAtEpochMs),
                errorKind: 'direct-rallar',
            });
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: variables.groupId,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const copyStateRecipe = (): void => {
        const commands = ROOMS_CLIENTS_ACTIONS.filter((action) =>
            [
                'create-group',
                'join-group',
                'group-presence-connect',
                'client-session-connect',
                'group-events-page',
                'client-events-page',
            ].includes(action.actionId),
        ).map((action, index) => {
            const input = buildPresetRequestInput({
                presetId: action.presetId!,
                variables,
                apiBaseUrl,
                authSession,
                timeoutMs,
                query: action.query,
            });
            return toRallarServerBlackBoxCommand(
                input,
                `rooms-clients-${index + 1}-${action.actionId}`,
            );
        });
        void navigator.clipboard?.writeText(
            json({
                recipeId: 'rallar-rooms-clients-command-center',
                name: 'Rallar rooms and clients command-center recipe',
                continueOnFailure: false,
                commands,
            }),
        );
    };

    const groupRows = rowsFromGroupSnapshots(groupsBody);
    const clientRows = rowsFromClientSnapshots(clientsBody);
    const visibleGroupRows = onlyGroupsWithMembers
        ? groupRows.filter((row) => row.members > 0)
        : groupRows;
    const visibleClientRows = onlyOnlineClients
        ? clientRows.filter(
              (row) => row.online === 'online' || row.sessions.length > 0,
          )
        : clientRows;
    const sortedGroupRows = sortGroupRows(visibleGroupRows, groupSort);
    const sortedClientRows = sortClientRows(visibleClientRows, clientSort);
    const stateEvents = [
        ...rowsFromStateEvents(groupEventsBody),
        ...rowsFromStateEvents(clientEventsBody),
    ]
        .slice(-32)
        .reverse();
    const expectedClients = diagnostics.membership.expectedClients;
    const observedClients = diagnostics.membership.observedClients;
    const missingClients = expectedClients.filter(
        (client) => !observedClients.includes(client),
    );
    const activeGroupRow = groupRows.find(
        (row) =>
            row.groupId === variables.groupId ||
            row.displayName === variables.groupId,
    );
    const currentSessionInGroup = Boolean(
        variables.sessionId &&
        activeGroupRow?.sessions.includes(variables.sessionId),
    );
    const currentClientRow = clientRows.find(
        (row) =>
            row.principalId === variables.principalId ||
            row.username === variables.username ||
            row.sessions.includes(variables.sessionId),
    );
    const currentClientOnline =
        currentClientRow?.online === 'online' ||
        (currentClientRow?.sessions.length ?? 0) > 0 ||
        currentSessionInGroup;
    const expectedOtherClientVisible =
        expectedOtherClient.trim().length === 0
            ? false
            : clientRows.some(
                  (row) =>
                      [row.principalId, row.username, ...row.sessions].some(
                          (value) =>
                              value
                                  .toLowerCase()
                                  .includes(
                                      expectedOtherClient.trim().toLowerCase(),
                                  ),
                      ) &&
                      (row.online === 'online' || row.sessions.length > 0),
              );

    return {
        apiBaseUrl,
        setApiBaseUrl,
        variables,
        timeoutMs,
        setTimeoutMs,
        busyAction,
        localError,
        actionFeedback,
        actions,
        onlyGroupsWithMembers,
        setOnlyGroupsWithMembers,
        onlyOnlineClients,
        setOnlyOnlineClients,
        groupSort,
        setGroupSort,
        clientSort,
        setClientSort,
        expectedOtherClient,
        setExpectedOtherClient,
        updateVariable,
        runPresetAction,
        refreshState,
        runDirectRoomsAction,
        copyStateRecipe,
        groupRows,
        clientRows,
        visibleGroupRows,
        visibleClientRows,
        sortedGroupRows,
        sortedClientRows,
        stateEvents,
        expectedClients,
        observedClients,
        missingClients,
        currentSessionInGroup,
        currentClientOnline,
        expectedOtherClientVisible,
    };
}

export type RoomsClientsControllerModel = ReturnType<
    typeof useRoomsClientsController
>;
