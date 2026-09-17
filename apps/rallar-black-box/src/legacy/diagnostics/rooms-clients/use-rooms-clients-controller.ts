import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { getRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/test-state-accessors.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { RallarServerWorkbenchVariables } from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { sendRallarServerRestRequest } from '../../../rallar-server-workbench/send-rallar-server-rest-request.ts';
import { toRallarServerWorkbenchVariables } from '../../../rallar-server-workbench/to-rallar-server-workbench-variables.ts';
import { computeRtcDiagnostics } from '../../../rtc-diagnostics.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { idleActionFeedback, type CommandCenterActionFeedback } from '../shared/action-feedback.ts';
import type { CommandCenterRestActionLog } from '../shared/to-rest-action-log-entry.ts';
import { RoomsClientsActions } from './rooms-clients-actions.ts';
import type {
    ClientSortId,
    GroupSortId,
    RoomsClientsActivity,
    RoomsClientsDraftModel,
    RoomsClientsOperations,
    RoomsClientsRows
} from './rooms-clients-contracts.ts';
import { toRoomsClientsRows, type RoomsClientsStateBodies } from './to-rooms-clients-rows.ts';

export interface UseRoomsClientsControllerInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    /** Absent until the browser signs in. */
    readonly authSession?: AuthSession;
    readonly globalValues: CommandCenterGlobalValues;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(key: K, value: CommandCenterGlobalValues[K]): void;
}

export interface RoomsClientsControllerModel
    extends RoomsClientsDraftModel, RoomsClientsActivity, RoomsClientsRows, RoomsClientsOperations {}

interface RoomsClientsControls extends RoomsClientsActivity {
    readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly setActionFeedback: React.Dispatch<React.SetStateAction<CommandCenterActionFeedback>>;
    readonly setActions: React.Dispatch<React.SetStateAction<readonly CommandCenterRestActionLog[]>>;
    readonly bodies: RoomsClientsStateBodies;
    readonly setBodies: React.Dispatch<React.SetStateAction<RoomsClientsStateBodies>>;
}

const EMPTY_BODIES: RoomsClientsStateBodies = {
    groupsBody: undefined,
    clientsBody: undefined,
    groupEventsBody: undefined,
    clientEventsBody: undefined
};

export function useRoomsClientsController(input: UseRoomsClientsControllerInput): RoomsClientsControllerModel {
    const diagnostics = useMemo(() => computeRtcDiagnostics(input.state, Date.now()), [input.state]);
    const draft = useRoomsClientsDraft(input);
    const controls = useRoomsClientsControls();
    const actions = new RoomsClientsActions({
        ...input,
        ...draft,
        ...controls,
        authSession: input.authSession,
        sendRequest: (request) => sendRallarServerRestRequest({ request, fetch }),
        nowMs: Date.now
    });
    return {
        ...draft,
        busyAction: controls.busyAction,
        localError: controls.localError,
        actionFeedback: controls.actionFeedback,
        actions: controls.actions,
        ...toRoomsClientsRows({ bodies: controls.bodies, draft, membership: diagnostics.membership }),
        runPresetAction: actions.runPresetAction,
        refreshState: actions.refreshState,
        runDirectRoomsAction: actions.runDirectRoomsAction,
        copyStateRecipe: actions.copyStateRecipe
    };
}

function useRoomsClientsDraft(input: UseRoomsClientsControllerInput): RoomsClientsDraftModel {
    const requestDraft = useRoomsClientsRequestDraft(input);
    const [timeoutMs, setTimeoutMs] = useState(5_000);
    const [onlyGroupsWithMembers, setOnlyGroupsWithMembers] = useState(false);
    const [onlyOnlineClients, setOnlyOnlineClients] = useState(false);
    const [groupSort, setGroupSort] = useState<GroupSortId>('active-desc');
    const [clientSort, setClientSort] = useState<ClientSortId>('online-active-desc');
    const [expectedOtherClient, setExpectedOtherClient] = useState('bob');
    return {
        ...requestDraft,
        timeoutMs,
        setTimeoutMs,
        onlyGroupsWithMembers,
        setOnlyGroupsWithMembers,
        onlyOnlineClients,
        setOnlyOnlineClients,
        groupSort,
        setGroupSort,
        clientSort,
        setClientSort,
        expectedOtherClient,
        setExpectedOtherClient
    };
}

function useRoomsClientsRequestDraft(
    input: UseRoomsClientsControllerInput
): Pick<RoomsClientsDraftModel, 'apiBaseUrl' | 'setApiBaseUrl' | 'variables' | 'updateVariable'> {
    const { bootstrap, authSession, globalValues } = input;
    const config = getRallarBlackBoxCurrentConfig(input.state);
    const defaultVariables = useRoomsClientsDefaultVariables(input);
    const [apiBaseUrl, setApiBaseUrl] = useState(globalValues.apiBaseUrl);
    const [variables, setVariables] = useState<RallarServerWorkbenchVariables>(defaultVariables);
    // A configured or bootstrap base URL change also discards a panel-edited base URL.
    useEffect(
        () => setApiBaseUrl(globalValues.apiBaseUrl),
        [bootstrap.apiBaseUrl, config?.apiBaseUrl, globalValues.apiBaseUrl]
    );
    // Panel identity edits are discarded on any global value change, even to the base URL alone, and on an auth
    // session, configured or bootstrap identity change that leaves the global values unchanged.
    useEffect(() => setVariables((current) => toSynchronizedVariables(current, defaultVariables)), [
        defaultVariables,
        globalValues,
        authSession?.clientId,
        authSession?.sessionId,
        bootstrap.actor,
        bootstrap.roomId,
        bootstrap.sessionId,
        config?.actor,
        config?.roomId,
        config?.sessionId
    ]);
    return {
        apiBaseUrl,
        setApiBaseUrl,
        variables,
        updateVariable: (key, value) => setVariables((current) => ({ ...current, [key]: value }))
    };
}

function useRoomsClientsDefaultVariables(
    { authSession, globalValues }: UseRoomsClientsControllerInput
): RallarServerWorkbenchVariables {
    return useMemo(
        () =>
            toRallarServerWorkbenchVariables({
                hints: {
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    principalId: globalValues.clientId,
                    sessionId: globalValues.sessionId,
                    groupId: globalValues.roomId,
                    username: authSession?.username ?? globalValues.clientId
                },
                createOpaqueId: () => crypto.randomUUID()
            }),
        [
            authSession?.username,
            globalValues.applicationId,
            globalValues.clientId,
            globalValues.roomId,
            globalValues.sessionId,
            globalValues.workspaceId
        ]
    );
}

function useRoomsClientsControls(): RoomsClientsControls {
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [actionFeedback, setActionFeedback] = useState<CommandCenterActionFeedback>(() =>
        idleActionFeedback('Run a Groups/Clients operation to see request status.')
    );
    const [actions, setActions] = useState<readonly CommandCenterRestActionLog[]>([]);
    const [bodies, setBodies] = useState<RoomsClientsStateBodies>(EMPTY_BODIES);
    return {
        busyAction,
        setBusyAction,
        localError,
        setLocalError,
        actionFeedback,
        setActionFeedback,
        actions,
        setActions,
        bodies,
        setBodies
    };
}

/** Global values own the shared identity fields; the opaque ids and an edited client instance id survive a global change. */
function toSynchronizedVariables(
    current: RallarServerWorkbenchVariables,
    defaults: RallarServerWorkbenchVariables
): RallarServerWorkbenchVariables {
    return {
        ...current,
        applicationId: defaults.applicationId,
        workspaceId: defaults.workspaceId,
        principalId: defaults.principalId,
        sessionId: defaults.sessionId,
        groupId: defaults.groupId,
        username: defaults.username,
        clientInstanceId: current.clientInstanceId || defaults.clientInstanceId
    };
}
