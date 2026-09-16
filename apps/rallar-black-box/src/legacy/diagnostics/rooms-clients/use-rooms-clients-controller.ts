import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { RallarServerWorkbenchVariables } from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { sendRallarServerRestRequest } from '../../../rallar-server-workbench/send-rallar-server-rest-request.ts';
import { toRallarServerWorkbenchVariables } from '../../../rallar-server-workbench/to-rallar-server-workbench-variables.ts';
import { deriveRtcDiagnostics } from '../../../rtc-diagnostics.ts';
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
    /** Absent when the panel renders outside the command-center shell. */
    readonly globalValues?: CommandCenterGlobalValues;
    /** Absent when the panel cannot change the shared command-center context. */
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(key: K, value: CommandCenterGlobalValues[K]): void;
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
    const diagnostics = useMemo(() => deriveRtcDiagnostics(input.state), [input.state]);
    const draft = useRoomsClientsDraft(input);
    const controls = useRoomsClientsControls();
    const actions = new RoomsClientsActions({
        ...input,
        ...draft,
        ...controls,
        authSession: input.authSession,
        globalValues: input.globalValues,
        sendRequest: (request) => sendRallarServerRestRequest({ request, fetch })
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
    const defaults = useRoomsClientsDefaults(input);
    const [apiBaseUrl, setApiBaseUrl] = useState(defaults.apiBaseUrl);
    const [variables, setVariables] = useState<RallarServerWorkbenchVariables>(defaults.variables);
    const [timeoutMs, setTimeoutMs] = useState(5_000);
    const [onlyGroupsWithMembers, setOnlyGroupsWithMembers] = useState(false);
    const [onlyOnlineClients, setOnlyOnlineClients] = useState(false);
    const [groupSort, setGroupSort] = useState<GroupSortId>('active-desc');
    const [clientSort, setClientSort] = useState<ClientSortId>('online-active-desc');
    const [expectedOtherClient, setExpectedOtherClient] = useState('bob');
    useEffect(
        () => setApiBaseUrl(defaults.apiBaseUrl),
        [input.bootstrap.apiBaseUrl, defaults.configApiBaseUrl, input.globalValues?.apiBaseUrl]
    );
    useEffect(() => {
        setVariables((current) => toSynchronizedVariables(current, defaults.variables, Boolean(input.globalValues)));
    }, [defaults.variables, input.globalValues]);
    return {
        apiBaseUrl,
        setApiBaseUrl,
        variables,
        updateVariable: (key, value) => setVariables((current) => ({ ...current, [key]: value })),
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

interface RoomsClientsDefaults {
    readonly apiBaseUrl: string;
    /** A change to the configured base URL re-applies the resolved one, even when a global base URL wins. */
    readonly configApiBaseUrl: string | undefined;
    readonly variables: RallarServerWorkbenchVariables;
}

function useRoomsClientsDefaults(
    { state, bootstrap, authSession, globalValues }: UseRoomsClientsControllerInput
): RoomsClientsDefaults {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const variables = useMemo(
        () =>
            toRallarServerWorkbenchVariables({
                hints: toRoomsClientsVariableHints({ state, bootstrap, authSession, globalValues }, config),
                createOpaqueId: () => crypto.randomUUID()
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
            globalValues?.workspaceId
        ]
    );
    return {
        apiBaseUrl: globalValues?.apiBaseUrl ?? config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        configApiBaseUrl: config?.apiBaseUrl,
        variables
    };
}

function toRoomsClientsVariableHints(
    { bootstrap, authSession, globalValues }: UseRoomsClientsControllerInput,
    config: ReturnType<typeof selectRallarBlackBoxCurrentConfig>
): Partial<RallarServerWorkbenchVariables> {
    return {
        applicationId: globalValues?.applicationId,
        workspaceId: globalValues?.workspaceId,
        principalId: globalValues?.clientId ?? authSession?.clientId ?? config?.actor ?? bootstrap.actor,
        sessionId: globalValues?.sessionId ?? authSession?.sessionId ?? config?.sessionId ?? bootstrap.sessionId,
        groupId: globalValues?.roomId ?? config?.roomId ?? bootstrap.roomId,
        username: authSession?.username ?? globalValues?.clientId ?? config?.actor ?? bootstrap.actor
    };
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

/** Global values own the shared identity fields; without them an operator edit survives until it is cleared. */
function toSynchronizedVariables(
    current: RallarServerWorkbenchVariables,
    defaults: RallarServerWorkbenchVariables,
    followsGlobalValues: boolean
): RallarServerWorkbenchVariables {
    const resolve = (key: 'applicationId' | 'workspaceId' | 'principalId' | 'sessionId' | 'groupId' | 'username') =>
        followsGlobalValues ? defaults[key] : current[key] || defaults[key];
    return {
        ...current,
        applicationId: resolve('applicationId'),
        workspaceId: resolve('workspaceId'),
        principalId: resolve('principalId'),
        sessionId: resolve('sessionId'),
        groupId: resolve('groupId'),
        username: resolve('username'),
        clientInstanceId: current.clientInstanceId || defaults.clientInstanceId
    };
}
