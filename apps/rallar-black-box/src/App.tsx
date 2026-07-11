import {
    type FormEvent,
    type KeyboardEvent,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import Sigma from 'sigma';
import type {
    AuthSession,
    WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import { clearSession, readSession, writeSession } from '@shared/api/auth.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { consumeAgentSessionTicket } from '@shared-web/browser/api-integration.ts';
import {
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxCurrentConfig,
    selectRallarBlackBoxEvents,
    selectRallarBlackBoxFirstFailure,
    selectRallarBlackBoxLatestStats,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEventKind,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';
import type {
    RallarCrdtOperationBatch,
    RallarCrdtTransportStrategy,
} from '@shared/crdt/crdt-types.ts';
import type { RallarCrdtDocument } from '@shared-web/browser/rallar-crdt.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxProviderModeFromConfig,
    rallarBlackBoxRuntimeStore,
    useRallarBlackBoxRuntimeStore,
} from './runtime-store.ts';
import {
    authenticateRallarBlackBox,
    authErrorMessage,
    bootstrapPatchFromAuthSession,
} from './auth-flow.ts';
import { readAuthSessionFromRallarAuthState } from './auth-lifecycle.ts';
import type { RallarBlackBoxControlSnapshot } from './control-client.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from './client-defaults.ts';
import {
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    type ManualWorkbenchAction,
} from './manual-workbench.ts';
import {
    deriveRtcDiagnostics,
    deriveRtcPerformanceView,
    type RtcConnectStageStatus,
} from './rtc-diagnostics.ts';
import {
    deriveRallarTopologyGraph,
    visibleTopologyCounts,
    type RallarTopologyFilter,
} from './topology-graph.ts';
import {
    APP_MODES,
    appModeForTab,
    appTabInMode,
    appTabsForMode,
    defaultAppTabForMode,
    nextAppTab,
    visibleAppTabForTab,
    type AppModeId,
    type AppTabId,
    type RunnerAdvancedSurfaceId,
} from './app-tabs.ts';
import {
    CRDT_EDITOR_TRANSPORTS,
    addCrdtEditorCardBatch,
    addCrdtEditorColumnBatch,
    addCrdtEditorEntityBatch,
    addCrdtEditorEntityScoreBatch,
    addCrdtEditorTagBatch,
    changeCrdtEditorEntityHealthBatch,
    createCrdtEditorInitialValue,
    crdtEditorOperationGroupId,
    deleteCrdtEditorCardBatch,
    moveCrdtEditorCardBatch,
    removeCrdtEditorTagBatch,
    renameCrdtEditorColumnBatch,
    setCrdtEditorCooldownMinBatch,
    updateCrdtEditorCardStatusBatch,
    updateCrdtEditorEntityBatch,
    type CrdtEditorTransport,
    type CrdtEditorValue,
    type CrdtEditorView,
} from './crdt-editor.ts';
import {
    RALLAR_SERVER_ENDPOINT_PRESETS,
    applyRallarServerEndpointPreset,
    assertRallarServerRestResponse,
    buildRallarServerRestRequest,
    buildRallarServerCollectionStepRequestInput,
    createRallarServerRestCollectionTemplates,
    defaultRallarServerWorkbenchVariables,
    executeRallarServerRestRequest,
    extractRallarServerRestVariables,
    fetchRallarServerOpenApiEndpoints,
    redactRallarServerText,
    redactRallarServerUrl,
    redactRallarServerValue,
    toRallarServerBlackBoxCommand,
    toRallarServerCurl,
    toRallarServerRestCollectionRecipe,
    type RallarServerEndpointPreset,
    type RallarServerResponseBodyMode,
    type RallarServerRestCollection,
    type RallarServerRestCollectionStepResult,
    type RallarServerRestCollectionVariables,
    type RallarServerRestMethod,
    type RallarServerRestRequestInput,
    type RallarServerRestResponse,
    type RallarServerWorkbenchVariables,
} from './rallar-server-workbench.ts';
import {
    configureDirectRallarFacade,
    createDirectRallarRuntimeEvent,
    runDirectRallarGroupCreate,
    runDirectRallarGroupJoin,
    runDirectRallarStatusCheck,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe,
    type DirectRallarOperationResult,
} from './direct-rallar-operations.ts';
import {
    readRallarServerRestCollectionDraft,
    readRallarServerWorkbenchDraft,
    readStoredAppMode,
    readStoredAppTab,
    readStoredSelectedCommandId,
    writeRallarServerRestCollectionDraft,
    writeRallarServerWorkbenchDraft,
    writeStoredAppMode,
    writeStoredAppTab,
    writeStoredSelectedCommandId,
    type RallarServerRestCollectionDraft,
    type RallarServerWorkbenchDraft,
} from './ui-persistence.ts';
import { browserUiStorage } from './legacy/shell/browser-ui-storage.ts';
import {
    normalizeAppNavigation,
    readInitialAppNavigation,
    writeAppNavigationToUrl,
    type AppNavigationState,
} from './legacy/shell/navigation.ts';
import type { CommandCenterGlobalValues } from './legacy/shell/global-context-model.ts';
import type {
    CommandQueueRow,
    RunnerDistributedRunSelection,
} from './legacy/runner/runner-contracts.ts';
import { loadBrowserRallarFacade } from './legacy/rallar/load-browser-rallar-facade.ts';
import { Metric } from './legacy/shared/Metric.tsx';
import { CollapsiblePanelSection } from './legacy/shared/CollapsiblePanelSection.tsx';
import {
    formatDuration,
    formatRelativeDuration,
    formatTime,
} from './legacy/shared/time-format.ts';
import {
    json,
    parseJsonText,
    splitCsvValues,
} from './legacy/shared/json-presentation.ts';
import {
    redactedJson,
    uiRedactionOptions,
    uiSecretValues,
} from './legacy/shared/redaction-presentation.ts';
import {
    commandId,
    resultSummary,
    statusTone,
} from './legacy/shared/command-presentation.ts';
import { recordValue as optionalRecord } from './legacy/shared/record-value.ts';
import { stringValue } from './legacy/shared/string-value.ts';
import { optionalNumber } from './legacy/shared/finite-number.ts';
import { useNow } from './legacy/shared/use-now.ts';
import {
    type CommandCenterActionFeedback,
    completedActionFeedback,
    idleActionFeedback,
    runningActionFeedback,
} from './legacy/diagnostics/shared/action-feedback.ts';
import { CommandCenterActionFeedbackPanel } from './legacy/diagnostics/shared/CommandCenterActionFeedbackPanel.tsx';
import { ExecutionFocusPanel } from './legacy/diagnostics/events/ExecutionFocusPanel.tsx';
import { EventStreamPanel } from './legacy/diagnostics/events/EventStreamPanel.tsx';
import { RallarTracePanel } from './legacy/diagnostics/events/RallarTracePanel.tsx';
import { StatsPanel } from './legacy/diagnostics/events/StatsPanel.tsx';
import {
    deriveRallarBrowserStatus,
    type RallarBrowserStatusSummary,
} from './legacy/shell/rallar-browser-status.ts';
import { RallarBrowserTraceBar } from './legacy/shell/RallarBrowserTraceBar.tsx';
import { CommandHistoryPanel } from './legacy/runner/advanced/CommandHistoryPanel.tsx';
import { RunnerAdvancedPanel } from './legacy/runner/advanced/RunnerAdvancedPanel.tsx';
import { RtcDiagnosticsTimeseriesPanel } from './legacy/runner/evidence/rtc/RtcDiagnosticsTimeseriesPanel.tsx';
import { RtcPerformancePanel } from './legacy/runner/evidence/rtc/RtcPerformancePanel.tsx';
import { FailurePanel, RunnerRunsPanel } from './legacy/runner/runs/RunnerRunsPanel.tsx';
import { RunManagerPanel } from './legacy/runner/run-manager/RunManagerPanel.tsx';
import { LocalWorkbenchSection } from './legacy/runner/workbench/LocalWorkbenchSection.tsx';
import { ManualRallarSection } from './legacy/runner/manual/ManualRallarSection.tsx';
import { SharedTestPanel } from './legacy/runner/shared-test/SharedTestPanel.tsx';
import { DistributedRecipesPanel } from './legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx';
import { RunnerRecipesPanel } from './legacy/runner/recipes/RunnerRecipesPanel.tsx';
import { FlowBuilderPanel } from './legacy/runner/builder/FlowBuilderPanel.tsx';
import { RunnerFleetPanel } from './legacy/runner/fleet/RunnerFleetPanel.tsx';

// Recipe Console work belongs under `src/recipe-console/**`; legacy extraction belongs under `src/legacy/**`; no new feature panel belongs in `App.tsx`.

type RallarServerRequestFeedback = Readonly<{
    state: 'idle' | 'sending' | 'success' | 'error';
    method?: RallarServerRestMethod;
    path?: string;
    url?: string;
    status?: number;
    statusText?: string;
    durationMs?: number;
    errorKind?: string;
    message?: string;
    atEpochMs?: number;
}>;

type CommandCenterRestActionLog = Readonly<{
    actionId: string;
    label: string;
    atEpochMs: number;
    ok: boolean;
    status: number;
    statusText: string;
    durationMs: number;
    errorKind?: string;
    bodyJson?: unknown;
}>;

type AuthCommandCenterTicket = Readonly<{
    ticket: string;
    sessionId: string;
    expiresAtEpochMs: number;
    issuedAtEpochMs: number;
}>;

type RoomsClientsActionId =
    | 'refresh-state'
    | 'list-groups'
    | 'list-clients'
    | 'create-group'
    | 'read-group'
    | 'join-group'
    | 'leave-group'
    | 'client-session-connect'
    | 'client-session-heartbeat'
    | 'client-session-disconnect'
    | 'group-presence-connect'
    | 'group-presence-heartbeat'
    | 'group-presence-disconnect'
    | 'group-events'
    | 'group-events-page'
    | 'client-events'
    | 'client-events-page';

type RoomsClientsAction = Readonly<{
    actionId: RoomsClientsActionId;
    label: string;
    presetId?: string;
    query?: Readonly<Record<string, unknown>>;
}>;

type RoomsClientsActionCategory = Readonly<{
    categoryId: 'groups' | 'clients';
    title: string;
    description: string;
    actions: readonly RoomsClientsAction[];
}>;

type RoomStateRow = Readonly<{
    rowId: string;
    groupId: string;
    displayName: string;
    status: string;
    members: number;
    online: number;
    sessions: readonly string[];
    createdAtEpochMs?: number;
    updatedAtEpochMs?: number;
    activeAtEpochMs?: number;
    mutatedAtEpochMs?: number;
    snapshotVersion?: number;
}>;

type ClientStateRow = Readonly<{
    rowId: string;
    principalId: string;
    username: string;
    status: string;
    online: string;
    sessions: readonly string[];
    createdAtEpochMs?: number;
    updatedAtEpochMs?: number;
    activeAtEpochMs?: number;
    mutatedAtEpochMs?: number;
    snapshotVersion?: number;
}>;

type GroupSortId =
    | 'active-desc'
    | 'mutated-desc'
    | 'created-desc'
    | 'online-desc'
    | 'members-desc'
    | 'name-asc'
    | 'status-asc';

type ClientSortId =
    | 'online-active-desc'
    | 'active-desc'
    | 'mutated-desc'
    | 'created-desc'
    | 'sessions-desc'
    | 'name-asc'
    | 'status-asc';

type StateEventRow = Readonly<{
    rowId: string;
    eventType: string;
    subject: string;
    snapshotVersion: string;
    atEpochMs?: number;
}>;

type WebSocketPayloadPreset = Readonly<{
    presetId: string;
    label: string;
    description: string;
    payload: unknown;
    values?: Partial<
        Pick<
            WebSocketCommandCenterValues,
            'wsScope' | 'typeId' | 'topicId' | 'contextId'
        >
    >;
}>;

type WebSocketRoutePreview = Readonly<{
    destination: string;
    destinationDetail: string;
    selector: string;
    selectorDetail: string;
    transport: string;
    transportDetail: string;
    sendLabel: string;
}>;

type WebSocketCommandCenterValues = Readonly<{
    apiBaseUrl: string;
    connection: string;
    applicationId: string;
    workspaceId: string;
    groupId: string;
    wsScope: 'room' | 'all' | 'world';
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    wsUrl: string;
    protocols: string;
    payloadText: string;
    timeoutMs: number;
    closeCode: number;
    closeReason: string;
}>;

type WebSocketEventRow = Readonly<{
    eventId: string;
    kind: RallarBlackBoxTestEventKind;
    topic: string;
    atEpochMs: number;
    severity: string;
    payload?: unknown;
}>;

type WebSocketReceivedMessageRow = Readonly<{
    eventId: string;
    atEpochMs: number;
    senderId: string;
    roomId: string;
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    payload?: unknown;
}>;

type WebSocketDiagnostic = Readonly<{
    readyState: string;
    status: 'idle' | 'open' | 'closed' | 'simulated' | 'error';
    statusLabel: string;
    lastOpenAtEpochMs?: number;
    lastCloseAtEpochMs?: number;
    closeCode?: unknown;
    closeReason?: unknown;
    inboundCount: number;
    outboundCount: number;
    errorCount: number;
    recentEvents: readonly WebSocketEventRow[];
    receivedMessages: readonly WebSocketReceivedMessageRow[];
}>;

type WebSocketSubscriptionState = Readonly<{
    label: string;
    destination: string;
    groupId: string;
    subscribedAtEpochMs: number;
    unsubscribe(): void;
}>;

type QuickRallarTransport = 'ws';

type QuickRallarValues = Readonly<{
    transport: QuickRallarTransport;
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    payloadText: string;
    timeoutMs: number;
}>;

type QuickRallarSubscriptionState = Readonly<{
    transport: QuickRallarTransport;
    label: string;
    groupId: string;
    subscribedAtEpochMs: number;
    unsubscribe(): void;
}>;

type QuickRallarReceivedMessageRow = Readonly<{
    rowId: string;
    atEpochMs: number;
    transport: QuickRallarTransport;
    senderId: string;
    roomId: string;
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    payload?: unknown;
    raw?: unknown;
}>;

type RtcRealtimeTransport = 'realtime' | 'messages.rtc';

type RtcRealtimeReceivedRow = Readonly<{
    rowId: string;
    atEpochMs: number;
    transport: RtcRealtimeTransport;
    peerId: string;
    laneId: string;
    roomId: string;
    typeId: string;
    topicId: string;
    contextId: string;
    payload?: unknown;
    raw?: unknown;
}>;

type RtcRealtimeSubscriptionRow = Readonly<{
    subscriptionId: string;
    transport: RtcRealtimeTransport;
    label: string;
    laneId: string;
    groupId: string;
    subscribedAtEpochMs: number;
    unsubscribe(): void;
}>;

type RallarDataOperation =
    | 'define'
    | 'open'
    | 'lookup'
    | 'hydrate'
    | 'when-idle'
    | 'read'
    | 'get'
    | 'keys'
    | 'list-keys'
    | 'read-entries'
    | 'get-entries'
    | 'read-all'
    | 'get-all'
    | 'set'
    | 'update'
    | 'update-or-create'
    | 'set-if-absent'
    | 'compare-and-set'
    | 'get-and-set'
    | 'delete'
    | 'delete-expired'
    | 'clear'
    | 'flush'
    | 'export'
    | 'estimate-usage'
    | 'close'
    | 'destroy'
    | 'close-scope'
    | 'clear-scope'
    | 'destroy-scope';

type RallarDataChangeRow = Readonly<{
    rowId: string;
    atEpochMs: number;
    event: unknown;
}>;

type BrowserRallarFacade = Awaited<ReturnType<typeof loadBrowserRallarFacade>>;
type RallarDataUiStore = Awaited<
    ReturnType<
        Awaited<ReturnType<typeof loadBrowserRallarFacade>>['data']['open']
    >
>;

type MediaRemoteStreamRow = Readonly<{
    rowId: string;
    atEpochMs: number;
    peerId: string;
    streamId: string;
}>;

const GROUP_SORT_OPTIONS: readonly Readonly<{
    value: GroupSortId;
    label: string;
}>[] = [
    { value: 'active-desc', label: 'Recently active' },
    { value: 'mutated-desc', label: 'Mutated newest' },
    { value: 'created-desc', label: 'Created newest' },
    { value: 'online-desc', label: 'Online members' },
    { value: 'members-desc', label: 'Members' },
    { value: 'name-asc', label: 'Name / ID' },
    { value: 'status-asc', label: 'Status' },
];

const CLIENT_SORT_OPTIONS: readonly Readonly<{
    value: ClientSortId;
    label: string;
}>[] = [
    { value: 'online-active-desc', label: 'Online first' },
    { value: 'active-desc', label: 'Recently active' },
    { value: 'mutated-desc', label: 'Mutated newest' },
    { value: 'created-desc', label: 'Created newest' },
    { value: 'sessions-desc', label: 'Sessions' },
    { value: 'name-asc', label: 'Name / ID' },
    { value: 'status-asc', label: 'Status' },
];

const WEBSOCKET_PAYLOAD_PRESETS: readonly WebSocketPayloadPreset[] = [
    {
        presetId: 'ping',
        label: 'Ping - all WS subscribers',
        description:
            'Broadcast liveness payload with scope all. It is not tied to the Group field.',
        payload: {
            seq: 1,
            text: 'ping from rallar-black-box',
        },
        values: {
            wsScope: 'all',
            typeId: 'app.black-box.ws.ping',
            topicId: 'app.black-box.ws.ping',
            contextId: 'all',
        },
    },
    {
        presetId: 'group-message',
        label: 'Group Message - current group',
        description:
            'Broadcast payload to the configured Group using room scope.',
        payload: {
            deliveryMode: 'broadcast',
            text: 'hello from rallar-black-box',
        },
        values: {
            wsScope: 'room',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
        },
    },
    {
        presetId: 'parity-probe',
        label: 'Compare WS vs RTC - current group',
        description:
            'Use this payload when comparing WebSocket and RTC delivery for the same group.',
        payload: {
            transport: 'ws',
            seq: 1,
        },
        values: {
            wsScope: 'room',
            typeId: 'room.black-box.transport-check',
            topicId: 'room.black-box.transport-check',
        },
    },
];
const DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID = 'group-message';

const QUICK_RALLAR_DEFAULT_VALUES: QuickRallarValues = {
    transport: 'ws',
    typeId: 'room.manual.message',
    topicId: 'room.manual.message',
    contextId: '',
    resourceId: '',
    payloadText: json({
        text: 'hello from quick Rallar test',
        seq: 1,
    }),
    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
};

const ROOMS_CLIENTS_ACTION_GROUPS: readonly RoomsClientsActionCategory[] = [
    {
        categoryId: 'groups',
        title: 'Groups',
        description:
            'Group records, membership, group presence, and group event evidence.',
        actions: [
            {
                actionId: 'list-groups',
                label: 'List groups',
                presetId: 'groups-list',
            },
            {
                actionId: 'create-group',
                label: 'Create group',
                presetId: 'group-create',
            },
            {
                actionId: 'read-group',
                label: 'Read group',
                presetId: 'group-read',
            },
            {
                actionId: 'join-group',
                label: 'Join group',
                presetId: 'group-member-join',
            },
            {
                actionId: 'leave-group',
                label: 'Leave group',
                presetId: 'group-member-leave',
            },
            {
                actionId: 'group-presence-connect',
                label: 'Connect group presence',
                presetId: 'group-presence-connect',
            },
            {
                actionId: 'group-presence-heartbeat',
                label: 'Heartbeat group',
                presetId: 'group-presence-heartbeat',
            },
            {
                actionId: 'group-presence-disconnect',
                label: 'Disconnect group',
                presetId: 'group-presence-disconnect',
            },
            {
                actionId: 'group-events',
                label: 'List group events',
                presetId: 'group-events',
            },
            {
                actionId: 'group-events-page',
                label: 'List group events page',
                presetId: 'group-events-page',
                query: { limit: 20 },
            },
        ],
    },
    {
        categoryId: 'clients',
        title: 'Clients',
        description:
            'Client snapshots, client session presence, and client event evidence.',
        actions: [
            {
                actionId: 'list-clients',
                label: 'List clients',
                presetId: 'clients-list',
            },
            {
                actionId: 'client-session-connect',
                label: 'Connect client presence',
                presetId: 'client-session-connect',
            },
            {
                actionId: 'client-session-heartbeat',
                label: 'Heartbeat client',
                presetId: 'client-session-heartbeat',
            },
            {
                actionId: 'client-session-disconnect',
                label: 'Disconnect client',
                presetId: 'client-session-disconnect',
            },
            {
                actionId: 'client-events',
                label: 'List client events',
                presetId: 'client-events',
            },
            {
                actionId: 'client-events-page',
                label: 'List client events page',
                presetId: 'client-events-page',
                query: { limit: 20 },
            },
        ],
    },
];
const ROOMS_CLIENTS_ACTIONS: readonly RoomsClientsAction[] =
    ROOMS_CLIENTS_ACTION_GROUPS.flatMap((group) => group.actions);

function findStringDeep(
    value: unknown,
    keys: readonly string[],
    depth = 0,
): string | undefined {
    if (depth > 4 || value === undefined || value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findStringDeep(item, keys, depth + 1);
            if (found) return found;
        }
        return undefined;
    }
    if (typeof value !== 'object') {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate;
        }
    }
    for (const child of Object.values(record)) {
        const found = findStringDeep(child, keys, depth + 1);
        if (found) return found;
    }
    return undefined;
}

function recordArray(value: unknown): readonly Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.filter(
            (item): item is Record<string, unknown> =>
                Boolean(item) &&
                typeof item === 'object' &&
                !Array.isArray(item),
        );
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return [value as Record<string, unknown>];
    }

    return [];
}

function numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function auditAtEpochMs(value: unknown): number | undefined {
    return optionalNumber(optionalRecord(value).atEpochMs);
}

function maxNumber(
    values: readonly (number | undefined)[],
): number | undefined {
    const numbers = values.filter(
        (value): value is number => value !== undefined,
    );
    return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

function compareNumberDesc(
    left: number | undefined,
    right: number | undefined,
): number {
    return (
        (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY)
    );
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, {
        sensitivity: 'base',
        numeric: true,
    });
}

function firstComparison(...comparisons: readonly number[]): number {
    return comparisons.find((value) => value !== 0) ?? 0;
}

function stringOrDash(value: unknown): string {
    return typeof value === 'string' && value.length > 0 ? value : '-';
}

function rowsFromGroupSnapshots(value: unknown): readonly RoomStateRow[] {
    return recordArray(value).map((snapshot, index) => {
        const group = optionalRecord(snapshot.group);
        const members = recordArray(snapshot.members);
        const activeSessions = recordArray(snapshot.activeSessions);
        const groupId = stringOrDash(group.groupId ?? snapshot.groupId);
        const createdAtEpochMs = auditAtEpochMs(group.created);
        const updatedAtEpochMs = auditAtEpochMs(group.updated);
        const activeAtEpochMs = maxNumber(
            activeSessions.flatMap((session) => [
                optionalNumber(session.lastHeartbeatAtEpochMs),
                optionalNumber(session.connectedAtEpochMs),
            ]),
        );
        const mutatedAtEpochMs = maxNumber([
            updatedAtEpochMs,
            createdAtEpochMs,
            activeAtEpochMs,
            ...members.flatMap((member) => [
                auditAtEpochMs(member.updated),
                auditAtEpochMs(member.joined),
                auditAtEpochMs(member.left),
                auditAtEpochMs(member.removed),
                auditAtEpochMs(member.banned),
            ]),
        ]);
        return {
            rowId: `${groupId}-${index}`,
            groupId,
            displayName: stringOrDash(
                group.displayName ?? group.slug ?? groupId,
            ),
            status: stringOrDash(group.status),
            members: numberOrZero(snapshot.memberCount),
            online: numberOrZero(snapshot.onlineMemberCount),
            sessions: activeSessions.map((session) =>
                stringOrDash(session.sessionId),
            ),
            createdAtEpochMs,
            updatedAtEpochMs,
            activeAtEpochMs,
            mutatedAtEpochMs,
            snapshotVersion: optionalNumber(group.snapshotVersion),
        };
    });
}

function rowsFromClientSnapshots(value: unknown): readonly ClientStateRow[] {
    return recordArray(value).map((snapshot, index) => {
        const principal = optionalRecord(snapshot.principal);
        const instances = recordArray(snapshot.instances);
        const activeSessions = recordArray(snapshot.activeSessions);
        const principalId = stringOrDash(
            principal.principalId ?? snapshot.principalId,
        );
        const createdAtEpochMs = auditAtEpochMs(principal.created);
        const updatedAtEpochMs = auditAtEpochMs(principal.updated);
        const activeAtEpochMs = maxNumber([
            optionalNumber(snapshot.lastSeenAtEpochMs),
            optionalNumber(principal.lastSeenAtEpochMs),
            ...activeSessions.flatMap((session) => [
                optionalNumber(session.lastHeartbeatAtEpochMs),
                optionalNumber(session.connectedAtEpochMs),
                optionalNumber(session.authenticatedAtEpochMs),
            ]),
        ]);
        const mutatedAtEpochMs = maxNumber([
            updatedAtEpochMs,
            createdAtEpochMs,
            activeAtEpochMs,
            ...instances.flatMap((instance) => [
                auditAtEpochMs(instance.updated),
                auditAtEpochMs(instance.registered),
                auditAtEpochMs(instance.revoked),
            ]),
        ]);
        return {
            rowId: `${principalId}-${index}`,
            principalId,
            username: stringOrDash(
                principal.username ?? principal.displayName ?? principalId,
            ),
            status: stringOrDash(principal.status),
            online: snapshot.isOnline === true ? 'online' : 'offline',
            sessions: activeSessions.map((session) =>
                stringOrDash(session.sessionId),
            ),
            createdAtEpochMs,
            updatedAtEpochMs,
            activeAtEpochMs,
            mutatedAtEpochMs,
            snapshotVersion: optionalNumber(principal.snapshotVersion),
        };
    });
}

function sortGroupRows(
    rows: readonly RoomStateRow[],
    sortId: GroupSortId,
): readonly RoomStateRow[] {
    return [...rows].sort((left, right) => {
        switch (sortId) {
            case 'active-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.activeAtEpochMs,
                        right.activeAtEpochMs,
                    ),
                    right.online - left.online,
                    right.members - left.members,
                    compareText(left.displayName, right.displayName),
                );
            case 'mutated-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.mutatedAtEpochMs,
                        right.mutatedAtEpochMs,
                    ),
                    compareText(left.displayName, right.displayName),
                );
            case 'created-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.createdAtEpochMs,
                        right.createdAtEpochMs,
                    ),
                    compareText(left.displayName, right.displayName),
                );
            case 'online-desc':
                return firstComparison(
                    right.online - left.online,
                    compareNumberDesc(
                        left.activeAtEpochMs,
                        right.activeAtEpochMs,
                    ),
                    compareText(left.displayName, right.displayName),
                );
            case 'members-desc':
                return firstComparison(
                    right.members - left.members,
                    right.online - left.online,
                    compareText(left.displayName, right.displayName),
                );
            case 'status-asc':
                return firstComparison(
                    compareText(left.status, right.status),
                    compareText(left.displayName, right.displayName),
                );
            case 'name-asc':
                return compareText(left.displayName, right.displayName);
        }
    });
}

function sortClientRows(
    rows: readonly ClientStateRow[],
    sortId: ClientSortId,
): readonly ClientStateRow[] {
    return [...rows].sort((left, right) => {
        switch (sortId) {
            case 'online-active-desc':
                return firstComparison(
                    Number(right.online === 'online') -
                        Number(left.online === 'online'),
                    compareNumberDesc(
                        left.activeAtEpochMs,
                        right.activeAtEpochMs,
                    ),
                    compareText(left.username, right.username),
                );
            case 'active-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.activeAtEpochMs,
                        right.activeAtEpochMs,
                    ),
                    compareText(left.username, right.username),
                );
            case 'mutated-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.mutatedAtEpochMs,
                        right.mutatedAtEpochMs,
                    ),
                    compareText(left.username, right.username),
                );
            case 'created-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.createdAtEpochMs,
                        right.createdAtEpochMs,
                    ),
                    compareText(left.username, right.username),
                );
            case 'sessions-desc':
                return firstComparison(
                    right.sessions.length - left.sessions.length,
                    Number(right.online === 'online') -
                        Number(left.online === 'online'),
                    compareText(left.username, right.username),
                );
            case 'status-asc':
                return firstComparison(
                    compareText(left.status, right.status),
                    compareText(left.username, right.username),
                );
            case 'name-asc':
                return compareText(left.username, right.username);
        }
    });
}

function rowsFromStateEvents(value: unknown): readonly StateEventRow[] {
    const rows = Array.isArray(value)
        ? value
        : recordArray(optionalRecord(value).events);
    return rows
        .filter(
            (item): item is Record<string, unknown> =>
                Boolean(item) &&
                typeof item === 'object' &&
                !Array.isArray(item),
        )
        .map((event, index) => ({
            rowId: stringOrDash(
                event.eventId ?? `${event.eventType ?? 'event'}-${index}`,
            ),
            eventType: stringOrDash(event.eventType),
            subject: stringOrDash(
                event.groupId ?? event.principalId ?? event.sessionId,
            ),
            snapshotVersion: String(event.snapshotVersion ?? '-'),
            atEpochMs:
                typeof event.occurredAtEpochMs === 'number'
                    ? event.occurredAtEpochMs
                    : undefined,
        }));
}

function rallarServerPresetById(presetId: string): RallarServerEndpointPreset {
    const preset = RALLAR_SERVER_ENDPOINT_PRESETS.find(
        (entry) => entry.presetId === presetId,
    );
    if (!preset) {
        throw new Error(`Unknown Rallar Server preset: ${presetId}`);
    }
    return preset;
}

function buildPresetRequestInput(
    input: Readonly<{
        presetId: string;
        variables: RallarServerWorkbenchVariables;
        apiBaseUrl: string;
        authSession?: AuthSession;
        timeoutMs: number;
        query?: Readonly<Record<string, unknown>>;
        attachAuth?: boolean;
    }>,
): RallarServerRestRequestInput {
    const draft = applyRallarServerEndpointPreset(
        rallarServerPresetById(input.presetId),
        input.variables,
    );
    const query = {
        ...(JSON.parse(draft.queryText || '{}') as Record<string, unknown>),
        ...(input.query ?? {}),
    };
    return {
        apiBaseUrl: input.apiBaseUrl,
        method: draft.method,
        path: draft.path,
        headersText: draft.headersText,
        queryText: JSON.stringify(query, null, 2),
        bodyText: draft.bodyText,
        responseBodyMode: draft.responseBodyMode,
        attachAuth: input.attachAuth ?? draft.attachAuth,
        authSession: input.authSession,
        timeoutMs: input.timeoutMs,
    };
}

function restLogEntry(
    label: string,
    response: RallarServerRestResponse,
): CommandCenterRestActionLog {
    return {
        actionId: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
        label,
        atEpochMs: Date.now(),
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        durationMs: response.durationMs,
        errorKind: response.error?.kind,
        bodyJson: response.bodyJson,
    };
}

function authRecipeSnippet(username: string): string {
    return json({
        recipeId: 'rallar-auth-command-center',
        name: 'Rallar auth command-center recipe',
        continueOnFailure: true,
        commands: [
            {
                kind: 'http.request',
                commandId: 'auth-login',
                request: {
                    path: '/api/auth/login',
                    method: 'POST',
                    body: {
                        username: username || '<username>',
                        password: '<password>',
                    },
                },
                response: {
                    body: 'json',
                },
            },
            {
                kind: 'http.request',
                commandId: 'auth-ws-ticket',
                request: {
                    path: '/api/auth/ws-ticket',
                    method: 'POST',
                    body: {},
                },
                response: {
                    body: 'json',
                },
            },
            {
                kind: 'http.request',
                commandId: 'auth-missing-token-negative',
                request: {
                    path: '/api/auth/ws-ticket',
                    method: 'POST',
                    body: {},
                },
                response: {
                    body: 'json',
                },
                metadata: {
                    expectedStatus: 401,
                },
            },
        ],
    });
}

function defaultWebSocketApiUrl(apiBaseUrl: string): string {
    try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '/api/ws/{auth.sessionId}';
        url.search = 'ticket={auth.wsTicket}';
        return url.toString();
    } catch {
        return 'ws://localhost:8080/api/ws/{auth.sessionId}?ticket={auth.wsTicket}';
    }
}

function resolveWebSocketUrlTemplate(
    template: string,
    apiBaseUrl: string,
    authSession: AuthSession | undefined,
    ticket: AuthCommandCenterTicket | undefined,
): string {
    const wsBaseUrl = (() => {
        try {
            const url = new URL(apiBaseUrl);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            url.pathname = '';
            url.search = '';
            url.hash = '';
            return url.toString().replace(/\/$/, '');
        } catch {
            return 'ws://localhost:8080';
        }
    })();
    return template
        .replaceAll(
            '{auth.sessionId}',
            encodeURIComponent(
                authSession?.sessionId ?? ticket?.sessionId ?? '',
            ),
        )
        .replaceAll('{auth.wsTicket}', encodeURIComponent(ticket?.ticket ?? ''))
        .replaceAll('{config.wsBaseUrl}', wsBaseUrl);
}

function webSocketPayloadPresetText(presetId: string): string | undefined {
    const preset = WEBSOCKET_PAYLOAD_PRESETS.find(
        (entry) => entry.presetId === presetId,
    );
    return preset ? json(preset.payload) : undefined;
}

function defaultWebSocketTypeId(): string {
    return (
        webSocketPayloadPresetById(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID).values
            ?.typeId ?? 'room.manual.message'
    );
}

function defaultWebSocketTopicId(): string {
    return (
        webSocketPayloadPresetById(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID).values
            ?.topicId ?? defaultWebSocketTypeId()
    );
}

function defaultWebSocketScope(): WebSocketCommandCenterValues['wsScope'] {
    return (
        webSocketPayloadPresetById(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID).values
            ?.wsScope ?? 'room'
    );
}

function webSocketPayloadPresetById(presetId: string): WebSocketPayloadPreset {
    return (
        WEBSOCKET_PAYLOAD_PRESETS.find(
            (entry) => entry.presetId === presetId,
        ) ?? WEBSOCKET_PAYLOAD_PRESETS[0]
    );
}

function defaultWebSocketValuesFromContext(
    globalValues: CommandCenterGlobalValues | undefined,
    config: RallarBlackBoxTestConfig | undefined,
    bootstrap: RallarBlackBoxBootstrapConfig,
): Pick<
    WebSocketCommandCenterValues,
    'apiBaseUrl' | 'applicationId' | 'workspaceId' | 'groupId' | 'contextId'
> {
    const groupId =
        stringValue(globalValues?.roomId) ??
        stringValue(config?.roomId) ??
        bootstrap.roomId;
    return {
        apiBaseUrl:
            globalValues?.apiBaseUrl ??
            config?.apiBaseUrl ??
            bootstrap.apiBaseUrl,
        applicationId:
            globalValues?.applicationId ??
            stringValue(config?.rallar?.applicationId) ??
            'rallar-black-box',
        workspaceId:
            globalValues?.workspaceId ??
            stringValue(config?.rallar?.workspaceId) ??
            'default',
        groupId,
        contextId: groupId || 'all',
    };
}

function webSocketSendData(
    values: WebSocketCommandCenterValues,
    payload: unknown,
): unknown {
    const payloadRecord = optionalRecord(payload);
    const hasTypedFields = [
        'payload',
        'data',
        'typeId',
        'topicId',
        'roomId',
        'groupId',
        'scope',
        'contextId',
        'resourceId',
    ].some((key) => key in payloadRecord);
    const base = hasTypedFields ? payloadRecord : { payload };
    const wsScope =
        base.scope === 'room' || base.scope === 'all' || base.scope === 'world'
            ? base.scope
            : values.wsScope;
    const explicitGroupId =
        stringValue(base.roomId) ?? stringValue(base.groupId);
    const groupId =
        explicitGroupId ?? (wsScope === 'room' ? values.groupId : '');
    const typeId = stringValue(base.typeId) ?? values.typeId;
    const topicId = stringValue(base.topicId) ?? values.topicId ?? typeId;
    const contextId =
        stringValue(base.contextId) ?? values.contextId ?? groupId ?? wsScope;

    return {
        ...base,
        applicationId: stringValue(base.applicationId) ?? values.applicationId,
        workspaceId: stringValue(base.workspaceId) ?? values.workspaceId,
        ...(groupId ? { roomId: groupId, groupId } : {}),
        scope: wsScope,
        typeId,
        topicId,
        contextId,
        ...(values.resourceId && !('resourceId' in base)
            ? { resourceId: values.resourceId }
            : {}),
    };
}

function webSocketRoutePreview(
    input: Readonly<{
        values: WebSocketCommandCenterValues;
        diagnostics: WebSocketDiagnostic;
        providerMode: string;
        browserStatus: RallarBrowserStatusSummary;
    }>,
): WebSocketRoutePreview {
    const { values, diagnostics, providerMode, browserStatus } = input;
    const groupId = values.groupId.trim();
    const typeId = values.typeId.trim() || '-';
    const topicId = values.topicId.trim() || '*';
    const contextId = values.contextId.trim() || values.wsScope;
    const destination =
        values.wsScope === 'room'
            ? groupId
                ? `Group ${groupId}`
                : 'No group selected'
            : values.wsScope === 'all'
              ? 'All WS subscribers'
              : 'World scope';
    const destinationDetail =
        values.wsScope === 'room'
            ? groupId
                ? `Application ${values.applicationId || '-'} / workspace ${values.workspaceId || '-'}`
                : 'Room-scoped messages need a Group before send.'
            : values.wsScope === 'all'
              ? 'Group is ignored for this send.'
              : 'Uses Rallar world scope; Group is ignored.';
    const usesRallarAppWebSocket = providerMode === 'browser-rallar';
    const transport = usesRallarAppWebSocket
        ? 'Rallar app WS'
        : diagnostics.status === 'open'
          ? 'Raw WebSocket'
          : providerMode === 'simulated'
            ? 'Simulated WebSocket'
            : 'No open WS';
    const transportDetail = usesRallarAppWebSocket
        ? browserStatus.signalingLabel === 'open'
            ? `Uses open Rallar signaling for ${values.connection}`
            : `Connects Rallar signaling for ${values.connection}`
        : `Connection ${values.connection}`;

    return {
        destination,
        destinationDetail,
        selector: `${topicId} / ${typeId}`,
        selectorDetail: `Context ${contextId}`,
        transport,
        transportDetail,
        sendLabel:
            values.wsScope === 'room'
                ? groupId
                    ? `Send JSON to group ${groupId}`
                    : 'Send JSON to group'
                : values.wsScope === 'all'
                  ? 'Send JSON to all'
                  : 'Send JSON to world',
    };
}

function webSocketConfigureCommand(
    input: Readonly<{
        values: WebSocketCommandCenterValues;
        bootstrap: RallarBlackBoxBootstrapConfig;
        providerMode: string;
        authSession?: AuthSession;
        sequence: number;
    }>,
): RallarBlackBoxTestCommand {
    const browserRallar = input.providerMode === 'browser-rallar';
    const rallar = browserRallar
        ? {
              ...((input.authSession?.username ??
              input.bootstrap.rallarUsername)
                  ? {
                        username:
                            input.authSession?.username ??
                            input.bootstrap.rallarUsername,
                    }
                  : {}),
              ...(input.bootstrap.rallarPassword
                  ? { password: input.bootstrap.rallarPassword }
                  : {}),
              ...(input.authSession || input.bootstrap.rallarRestoreSession
                  ? { restoreSession: true }
                  : {}),
              ...(input.bootstrap.rallarRegister
                  ? { register: input.bootstrap.rallarRegister }
                  : {}),
              ...(input.bootstrap.rallarLogoutOnClose
                  ? { logoutOnClose: true }
                  : {}),
              leaveRoomOnClose: input.bootstrap.rallarLeaveRoomOnClose,
              applicationId: input.values.applicationId,
              workspaceId: input.values.workspaceId,
              scope: {
                  applicationId: input.values.applicationId,
                  workspaceId: input.values.workspaceId,
              },
              ...(input.values.groupId
                  ? {
                        roomRef: {
                            applicationId: input.values.applicationId,
                            workspaceId: input.values.workspaceId,
                            groupId: input.values.groupId,
                        },
                    }
                  : {}),
              typeId: input.values.typeId,
              topicId: input.values.topicId,
          }
        : undefined;

    return {
        kind: 'configure',
        commandId: `ws-configure-${input.sequence}`,
        label: 'Configure WebSocket command center',
        config: {
            runId: `websocket-command-center-${input.sequence}`,
            agentId: input.bootstrap.agentId,
            environment: input.bootstrap.environment,
            apiBaseUrl: input.values.apiBaseUrl,
            actor: input.authSession?.username ?? input.bootstrap.actor,
            sessionId:
                input.authSession?.sessionId ?? input.bootstrap.sessionId,
            roomId: input.values.groupId,
            transport: 'ws',
            ...(rallar ? { rallar } : {}),
            control: {
                mode: 'websocket-command-center',
                providerMode: input.providerMode,
                protocolVersion: 1,
                connected: false,
            },
            defaults: {
                timeoutMs: input.values.timeoutMs,
                connection: input.values.connection,
                providerMode: input.providerMode,
            },
        },
    };
}

function webSocketOpenCommand(
    values: WebSocketCommandCenterValues,
    sequence: number,
    url = values.wsUrl,
): RallarBlackBoxTestCommand {
    const protocols = values.protocols
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    return {
        kind: 'ws.open',
        commandId: `ws-open-${sequence}`,
        label: 'Open WebSocket',
        connection: values.connection,
        url,
        ...(protocols.length > 0 ? { protocols } : {}),
        timeoutMs: values.timeoutMs,
    };
}

function webSocketSendCommand(
    values: WebSocketCommandCenterValues,
    payload: unknown,
    sequence: number,
): RallarBlackBoxTestCommand {
    return {
        kind: 'ws.send',
        commandId: `ws-send-${sequence}`,
        label: 'Send WebSocket JSON',
        connection: values.connection,
        data: webSocketSendData(values, payload),
        timeoutMs: values.timeoutMs,
    };
}

function webSocketCloseCommand(
    values: WebSocketCommandCenterValues,
    sequence: number,
    reason = values.closeReason,
): RallarBlackBoxTestCommand {
    return {
        kind: 'ws.close',
        commandId: `ws-close-${sequence}`,
        label: 'Close WebSocket',
        connection: values.connection,
        code: Number.isFinite(values.closeCode) ? values.closeCode : 1000,
        reason,
        timeoutMs: values.timeoutMs,
    };
}

function webSocketCommandCenterRecipe(
    input: Readonly<{
        values: WebSocketCommandCenterValues;
        payload: unknown;
        bootstrap: RallarBlackBoxBootstrapConfig;
        providerMode: string;
        authSession?: AuthSession;
        sequence: number;
        includeRtcParity?: boolean;
    }>,
): string {
    const commands: RallarBlackBoxTestCommand[] = [
        webSocketConfigureCommand(input),
        webSocketOpenCommand(input.values, input.sequence + 1),
        webSocketSendCommand(input.values, input.payload, input.sequence + 2),
    ];
    if (input.includeRtcParity) {
        commands.push(
            {
                kind: 'rtc.connect',
                commandId: `ws-rtc-parity-connect-${input.sequence + 3}`,
                label: 'Connect RTC comparison client',
                connection: `${input.values.connection}-rtc`,
                actor: input.authSession?.username ?? input.bootstrap.actor,
                roomId: input.bootstrap.roomId,
                transport: 'realtime',
                timeoutMs: input.values.timeoutMs,
                rallar: {
                    sessionId:
                        input.authSession?.sessionId ??
                        input.bootstrap.sessionId,
                },
            },
            {
                kind: 'rtc.send',
                commandId: `ws-rtc-parity-send-${input.sequence + 4}`,
                label: 'Send RTC comparison JSON',
                connection: `${input.values.connection}-rtc`,
                transport: 'realtime',
                send: input.payload,
                timeoutMs: input.values.timeoutMs,
            },
        );
    }
    commands.push(
        webSocketCloseCommand(
            input.values,
            input.sequence + commands.length + 1,
        ),
    );

    return json({
        recipeId: input.includeRtcParity
            ? 'rallar-websocket-rtc-parity-command-center'
            : 'rallar-websocket-command-center',
        name: input.includeRtcParity
            ? 'Rallar WebSocket and RTC comparison command-center recipe'
            : 'Rallar WebSocket command-center recipe',
        continueOnFailure: false,
        commands: redactRallarBlackBoxValue(commands, {
            secretValues: uiSecretValues(undefined, input.authSession, [
                input.bootstrap.rallarPassword,
            ]),
        }),
    });
}

function deriveWebSocketDiagnostics(
    state: RallarBlackBoxTestState,
    connection: string,
): WebSocketDiagnostic {
    const history = selectRallarBlackBoxCommandHistory(state);
    const events = selectRallarBlackBoxEvents(state)
        .filter((event) => event.transport === 'ws')
        .filter(
            (event) =>
                !connection ||
                !event.connection ||
                event.connection === connection,
        );
    const recentEvents = events.slice(-16).map((event) => ({
        eventId: event.eventId,
        kind: event.kind,
        topic: event.topic,
        atEpochMs: event.atEpochMs,
        severity: event.severity ?? 'info',
        payload: event.payload,
    }));
    const receivedMessages = events
        .filter((event) => event.kind === 'message')
        .slice(-16)
        .map((event) => {
            const payload = optionalRecord(event.payload);
            const data = payload.data;
            const dataRecord = optionalRecord(data);
            const messagePayload =
                'payload' in dataRecord
                    ? dataRecord.payload
                    : (data ?? event.payload);
            return {
                eventId: event.eventId,
                atEpochMs: event.atEpochMs,
                senderId: String(
                    payload.senderId ?? dataRecord.senderId ?? '-',
                ),
                roomId: String(
                    payload.roomId ??
                        dataRecord.roomId ??
                        dataRecord.groupId ??
                        '-',
                ),
                typeId: String(payload.typeId ?? dataRecord.typeId ?? '-'),
                topicId: String(payload.topicId ?? dataRecord.topicId ?? '-'),
                contextId: String(
                    payload.contextId ?? dataRecord.contextId ?? '-',
                ),
                resourceId: String(
                    payload.resourceId ?? dataRecord.resourceId ?? '-',
                ),
                payload: messagePayload,
            };
        });
    const openEvents = events.filter(
        (event) =>
            event.topic.includes('ws.opened') ||
            event.topic.includes('ws.open_skipped'),
    );
    const closeEvents = events.filter((event) =>
        event.topic.includes('ws.closed'),
    );
    const errorEvents = events.filter(
        (event) =>
            event.severity === 'error' || event.topic.includes('ws.error'),
    );
    const lastOpen = openEvents.at(-1);
    const lastClose = closeEvents.at(-1);
    const lastError = errorEvents.at(-1);
    const openedAfterClose = Boolean(
        lastOpen && (!lastClose || lastOpen.atEpochMs >= lastClose.atEpochMs),
    );
    const closedAfterOpen = Boolean(
        lastClose && (!lastOpen || lastClose.atEpochMs >= lastOpen.atEpochMs),
    );
    const simulated = Boolean(lastOpen?.topic.includes('open_skipped'));
    const status =
        lastError && (!lastClose || lastError.atEpochMs >= lastClose.atEpochMs)
            ? 'error'
            : simulated
              ? 'simulated'
              : openedAfterClose
                ? 'open'
                : closedAfterOpen
                  ? 'closed'
                  : 'idle';
    const statusLabel = status === 'simulated' ? 'simulated' : status;
    const openPayload = optionalRecord(lastOpen?.payload);
    const closePayload = optionalRecord(lastClose?.payload);
    const failedWsResults = history.filter(
        (result) =>
            (result.kind === 'ws.open' ||
                result.kind === 'ws.send' ||
                result.kind === 'ws.close') &&
            !result.ok,
    );
    const outboundCount = history.filter(
        (result) =>
            result.kind === 'ws.send' &&
            (optionalRecord(result.value).connection === connection ||
                connection.length === 0),
    ).length;

    return {
        readyState: String(
            openPayload.readyState ?? (status === 'open' ? 'open' : status),
        ),
        status,
        statusLabel,
        lastOpenAtEpochMs: lastOpen?.atEpochMs,
        lastCloseAtEpochMs: lastClose?.atEpochMs,
        closeCode: closePayload.code,
        closeReason: closePayload.reason,
        inboundCount: events.filter((event) => event.kind === 'message').length,
        outboundCount,
        errorCount: errorEvents.length + failedWsResults.length,
        recentEvents,
        receivedMessages,
    };
}

function parseRallarServerCollectionText(
    text: string,
): RallarServerRestCollection {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Collection JSON must be an object.');
    }
    const collection = value as RallarServerRestCollection;
    if (
        !collection.collectionId ||
        !collection.name ||
        !Array.isArray(collection.steps)
    ) {
        throw new Error(
            'Collection JSON requires collectionId, name, and steps.',
        );
    }
    return collection;
}

function parseRallarServerCollectionVariablesText(
    text: string,
): RallarServerRestCollectionVariables {
    const value = JSON.parse(text || '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Collection variables must be a JSON object.');
    }
    return value as RallarServerRestCollectionVariables;
}

function deriveQueue(
    state: RallarBlackBoxTestState,
): readonly CommandQueueRow[] {
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const resultCache = state.resultCache;
    return (state.loadedRecipe?.commands ?? []).map((command, index) => {
        const id = commandId(command, index);
        const result = resultCache[id];
        const isActive = activeCommand?.commandId === id;
        return {
            id,
            kind: command.kind,
            label: command.label ?? command.kind,
            timeoutMs: command.timeoutMs,
            status: isActive
                ? 'running'
                : result
                  ? result.ok
                      ? 'completed'
                      : 'failed'
                  : 'pending',
        };
    });
}

function findSelectedResult(
    history: readonly RallarBlackBoxTestResult[],
    selectedCommandId: string | undefined,
): RallarBlackBoxTestResult | undefined {
    if (!selectedCommandId) {
        return history.at(-1);
    }

    return (
        history.find((result) => result.commandId === selectedCommandId) ??
        history.at(-1)
    );
}

function commandCenterGlobalValuesFromState(
    state: RallarBlackBoxTestState,
    bootstrap: RallarBlackBoxBootstrapConfig,
    authSession?: AuthSession,
): CommandCenterGlobalValues {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const configRallar = optionalRecord(config?.rallar);
    return {
        apiBaseUrl: config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        applicationId:
            stringValue(
                config?.defaults?.applicationId ?? configRallar.applicationId,
            ) ?? DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId:
            stringValue(
                config?.defaults?.workspaceId ?? configRallar.workspaceId,
            ) ?? DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        clientId:
            authSession?.clientId ??
            authSession?.username ??
            config?.actor ??
            bootstrap.actor,
        sessionId:
            authSession?.sessionId ?? config?.sessionId ?? bootstrap.sessionId,
        roomId: config?.roomId ?? bootstrap.roomId,
    };
}

function sameCommandCenterGlobalValues(
    left: CommandCenterGlobalValues,
    right: CommandCenterGlobalValues,
): boolean {
    return (
        left.apiBaseUrl === right.apiBaseUrl &&
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.clientId === right.clientId &&
        left.sessionId === right.sessionId &&
        left.roomId === right.roomId
    );
}

function bootstrapPatchFromGlobalValues(
    values: CommandCenterGlobalValues,
): Partial<RallarBlackBoxBootstrapConfig> {
    return {
        apiBaseUrl: values.apiBaseUrl,
        actor: values.clientId,
        sessionId: values.sessionId,
        roomId: values.roomId,
    };
}


function stageTone(status: RtcConnectStageStatus): string {
    if (status === 'observed') return 'good';
    if (status === 'failed') return 'bad';
    if (status === 'warning') return 'warn';
    return 'muted';
}

function formatList(values: readonly string[]): string {
    return values.length > 0 ? values.join(', ') : '-';
}

function topologyFilterLabel(filter: RallarTopologyFilter): string {
    return filter === 'all' ? 'All' : filter;
}

function readCurrentAuthSession(): AuthSession | undefined {
    try {
        return readSession();
    } catch {
        return undefined;
    }
}

function scrubAgentSessionTicketFromUrl(): void {
    if (typeof window === 'undefined') {
        return;
    }

    const hashParams = new URLSearchParams(
        window.location.hash.startsWith('#')
            ? window.location.hash.slice(1)
            : window.location.hash,
    );
    if (!hashParams.has('agentSessionTicket')) {
        return;
    }

    hashParams.delete('agentSessionTicket');
    const nextUrl = new URL(window.location.href);
    nextUrl.hash = hashParams.toString();
    window.history.replaceState(null, document.title, nextUrl.toString());
}

let pendingAgentSessionTicketConsume: Readonly<{
    ticket: string;
    promise: Promise<AuthSession>;
}> | undefined;

function consumeBootstrapAgentSessionTicket(
    ticket: string,
    apiBaseUrl: string,
): Promise<AuthSession> {
    if (pendingAgentSessionTicketConsume?.ticket === ticket) {
        return pendingAgentSessionTicketConsume.promise;
    }

    configureApiClient({ apiBaseUrl });
    const promise = consumeAgentSessionTicket({ ticket })
        .finally(() => {
            if (pendingAgentSessionTicketConsume?.ticket === ticket) {
                pendingAgentSessionTicketConsume = undefined;
            }
        });
    pendingAgentSessionTicketConsume = { ticket, promise };
    return promise;
}

function LoginScreen({
    bootstrap,
    onAuthenticated,
}: {
    bootstrap: RallarBlackBoxBootstrapConfig;
    onAuthenticated(session: AuthSession): void;
}) {
    const [apiBaseUrl, setApiBaseUrl] = useState(bootstrap.apiBaseUrl);
    const [username, setUsername] = useState(
        bootstrap.rallarUsername ?? bootstrap.actor,
    );
    const [password, setPassword] = useState(bootstrap.rallarPassword ?? '');
    const [register, setRegister] = useState(Boolean(bootstrap.rallarRegister));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);

        try {
            const session = await authenticateRallarBlackBox(
                await loadBrowserRallarFacade(),
                {
                    apiBaseUrl,
                    username,
                    password,
                    register,
                },
            );
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(session, apiBaseUrl),
            );
            onAuthenticated(session);
        } catch (authError) {
            setError(authErrorMessage(authError));
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="auth-shell">
            <section className="auth-panel">
                <div className="auth-heading">
                    <p className="eyebrow">Rallar Kit</p>
                    <h1>Rallar Server Login</h1>
                    <span className="pill active">
                        {bootstrap.providerMode}
                    </span>
                </div>
                <form
                    className="auth-form"
                    onSubmit={(event) => void submit(event)}
                >
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) =>
                                setApiBaseUrl(event.target.value)
                            }
                            disabled={busy}
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Username</span>
                        <input
                            value={username}
                            onChange={(event) =>
                                setUsername(event.target.value)
                            }
                            disabled={busy}
                            autoCapitalize="none"
                            autoComplete="username"
                            autoCorrect="off"
                            spellCheck={false}
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(event) =>
                                setPassword(event.target.value)
                            }
                            disabled={busy}
                            autoComplete="current-password"
                            required
                        />
                    </label>
                    <label className="check-field">
                        <input
                            type="checkbox"
                            checked={register}
                            onChange={(event) =>
                                setRegister(event.target.checked)
                            }
                            disabled={busy}
                        />
                        <span>Register before login</span>
                    </label>
                    <button
                        type="submit"
                        disabled={busy || !apiBaseUrl || !username || !password}
                    >
                        {busy ? 'Signing in' : 'Sign in'}
                    </button>
                </form>
                <dl className="auth-summary">
                    <div>
                        <dt>Room</dt>
                        <dd>{bootstrap.roomId}</dd>
                    </div>
                    <div>
                        <dt>Transport</dt>
                        <dd>{bootstrap.transport}</dd>
                    </div>
                    <div>
                        <dt>Source</dt>
                        <dd>{bootstrap.source}</dd>
                    </div>
                </dl>
                {error && (
                    <div className="workbench-error" role="status">
                        {error}
                    </div>
                )}
            </section>
        </main>
    );
}

function Header({
    mode,
    state,
    control,
    bootstrap,
    globalValues,
    browserStatus,
    bootstrapping,
    lastAction,
    authSession,
    authBusy,
    onLogout,
}: {
    mode: AppModeId;
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
    bootstrap: RallarBlackBoxBootstrapConfig;
    globalValues: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
    bootstrapping: boolean;
    lastAction?: string;
    authSession?: AuthSession;
    authBusy: boolean;
    onLogout(): void;
}) {
    const [detailsExpanded, setDetailsExpanded] = useState(false);
    const config = selectRallarBlackBoxCurrentConfig(state);
    const stats = selectRallarBlackBoxLatestStats(state);
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const firstFailure = selectRallarBlackBoxFirstFailure(state);
    const providerMode = config
        ? rallarBlackBoxProviderModeFromConfig(config)
        : bootstrap.providerMode;
    const rallarValue =
        providerMode === 'simulated'
            ? 'simulated'
            : browserStatus.rallarConnected || stats?.rallar?.connected
              ? 'connected'
              : 'not connected';
    const effectiveRoom =
        globalValues.roomId ||
        config?.roomId ||
        bootstrap.roomId ||
        'not joined';
    const effectiveUser =
        authSession?.username ??
        authSession?.clientId ??
        globalValues.clientId ??
        config?.actor ??
        bootstrap.actor ??
        'none';
    const effectiveSession =
        authSession?.sessionId ??
        globalValues.sessionId ??
        config?.sessionId ??
        bootstrap.sessionId ??
        'none';

    return (
        <header
            className={`run-header ${detailsExpanded ? 'expanded' : 'collapsed'}`}
        >
            <div className="run-title">
                <p className="eyebrow">Rallar Kit</p>
                <h1>{config?.runId ?? bootstrap.runId ?? 'No run loaded'}</h1>
                <button
                    type="button"
                    className="header-toggle"
                    aria-expanded={detailsExpanded}
                    aria-controls="run-header-details run-header-actions"
                    onClick={() => setDetailsExpanded((current) => !current)}
                >
                    {detailsExpanded ? 'Hide details' : 'Show details'}
                </button>
            </div>
            <div
                className="header-grid header-grid--summary"
                aria-label="Run state"
            >
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={providerMode === 'simulated' ? 'warn' : 'active'}
                />
                <Metric
                    label="Control"
                    value={control.state}
                    tone={statusTone(control.state)}
                />
                <Metric
                    label="Rallar"
                    value={rallarValue}
                    tone={
                        browserStatus.rallarConnected ||
                        stats?.rallar?.connected
                            ? 'good'
                            : providerMode === 'simulated'
                              ? 'warn'
                              : 'muted'
                    }
                />
                <Metric label="Room" value={effectiveRoom} />
                <Metric
                    label="Failure"
                    value={firstFailure?.commandId ?? 'none'}
                    tone={firstFailure ? 'bad' : 'good'}
                />
            </div>
            <div
                className="header-actions"
                id="run-header-actions"
                hidden={!detailsExpanded}
            >
                <span className={`pill ${bootstrapping ? 'active' : 'good'}`}>
                    {bootstrapping ? 'running' : 'ready'}
                </span>
                <span className="last-action">
                    {lastAction ?? 'Waiting for runtime events'}
                </span>
                {mode === 'black-box-runner' && (
                    <button
                    type="button"
                    onClick={() =>
                        void rallarBlackBoxRuntimeStore.runSample()
                        }
                        disabled={
                            bootstrapping || providerMode === 'browser-rallar'
                        }
                    >
                        Replay Sample
                    </button>
                )}
                {authSession && (
                    <button
                        type="button"
                        className="header-logout-button"
                        onClick={onLogout}
                        disabled={authBusy}
                    >
                    {authBusy ? 'Signing out' : 'Logout'}
                    </button>
                )}
            </div>
            <div
                className="header-grid header-grid--details"
                id="run-header-details"
                aria-label="Run details"
                hidden={!detailsExpanded}
            >
                <Metric
                    label="Agent"
                    value={config?.agentId ?? bootstrap.agentId ?? 'unassigned'}
                />
                <Metric label="Protocol" value="1" />
                <Metric
                    label="Runtime"
                    value={state.status}
                    tone={statusTone(state.status)}
                />
                <Metric
                    label="Signal WS"
                    value={browserStatus.signalingLabel}
                    tone={browserStatus.signalingTone}
                />
                <Metric
                    label="RTC"
                    value={browserStatus.rtcLabel}
                    tone={browserStatus.rtcTone}
                />
                <Metric
                    label="Environment"
                    value={
                        config?.environment ?? bootstrap.environment ?? 'local'
                    }
                />
                <Metric label="User" value={effectiveUser} />
                <Metric label="Session" value={effectiveSession} />
                <Metric
                    label="Active"
                    value={activeCommand?.commandId ?? 'none'}
                    tone={activeCommand ? 'active' : 'muted'}
                />
            </div>
        </header>
    );
}

function AppTabs({
    activeMode,
    activeTab,
    onSelect,
}: {
    activeMode: AppModeId;
    activeTab: AppTabId;
    onSelect(tab: AppTabId): void;
}) {
    const handleKeyDown = (
        event: KeyboardEvent<HTMLButtonElement>,
        tab: AppTabId,
    ): void => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
            return;
        }

        event.preventDefault();
        onSelect(
            nextAppTab(tab, event.key === 'ArrowRight' ? 1 : -1, activeMode),
        );
    };
    const tabs = appTabsForMode(activeMode);
    const activeModeLabel =
        APP_MODES.find((mode) => mode.id === activeMode)?.label ?? 'Workspace';

    return (
        <nav className="app-tabs" aria-label="Rallar black-box sections">
            <div role="tablist" aria-label={`${activeModeLabel} tabs`}>
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        id={`tab-${tab.id}`}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        aria-controls={`panel-${tab.id}`}
                        className={activeTab === tab.id ? 'selected' : ''}
                        tabIndex={activeTab === tab.id ? 0 : -1}
                        onClick={() => onSelect(tab.id)}
                        onKeyDown={(event) => handleKeyDown(event, tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
        </nav>
    );
}

function GlobalContextBar({
    values,
    authSession,
    onChange,
    onReset,
}: {
    values: CommandCenterGlobalValues;
    authSession?: AuthSession;
    onChange<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
    onReset(): void;
}) {
    const [mobileExpanded, setMobileExpanded] = useState(false);

    return (
        <section
            className={`global-context-bar ${mobileExpanded ? 'expanded' : 'collapsed'}`}
            aria-label="Global command context"
        >
            <div className="global-context-heading">
                <h2>Global Context</h2>
                <span className={`pill ${authSession ? 'good' : 'muted'}`}>
                    {authSession ? 'login synced' : 'editable defaults'}
                </span>
                <button
                    type="button"
                    className="global-context-toggle"
                    aria-expanded={mobileExpanded}
                    aria-controls="global-context-fields"
                    onClick={() => setMobileExpanded((current) => !current)}
                >
                    {mobileExpanded ? 'Hide values' : 'Show values'}
                </button>
                <button
                    type="button"
                    className="global-context-reset"
                    onClick={onReset}
                >
                    Use login/context
                </button>
            </div>
            <div className="global-context-grid" id="global-context-fields">
                <label className="field">
                    <span>API Base URL</span>
                    <input
                        aria-label="Global Server URL"
                        value={values.apiBaseUrl}
                        onChange={(event) =>
                            onChange('apiBaseUrl', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Application</span>
                    <input
                        aria-label="Global Application"
                        value={values.applicationId}
                        onChange={(event) =>
                            onChange('applicationId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Workspace</span>
                    <input
                        aria-label="Global Workspace"
                        value={values.workspaceId}
                        onChange={(event) =>
                            onChange('workspaceId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Room / Group</span>
                    <input
                        aria-label="Global Room"
                        value={values.roomId}
                        onChange={(event) =>
                            onChange('roomId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Client</span>
                    <input
                        aria-label="Global Client"
                        value={values.clientId}
                        onChange={(event) =>
                            onChange('clientId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Session</span>
                    <input
                        aria-label="Global Session"
                        value={values.sessionId}
                        onChange={(event) =>
                            onChange('sessionId', event.target.value)
                        }
                    />
                </label>
            </div>
        </section>
    );
}

function AppModeSwitch({
    activeMode,
    onSelect,
}: {
    activeMode: AppModeId;
    onSelect(mode: AppModeId): void;
}) {
    return (
        <section className="app-mode-switch" aria-label="Rallar workspace mode">
            <div className="app-mode-copy">
                <h2>Workspace Mode</h2>
                <p>
                    Choose direct live Rallar operations or black-box-runner
                    recipes, control runs, and artifacts.
                </p>
            </div>
            <div className="app-mode-options">
                {APP_MODES.map((mode) => (
                    <button
                        key={mode.id}
                        type="button"
                        aria-pressed={activeMode === mode.id}
                        className={activeMode === mode.id ? 'selected' : ''}
                        onClick={() => onSelect(mode.id)}
                    >
                        <strong>{mode.label}</strong>
                        <span>{mode.description}</span>
                    </button>
                ))}
            </div>
        </section>
    );
}

function DirectRallarBoundaryPanel({
    state,
    bootstrap,
    globalValues,
    authSession,
    onOpenAuth,
    onOpenRunnerMode,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    globalValues: CommandCenterGlobalValues;
    authSession?: AuthSession;
    onOpenAuth(): void;
    onOpenRunnerMode(): void;
}) {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<
        DirectRallarOperationResult | undefined
    >();
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const canRun = realBackendReady && Boolean(authSession) && !busy;
    const resultValue = optionalRecord(result?.value);
    const resultError = result?.error;
    const [expanded, setExpanded] = useState(true);

    const runStatusCheck = async (): Promise<void> => {
        setBusy(true);
        try {
            const nextResult = await runDirectRallarStatusCheck(
                {
                    providerMode,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    roomId: globalValues.roomId,
                    actor: authSession?.username ?? bootstrap.actor,
                    authSession,
                    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
                },
                loadBrowserRallarFacade,
            );
            nextResult.events.forEach((event) => {
                rallarBlackBoxRuntimeStore.recordRuntimeEvent(event);
            });
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                {
                    kind: 'state',
                    topic: `rallar.direct.status.${nextResult.status}`,
                    severity: nextResult.status === 'failed' ? 'error' : 'info',
                    actor: authSession?.username ?? bootstrap.actor,
                    payload: {
                        status: nextResult.status,
                        durationMs: nextResult.durationMs,
                        error: nextResult.error,
                    },
                },
                nextResult.status === 'failed'
                    ? 'Direct Rallar status check failed'
                    : 'Direct Rallar status check completed',
            );
            setResult(nextResult);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section
            className={`panel direct-rallar-boundary-panel ${expanded ? 'expanded' : 'collapsed'}`}
            aria-label="Direct Rallar operation boundary"
        >
            <div className="panel-heading">
                <h2>Direct Rallar Operations</h2>
                <span className={`pill ${realBackendReady ? 'good' : 'warn'}`}>
                    {realBackendReady
                        ? 'real backend'
                        : 'real backend required'}
                </span>
                <button
                    type="button"
                    className="collapsible-toggle"
                    aria-expanded={expanded}
                    aria-controls="direct-rallar-boundary-content"
                    aria-label={`${expanded ? 'Hide' : 'Show'} Direct Rallar Operations`}
                    onClick={() => setExpanded((current) => !current)}
                >
                    {expanded ? 'Hide' : 'Show'}
                </button>
            </div>
            <div
                id="direct-rallar-boundary-content"
                className="direct-rallar-content"
                hidden={!expanded}
            >
                <div className="direct-rallar-grid">
                    <Metric
                        label="Provider"
                        value={providerMode}
                        tone={realBackendReady ? 'good' : 'warn'}
                    />
                    <Metric label="API" value={globalValues.apiBaseUrl} />
                    <Metric
                        label="Session"
                        value={authSession?.sessionId ?? 'not logged in'}
                        tone={authSession ? 'good' : 'warn'}
                    />
                    <Metric
                        label="Direct status"
                        value={result?.status ?? 'not checked'}
                        tone={
                            result?.status === 'failed'
                                ? 'bad'
                                : result?.status === 'completed'
                                  ? 'good'
                                  : 'muted'
                        }
                    />
                    <Metric
                        label="Connected"
                        value={String(resultValue.connected ?? '-')}
                        tone={resultValue.connected ? 'good' : 'muted'}
                    />
                    <Metric
                        label="Duration"
                        value={formatDuration(result?.durationMs)}
                    />
                </div>
                <div className="direct-rallar-actions">
                    <button
                        type="button"
                        disabled={!canRun}
                        onClick={() => void runStatusCheck()}
                        className={canRun ? 'primary-action' : 'blocked-action'}
                    >
                        {busy
                            ? 'Checking Direct Rallar'
                            : 'Check Direct Rallar'}
                    </button>
                    {!realBackendReady && (
                        <button
                            type="button"
                            className="secondary-action"
                            onClick={onOpenRunnerMode}
                        >
                            Open runner mode
                        </button>
                    )}
                    {realBackendReady && !authSession && (
                        <button
                            type="button"
                            className="secondary-action"
                            onClick={onOpenAuth}
                        >
                            Open Auth
                        </button>
                    )}
                </div>
                {!realBackendReady && (
                    <div className="command-center-status" role="status">
                        Simulated provider cannot run direct facade actions.
                        Use runner mode for local recipes and artifacts.
                    </div>
                )}
                {realBackendReady && !authSession && (
                    <div className="command-center-status" role="status">
                        Direct facade actions need a logged-in browser session.
                    </div>
                )}
                {resultError && (
                    <div className="workbench-error" role="status">
                        {resultError.message}
                    </div>
                )}
                {result && (
                    <pre className="mini-json">
                        {redactedJson(
                            {
                                status: result.status,
                                value: result.value,
                                error: result.error,
                            },
                            state,
                            authSession,
                        )}
                    </pre>
                )}
            </div>
        </section>
    );
}

function RunnerModeBoundaryPanel({
    control,
}: {
    control: RallarBlackBoxControlSnapshot;
}) {
    return (
        <section
            className="panel runner-mode-boundary-panel"
            aria-label="Runner mode boundary"
        >
            <div className="panel-heading">
                <h2>Runner Workspace</h2>
                <span className="pill active">recipes and artifacts</span>
            </div>
            <div className="direct-rallar-grid">
                <Metric label="Control" value={control.state} />
                <Metric label="Mode" value="black-box-runner" />
                <Metric label="Direct facade" value="not used" tone="muted" />
                <Metric
                    label="Primary tabs"
                    value="Shared Test / Local Workbench / Flow Builder / Run Manager"
                />
            </div>
        </section>
    );
}

function QuickRallarTestPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    browserStatus,
    onGlobalValueChange,
    onOpenAuth,
    onOpenRunnerMode,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
    onOpenAuth(): void;
    onOpenRunnerMode(): void;
}) {
    const [values, setValues] = useState<QuickRallarValues>(() => ({
        ...QUICK_RALLAR_DEFAULT_VALUES,
        contextId: globalValues.roomId || 'room',
    }));
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [lastResult, setLastResult] = useState<
        DirectRallarOperationResult | undefined
    >();
    const [subscription, setSubscription] = useState<
        QuickRallarSubscriptionState | undefined
    >();
    const [receivedMessages, setReceivedMessages] = useState<
        readonly QuickRallarReceivedMessageRow[]
    >([]);
    const [waitStatus, setWaitStatus] = useState('idle');
    const subscriptionRef = useRef<QuickRallarSubscriptionState | undefined>(
        undefined,
    );
    const receivedCountRef = useRef(0);
    const previousGlobalGroupRef = useRef(globalValues.roomId);
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const canUseDirectRallar =
        realBackendReady && Boolean(authSession) && !busyAction;
    const activeGroupId = globalValues.roomId.trim();
    const activeTypeId = values.typeId.trim();
    const activeTopicId = values.topicId.trim() || activeTypeId;
    const activeContextId = values.contextId.trim() || activeGroupId || 'room';
    const selectorLabel = `${activeTopicId || '*'} / ${activeTypeId || '-'}`;
    const payloadResult = useMemo(() => {
        try {
            return {
                ok: true as const,
                value: JSON.parse(values.payloadText) as unknown,
            };
        } catch (error) {
            return {
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }, [values.payloadText]);

    useEffect(() => {
        subscriptionRef.current = subscription;
    }, [subscription]);

    useEffect(() => {
        receivedCountRef.current = receivedMessages.length;
    }, [receivedMessages.length]);

    useEffect(
        () => () => {
            subscriptionRef.current?.unsubscribe();
        },
        [],
    );

    useEffect(() => {
        const previousGroup = previousGlobalGroupRef.current;
        previousGlobalGroupRef.current = globalValues.roomId;
        setValues((current) => {
            if (current.contextId && current.contextId !== previousGroup) {
                return current;
            }

            return {
                ...current,
                contextId: globalValues.roomId || 'room',
            };
        });
    }, [globalValues.roomId]);

    const operationContext = (): Parameters<
        typeof runDirectRallarStatusCheck
    >[0] => ({
        providerMode,
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        roomId: activeGroupId,
        actor:
            authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: 'quick-test',
        authSession,
        timeoutMs: values.timeoutMs,
    });

    const updateValue = <K extends keyof QuickRallarValues>(
        key: K,
        value: QuickRallarValues[K],
    ): void => {
        setValues((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const updateGroupId = (groupId: string): void => {
        const previousGroupId = globalValues.roomId;
        onGlobalValueChange('roomId', groupId);
        setValues((current) => ({
            ...current,
            contextId:
                !current.contextId || current.contextId === previousGroupId
                    ? groupId || 'room'
                    : current.contextId,
        }));
    };

    const recordDirectResult = (
        result: DirectRallarOperationResult,
        completedAction: string,
        failedAction: string,
    ): void => {
        result.events.forEach((event) => {
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(event);
        });
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            {
                kind: 'state',
                topic: `rallar.direct.quick.${result.kind}.${result.status}`,
                transport: result.kind.startsWith('ws.') ? 'ws' : undefined,
                severity: result.status === 'failed' ? 'error' : 'info',
                actor:
                    authSession?.username ??
                    authSession?.clientId ??
                    bootstrap.actor,
                payload: {
                    status: result.status,
                    durationMs: result.durationMs,
                    groupId: activeGroupId,
                    selector: {
                        typeId: activeTypeId,
                        topicId: activeTopicId,
                        contextId: activeContextId,
                    },
                    error: result.error,
                },
            },
            result.status === 'failed' ? failedAction : completedAction,
        );
        setLastResult(result);
        if (result.status === 'failed') {
            setLocalError(result.error?.message ?? failedAction);
        }
    };

    const runOperation = async (
        busyLabel: string,
        action: () => Promise<DirectRallarOperationResult>,
        completedAction: string,
        failedAction: string,
        onCompleted?: (result: DirectRallarOperationResult) => void,
    ): Promise<void> => {
        setBusyAction(busyLabel);
        setLocalError(undefined);
        try {
            const result = await action();
            recordDirectResult(result, completedAction, failedAction);
            if (result.status === 'completed') {
                onCompleted?.(result);
            }
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const createGroup = (): Promise<void> =>
        runOperation(
            'Create and join group',
            () =>
                runDirectRallarGroupCreate(
                    operationContext(),
                    loadBrowserRallarFacade,
                ),
            'Quick Test group created and joined',
            'Quick Test group create failed',
            (result) => {
                const groupId = stringValue(
                    optionalRecord(result.value).groupId,
                );
                if (groupId) {
                    updateGroupId(groupId);
                }
            },
        );

    const joinGroup = (): Promise<void> =>
        runOperation(
            'Join group',
            () =>
                runDirectRallarGroupJoin(
                    operationContext(),
                    loadBrowserRallarFacade,
                ),
            'Quick Test group joined',
            'Quick Test group join failed',
        );

    const messageRowFromRallarMessage = (
        message: Record<string, unknown>,
    ): QuickRallarReceivedMessageRow => {
        const nestedMessage = optionalRecord(message.message);
        const payload =
            'payload' in message
                ? message.payload
                : 'payload' in nestedMessage
                  ? nestedMessage.payload
                  : message;
        return {
            rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            atEpochMs: optionalNumber(message.receivedAtEpochMs) ?? Date.now(),
            transport: 'ws',
            senderId: String(message.senderId ?? nestedMessage.senderId ?? '-'),
            roomId: String(
                message.roomId ??
                    message.groupId ??
                    nestedMessage.roomId ??
                    activeGroupId ??
                    '-',
            ),
            typeId: String(
                message.typeId ?? nestedMessage.typeId ?? activeTypeId ?? '-',
            ),
            topicId: String(
                message.topicId ??
                    nestedMessage.topicId ??
                    activeTopicId ??
                    '-',
            ),
            contextId: String(
                message.contextId ??
                    nestedMessage.contextId ??
                    activeContextId ??
                    '-',
            ),
            resourceId: String(
                message.resourceId ?? nestedMessage.resourceId ?? '-',
            ),
            payload,
            raw: message,
        };
    };

    const subscribeWs = async (): Promise<void> => {
        if (!activeTypeId) {
            setLocalError('WS subscribe requires a Type ID.');
            return;
        }
        if (!activeGroupId) {
            setLocalError('WS subscribe requires a group.');
            return;
        }
        setBusyAction('Subscribe WS');
        setLocalError(undefined);
        subscriptionRef.current?.unsubscribe();
        setSubscription(undefined);
        const context = operationContext();
        const selector = {
            typeId: activeTypeId,
            ...(activeTopicId ? { topicId: activeTopicId } : {}),
        };
        try {
            const result = await runDirectRallarWsSubscribe(
                context,
                selector,
                (message) => {
                    const row = messageRowFromRallarMessage(message);
                    setReceivedMessages((current) =>
                        [...current, row].slice(-50),
                    );
                    rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                        createDirectRallarRuntimeEvent({
                            kind: 'message',
                            topic: 'rallar.direct.ws.message',
                            context,
                            transport: 'ws',
                            payload: {
                                senderId: row.senderId,
                                roomId: row.roomId,
                                typeId: row.typeId,
                                topicId: row.topicId,
                                contextId: row.contextId,
                                resourceId: row.resourceId,
                                payload: row.payload,
                                raw: row.raw,
                            },
                        }),
                        'Quick Test WS message received',
                    );
                },
                loadBrowserRallarFacade,
            );
            recordDirectResult(
                result,
                'Quick Test WS subscribed',
                'Quick Test WS subscribe failed',
            );
            if (result.status === 'completed' && result.unsubscribe) {
                setSubscription({
                    transport: 'ws',
                    label: selectorLabel,
                    groupId: activeGroupId,
                    subscribedAtEpochMs: Date.now(),
                    unsubscribe: result.unsubscribe,
                });
                setWaitStatus('subscribed');
            }
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const unsubscribeWs = (): void => {
        subscriptionRef.current?.unsubscribe();
        setSubscription(undefined);
        setWaitStatus('unsubscribed');
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic: 'rallar.direct.ws.unsubscribe.completed',
                context: operationContext(),
                transport: 'ws',
                payload: {
                    groupId: activeGroupId,
                    selector: selectorLabel,
                },
            }),
            'Quick Test WS unsubscribed',
        );
    };

    const sendWs = (): Promise<void> => {
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            return Promise.resolve();
        }
        if (!activeGroupId) {
            setLocalError('WS send requires a group.');
            return Promise.resolve();
        }
        return runOperation(
            'Send WS JSON',
            () =>
                runDirectRallarWsSend(
                    operationContext(),
                    {
                        scope: 'room',
                        typeId: activeTypeId,
                        topicId: activeTopicId,
                        contextId: activeContextId,
                        resourceId: values.resourceId.trim() || undefined,
                        payload: payloadResult.value,
                    },
                    loadBrowserRallarFacade,
                ),
            'Quick Test WS JSON sent',
            'Quick Test WS send failed',
        );
    };

    const waitForReceive = async (): Promise<void> => {
        const startCount = receivedCountRef.current;
        const startedAt = Date.now();
        setWaitStatus('waiting');
        setBusyAction('Wait for receive');
        setLocalError(undefined);
        try {
            await new Promise<void>((resolve, reject) => {
                const interval = window.setInterval(() => {
                    if (receivedCountRef.current > startCount) {
                        window.clearInterval(interval);
                        resolve();
                        return;
                    }
                    if (Date.now() - startedAt > values.timeoutMs) {
                        window.clearInterval(interval);
                        reject(
                            new Error(
                                'Timed out waiting for a Quick Test WebSocket receive.',
                            ),
                        );
                    }
                }, 100);
            });
            setWaitStatus('message observed');
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                createDirectRallarRuntimeEvent({
                    topic: 'rallar.direct.quick.receive.completed',
                    context: operationContext(),
                    transport: 'ws',
                    payload: {
                        waitedMs: Date.now() - startedAt,
                        receivedCount: receivedCountRef.current,
                    },
                }),
                'Quick Test receive observed',
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setWaitStatus('timeout');
            setLocalError(message);
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                createDirectRallarRuntimeEvent({
                    topic: 'rallar.direct.quick.receive.timeout',
                    context: operationContext(),
                    transport: 'ws',
                    severity: 'error',
                    payload: {
                        waitedMs: Date.now() - startedAt,
                        receivedCount: receivedCountRef.current,
                        error: message,
                    },
                }),
                'Quick Test receive timed out',
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    providerMode,
                    context: {
                        apiBaseUrl: globalValues.apiBaseUrl,
                        applicationId: globalValues.applicationId,
                        workspaceId: globalValues.workspaceId,
                        groupId: activeGroupId,
                        actor:
                            authSession?.username ??
                            authSession?.clientId ??
                            bootstrap.actor,
                        sessionId: authSession?.sessionId,
                    },
                    values,
                    selector: {
                        typeId: activeTypeId,
                        topicId: activeTopicId,
                        contextId: activeContextId,
                    },
                    browserStatus,
                    subscription: subscription
                        ? {
                              transport: subscription.transport,
                              label: subscription.label,
                              groupId: subscription.groupId,
                              subscribedAtEpochMs:
                                  subscription.subscribedAtEpochMs,
                          }
                        : undefined,
                    waitStatus,
                    localError,
                    lastResult,
                    receivedMessages: receivedMessages.slice(-8),
                },
                state,
                authSession,
            ),
        );
    };

    const copyRunnerRecipe = (): void => {
        const payload = payloadResult.ok ? payloadResult.value : {};
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    recipeId: 'rallar-quick-test-ws-group',
                    name: 'Rallar Quick Test WS group send',
                    requirements: [
                        'provider=browser-rallar',
                        'logged-in browser session',
                        'Rallar Server API reachable',
                        'receiver browser subscribed to same group/type/topic',
                    ],
                    continueOnFailure: false,
                    commands: [
                        {
                            kind: 'configure',
                            commandId: 'quick-configure',
                            config: {
                                runId: 'rallar-quick-test-export',
                                apiBaseUrl: globalValues.apiBaseUrl,
                                actor: authSession?.username ?? bootstrap.actor,
                                sessionId:
                                    authSession?.sessionId ??
                                    globalValues.sessionId,
                                roomId: activeGroupId,
                                providerMode,
                                rallar: {
                                    restoreSession: true,
                                    applicationId: globalValues.applicationId,
                                    workspaceId: globalValues.workspaceId,
                                    roomRef: {
                                        applicationId:
                                            globalValues.applicationId,
                                        workspaceId: globalValues.workspaceId,
                                        groupId: activeGroupId,
                                    },
                                    typeId: activeTypeId,
                                    topicId: activeTopicId,
                                },
                            },
                        },
                        {
                            kind: 'ws.send',
                            commandId: 'quick-ws-send',
                            connection: 'quick-test',
                            data: {
                                scope: 'room',
                                roomId: activeGroupId,
                                typeId: activeTypeId,
                                topicId: activeTopicId,
                                contextId: activeContextId,
                                payload,
                            },
                            timeoutMs: values.timeoutMs,
                        },
                    ],
                },
                state,
                authSession,
            ),
        );
    };

    const setupComplete =
        realBackendReady && Boolean(authSession) && Boolean(activeGroupId);
    const subscribed = Boolean(subscription);
    const sendComplete =
        lastResult?.kind === 'ws.send' && lastResult.status === 'completed';
    const verifyComplete =
        receivedMessages.length > 0 || waitStatus === 'message observed';
    const workflowSteps: readonly Readonly<{
        id: string;
        label: string;
        detail: string;
        state: 'done' | 'current' | 'blocked' | 'pending';
    }>[] = [
        {
            id: 'setup',
            label: 'Setup',
            detail: !realBackendReady
                ? 'real backend required'
                : !authSession
                  ? 'login required'
                  : activeGroupId
                    ? activeGroupId
                    : 'group required',
            state: setupComplete ? 'done' : 'current',
        },
        {
            id: 'subscribe',
            label: 'Subscribe',
            detail: subscription ? subscription.label : activeTypeId || 'type required',
            state: subscribed
                ? 'done'
                : setupComplete && activeTypeId
                  ? 'current'
                  : 'blocked',
        },
        {
            id: 'send',
            label: 'Send',
            detail: payloadResult.ok ? activeTopicId || activeTypeId || '-' : 'payload invalid',
            state: sendComplete
                ? 'done'
                : setupComplete && payloadResult.ok
                  ? 'current'
                  : setupComplete
                    ? 'blocked'
                    : 'pending',
        },
        {
            id: 'verify',
            label: 'Verify',
            detail: verifyComplete
                ? `${receivedMessages.length} received`
                : waitStatus,
            state: verifyComplete
                ? 'done'
                : sendComplete || subscribed
                  ? 'current'
                  : 'pending',
        },
    ];

    return (
        <section
            className="panel quick-rallar-test-panel"
            aria-label="Rallar Quick Test"
        >
            <div className="panel-heading">
                <h2>Quick Test</h2>
                <span
                    className={`pill ${subscription ? 'good' : realBackendReady ? 'muted' : 'warn'}`}
                >
                    {subscription
                        ? 'listening'
                        : realBackendReady
                          ? 'ready'
                          : 'real backend required'}
                </span>
            </div>
            <div className="quick-workflow-strip" aria-label="Quick Test workflow">
                {workflowSteps.map((step, index) => (
                    <div
                        className={`quick-workflow-step ${step.state}`}
                        key={step.id}
                    >
                        <span>{index + 1}</span>
                        <strong>{step.label}</strong>
                        <small>{step.detail}</small>
                    </div>
                ))}
            </div>
            <CollapsiblePanelSection
                title="Quick Test Info"
                meta={subscription ? 'listening' : waitStatus}
            >
                <div className="quick-rallar-summary-grid">
                    <Metric
                        label="Provider"
                        value={providerMode}
                        tone={realBackendReady ? 'good' : 'warn'}
                    />
                    <Metric label="API" value={globalValues.apiBaseUrl} />
                    <Metric
                        label="User"
                        value={authSession?.username ?? 'not logged in'}
                        tone={authSession ? 'good' : 'warn'}
                    />
                    <Metric
                        label="Session"
                        value={authSession?.sessionId ?? '-'}
                        tone={authSession ? 'good' : 'muted'}
                    />
                    <Metric
                        label="Group"
                        value={activeGroupId || '-'}
                        tone={activeGroupId ? 'good' : 'warn'}
                    />
                    <Metric
                        label="Signal WS"
                        value={browserStatus.signalingLabel}
                        tone={browserStatus.signalingTone}
                    />
                    <Metric
                        label="Subscription"
                        value={subscription?.label ?? 'not listening'}
                        tone={subscription ? 'good' : 'muted'}
                    />
                    <Metric
                        label="Received"
                        value={String(receivedMessages.length)}
                    />
                    <Metric label="Wait" value={waitStatus} />
                    <Metric
                        label="Last action"
                        value={lastResult?.status ?? '-'}
                    />
                </div>
                <div
                    className="quick-rallar-route-grid"
                    aria-label="Quick Test route"
                >
                    <div>
                        <span>Destination</span>
                        <strong>
                            {activeGroupId
                                ? `Group ${activeGroupId}`
                                : 'No group selected'}
                        </strong>
                        <small>
                            {globalValues.applicationId || '-'} /{' '}
                            {globalValues.workspaceId || '-'}
                        </small>
                    </div>
                    <div>
                        <span>Selector</span>
                        <strong>{selectorLabel}</strong>
                        <small>Context {activeContextId}</small>
                    </div>
                    <div>
                        <span>Receive</span>
                        <strong>
                            {subscription ? 'Subscribed' : 'Not subscribed'}
                        </strong>
                        <small>
                            {subscription
                                ? formatTime(subscription.subscribedAtEpochMs)
                                : 'Subscribe WS before receiving'}
                        </small>
                    </div>
                </div>
            </CollapsiblePanelSection>
            <CollapsiblePanelSection
                title="Quick Test Inputs"
                meta={`${activeGroupId || '-'} / ${selectorLabel}`}
            >
                <div className="quick-rallar-context-grid">
                    <label className="field">
                        <span>Group</span>
                        <input
                            value={globalValues.roomId}
                            onChange={(event) =>
                                updateGroupId(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Transport</span>
                        <select
                            value={values.transport}
                            onChange={(event) =>
                                updateValue(
                                    'transport',
                                    event.target.value as QuickRallarTransport,
                                )
                            }
                        >
                            <option value="ws">WS group message</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Type ID</span>
                        <input
                            value={values.typeId}
                            onChange={(event) =>
                                updateValue('typeId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Topic ID</span>
                        <input
                            value={values.topicId}
                            onChange={(event) =>
                                updateValue('topicId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Context ID</span>
                        <input
                            value={values.contextId}
                            onChange={(event) =>
                                updateValue('contextId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Resource ID</span>
                        <input
                            value={values.resourceId}
                            onChange={(event) =>
                                updateValue('resourceId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Timeout</span>
                        <input
                            type="number"
                            min={0}
                            value={values.timeoutMs}
                            onChange={(event) =>
                                updateValue(
                                    'timeoutMs',
                                    Number(event.target.value),
                                )
                            }
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="quick-action-groups">
                <div className="quick-action-group primary" aria-label="Primary Quick Test actions">
                    {!realBackendReady && (
                        <button
                            type="button"
                            className="primary-action"
                            onClick={onOpenRunnerMode}
                        >
                            Open runner mode
                        </button>
                    )}
                    {realBackendReady && !authSession && (
                        <button
                            type="button"
                            className="primary-action"
                            onClick={onOpenAuth}
                        >
                            Open Auth
                        </button>
                    )}
                    {canUseDirectRallar && !subscribed && (
                        <button
                            type="button"
                            className="primary-action"
                            disabled={!activeGroupId}
                            onClick={() => void createGroup()}
                        >
                            Create and join group
                        </button>
                    )}
                    {canUseDirectRallar && !subscribed && (
                        <button
                            type="button"
                            className="primary-action"
                            disabled={!activeGroupId || !activeTypeId}
                            onClick={() => void subscribeWs()}
                        >
                            Subscribe WS
                        </button>
                    )}
                    {canUseDirectRallar && (
                        <button
                            type="button"
                            className="primary-action"
                            disabled={
                                !setupComplete ||
                                !activeTypeId ||
                                !payloadResult.ok
                            }
                            onClick={() => void sendWs()}
                        >
                            Send WS JSON
                        </button>
                    )}
                    {subscribed && (
                        <button
                            type="button"
                            className="primary-action"
                            disabled={Boolean(busyAction)}
                            onClick={() => void waitForReceive()}
                        >
                            Wait for receive
                        </button>
                    )}
                </div>
                <div className="quick-action-group secondary" aria-label="Secondary Quick Test actions">
                    <button
                        type="button"
                        className="secondary-action"
                        disabled={!canUseDirectRallar || !activeGroupId}
                        onClick={() => void joinGroup()}
                    >
                        Join group
                    </button>
                    <button
                        type="button"
                        className="secondary-action"
                        disabled={!subscription}
                        onClick={unsubscribeWs}
                    >
                        Unsubscribe WS
                    </button>
                    <button
                        type="button"
                        className="secondary-action"
                        onClick={copyDiagnostics}
                    >
                        Copy diagnostics
                    </button>
                    <button
                        type="button"
                        className="secondary-action"
                        onClick={copyRunnerRecipe}
                    >
                        Copy runner recipe
                    </button>
                    {realBackendReady && (
                        <button
                            type="button"
                            className="secondary-action"
                            onClick={onOpenRunnerMode}
                        >
                            Open runner mode
                        </button>
                    )}
                </div>
            </div>
            <CollapsiblePanelSection
                title="Quick Test Payload"
                meta={`${receivedMessages.length} received`}
            >
                <div className="quick-rallar-payload-grid">
                    <label className="json-editor">
                        <span>Payload JSON</span>
                        <textarea
                            value={values.payloadText}
                            onChange={(event) =>
                                updateValue('payloadText', event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <div
                        className="quick-rallar-received-panel"
                        aria-label="Quick Test received messages"
                    >
                        <div className="websocket-received-heading">
                            <div>
                                <h3>Received Messages</h3>
                                <p>
                                    {subscription
                                        ? `Listening to ${subscription.label} in ${subscription.groupId}.`
                                        : 'Not listening.'}
                                </p>
                            </div>
                            <span
                                className={`pill ${subscription ? 'good' : 'muted'}`}
                            >
                                {subscription ? 'listening' : 'idle'}
                            </span>
                        </div>
                        <div className="websocket-received-list">
                            {receivedMessages.length === 0 && (
                                <div className="empty-state">
                                    No received messages
                                </div>
                            )}
                            {receivedMessages
                                .slice()
                                .reverse()
                                .map((message) => (
                                    <article
                                        className="websocket-received-row"
                                        key={message.rowId}
                                    >
                                        <div>
                                            <strong>
                                                {message.topicId} /{' '}
                                                {message.typeId}
                                            </strong>
                                            <small>
                                                {formatTime(message.atEpochMs)}{' '}
                                                - group {message.roomId}
                                            </small>
                                            <small>
                                                sender {message.senderId} -
                                                context {message.contextId}
                                            </small>
                                        </div>
                                        <pre className="mini-json">
                                            {redactedJson(
                                                message.payload,
                                                state,
                                                authSession,
                                            )}
                                        </pre>
                                    </article>
                                ))}
                        </div>
                    </div>
                </div>
            </CollapsiblePanelSection>
            {(!realBackendReady ||
                !authSession ||
                localError ||
                !payloadResult.ok ||
                busyAction) && (
                <div
                    className={
                        localError || !payloadResult.ok
                            ? 'workbench-error'
                            : 'command-center-status'
                    }
                    role="status"
                >
                    {localError ??
                        (!payloadResult.ok
                            ? payloadResult.error
                            : !realBackendReady
                              ? 'Quick Test requires provider=browser-rallar.'
                              : !authSession
                                ? 'Quick Test requires a logged-in browser session.'
                                : busyAction)}
                </div>
            )}
        </section>
    );
}


function RtcDiagnosticsPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    busy,
    onSelectCommand,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    busy: boolean;
    onSelectCommand(commandId: string): void;
}) {
    const diagnostics = useMemo(() => deriveRtcDiagnostics(state), [state]);
    const rtcPerformance = useMemo(
        () => deriveRtcPerformanceView({ diagnostics, state }),
        [diagnostics, state],
    );
    const [sequence, setSequence] = useState(1);
    const [bundleVisible, setBundleVisible] = useState(false);
    const [localError, setLocalError] = useState<string | undefined>();
    const providerMode = bootstrap.providerMode;
    const canRunDirect =
        providerMode === 'browser-rallar' && Boolean(authSession) && !busy;
    const bundleText = useMemo(
        () => redactedJson(diagnostics.bundle, state, authSession),
        [authSession, diagnostics.bundle, state],
    );
    const directContext = (): Parameters<
        typeof runDirectRallarStatusCheck
    >[0] => ({
        providerMode,
        apiBaseUrl: globalValues?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        applicationId:
            globalValues?.applicationId ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId:
            globalValues?.workspaceId ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        roomId: globalValues?.roomId ?? bootstrap.roomId,
        actor:
            authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: 'rtc-diagnostics',
        authSession,
        timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
    });
    const recordRtcDiagnostic = (
        topic: string,
        payload: unknown,
        lastAction: string,
        severity: RallarBlackBoxTestRuntimeEventInput['severity'] = 'info',
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: directContext(),
                transport: 'realtime',
                severity,
                payload,
            }),
            lastAction,
        );
    };
    const runAction = async (
        label: string,
        action: ManualWorkbenchAction | 'reconnect' | 'cleanup',
    ): Promise<void> => {
        setLocalError(undefined);
        try {
            if (providerMode !== 'browser-rallar') {
                throw new Error(
                    'RTC Diagnostics actions require provider=browser-rallar.',
                );
            }
            if (!authSession) {
                throw new Error(
                    'RTC Diagnostics actions require a logged-in browser session.',
                );
            }
            const facade = await loadBrowserRallarFacade();
            const context = directContext();
            configureDirectRallarFacade(facade, context);
            if (
                action === 'reconnect' ||
                action === 'cleanup' ||
                action === 'close'
            ) {
                await facade.disconnect();
            }
            let result: unknown;
            if (
                action === 'cleanup' ||
                action === 'close' ||
                action === 'reset'
            ) {
                result = {
                    action,
                    disconnected: true,
                    wsStatus: facade.ws.status(),
                    rtcStatus: facade.rtc.status(),
                };
            } else {
                const startResult = await facade.start({
                    connect: true,
                    refreshRooms: false,
                    refreshPeople: false,
                    timeoutMs: context.timeoutMs,
                });
                if (context.roomId) {
                    await facade.rooms.join(context.roomId, {
                        scope: {
                            applicationId: context.applicationId,
                            workspaceId: context.workspaceId,
                        },
                        timeoutMs: context.timeoutMs,
                    });
                }
                result = {
                    action,
                    connected: startResult.connected || facade.isConnected(),
                    status: facade.status(),
                    wsStatus: facade.ws.status(),
                    rtcStatus: facade.rtc.status(),
                    realtimeHealth: facade.realtime.health(),
                };
            }
            setSequence((current) => current + 1);
            recordRtcDiagnostic(
                `rallar.direct.rtc_diagnostics.${label.toLowerCase().replaceAll(' ', '_')}.completed`,
                result,
                label,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            recordRtcDiagnostic(
                `rallar.direct.rtc_diagnostics.${label.toLowerCase().replaceAll(' ', '_')}.failed`,
                { error: message },
                `${label} failed`,
                'error',
            );
        }
    };
    const copyBundle = (): void => {
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(bundleText);
        }
    };

    return (
        <section className="panel rtc-diagnostics-panel">
            <div className="panel-heading">
                <h2>RTC Diagnostics</h2>
                <span
                    className={`pill ${diagnostics.failure ? 'bad' : 'good'}`}
                >
                    {diagnostics.failure ? 'focused' : 'clear'}
                </span>
            </div>
            <div className="rtc-actions">
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() =>
                        void runAction('RTC reconnect check', 'reconnect')
                    }
                >
                    Reconnect
                </button>
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() =>
                        void runAction('RTC rejoin check', 'connect')
                    }
                >
                    Rejoin
                </button>
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() => void runAction('RTC health check', 'health')}
                >
                    Health
                </button>
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() => void runAction('RTC close', 'close')}
                >
                    Close
                </button>
                <button
                    type="button"
                    disabled={!canRunDirect}
                    onClick={() => void runAction('RTC cleanup', 'cleanup')}
                >
                    Cleanup
                </button>
                <button type="button" onClick={copyBundle}>
                    Copy Bundle
                </button>
                <button
                    type="button"
                    onClick={() => setBundleVisible((current) => !current)}
                >
                    {bundleVisible ? 'Hide Bundle' : 'Show Bundle'}
                </button>
            </div>
            <div className="rtc-latency-grid">
                <Metric
                    label="Connect"
                    value={formatDuration(diagnostics.latency.connectMs)}
                />
                <Metric
                    label="First payload"
                    value={formatDuration(diagnostics.latency.firstPayloadMs)}
                />
                <Metric
                    label="From connect"
                    value={formatDuration(
                        diagnostics.latency.firstPayloadFromConnectMs,
                    )}
                />
                <Metric
                    label="Last command"
                    value={formatDuration(diagnostics.latency.lastCommandMs)}
                />
                <Metric
                    label="Avg command"
                    value={formatDuration(diagnostics.latency.averageCommandMs)}
                />
                <Metric
                    label="Max command"
                    value={formatDuration(diagnostics.latency.maxCommandMs)}
                />
            </div>
            <RtcPerformancePanel
                view={rtcPerformance}
                showTimeseries={false}
            />
            <RtcDiagnosticsTimeseriesPanel series={diagnostics.timeseries} />
            <div className="rtc-stage-list">
                {diagnostics.stages.map((stage) => (
                    <article className="rtc-stage-row" key={stage.stageId}>
                        <span
                            className={`status-dot ${stage.status === 'observed' ? 'completed' : stage.status}`}
                        />
                        <div>
                            <strong>{stage.label}</strong>
                            <small>
                                {stage.topic ?? 'waiting for runtime event'}
                            </small>
                        </div>
                        <span className={`pill ${stageTone(stage.status)}`}>
                            {stage.status}
                        </span>
                        <span>{formatDuration(stage.durationFromStartMs)}</span>
                    </article>
                ))}
            </div>
            <dl className="rtc-membership-list">
                <div>
                    <dt>Connection</dt>
                    <dd>{diagnostics.membership.connection}</dd>
                </div>
                <div>
                    <dt>Actor</dt>
                    <dd>{diagnostics.membership.actor}</dd>
                </div>
                <div>
                    <dt>Room</dt>
                    <dd>{diagnostics.membership.roomId}</dd>
                </div>
                <div>
                    <dt>Session</dt>
                    <dd>{diagnostics.membership.sessionId ?? '-'}</dd>
                </div>
                <div>
                    <dt>Expected</dt>
                    <dd>
                        {formatList(diagnostics.membership.expectedClients)}
                    </dd>
                </div>
                <div>
                    <dt>Observed</dt>
                    <dd>
                        {formatList(diagnostics.membership.observedClients)}
                    </dd>
                </div>
                <div>
                    <dt>Ready Peers</dt>
                    <dd>{formatList(diagnostics.membership.readyPeerIds)}</dd>
                </div>
                <div>
                    <dt>Active Peers</dt>
                    <dd>{formatList(diagnostics.membership.activePeerIds)}</dd>
                </div>
                <div>
                    <dt>Missing</dt>
                    <dd>{formatList(diagnostics.membership.missingClients)}</dd>
                </div>
                <div>
                    <dt>Stale</dt>
                    <dd>{formatList(diagnostics.membership.staleClients)}</dd>
                </div>
                <div>
                    <dt>Peer Count</dt>
                    <dd>{diagnostics.membership.peerCount ?? '-'}</dd>
                </div>
                <div>
                    <dt>Lane Health</dt>
                    <dd>{String(diagnostics.membership.laneHealth ?? '-')}</dd>
                </div>
                <div>
                    <dt>NACK</dt>
                    <dd>{formatList(diagnostics.membership.nackCodes)}</dd>
                </div>
            </dl>
            {diagnostics.failure && (
                <div className="rtc-failure">
                    <strong>{diagnostics.failure.message}</strong>
                    <small>
                        {diagnostics.failure.topic ?? 'runtime failure'}
                    </small>
                </div>
            )}
            {bundleVisible && (
                <textarea
                    className="report-output rtc-bundle-output"
                    value={bundleText}
                    readOnly
                    spellCheck={false}
                />
            )}
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession),
                    )}
                </div>
            )}
        </section>
    );
}

function TopologyGraphPanel({
    state,
    active,
    onSelectCommand,
}: {
    state: RallarBlackBoxTestState;
    active: boolean;
    onSelectCommand(commandId: string): void;
}) {
    const [filter, setFilter] = useState<RallarTopologyFilter>('all');
    const [query, setQuery] = useState('');
    const [nodeLimit, setNodeLimit] = useState(18);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const topology = useMemo(() => deriveRallarTopologyGraph(state), [state]);
    const visibleCounts = useMemo(
        () => visibleTopologyCounts(topology.graph, filter),
        [filter, topology.graph],
    );
    const matchingNodes = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        const rows: Array<
            Readonly<{
                id: string;
                label: string;
                kind: string;
                status: string;
                eventCount: number;
            }>
        > = [];
        topology.graph.forEachNode((id, attrs) => {
            if (filter !== 'all' && attrs.status !== filter) {
                return;
            }
            if (
                normalizedQuery.length > 0 &&
                !`${id} ${attrs.label} ${attrs.kind} ${attrs.status}`
                    .toLowerCase()
                    .includes(normalizedQuery)
            ) {
                return;
            }
            rows.push({
                id,
                label: attrs.label,
                kind: attrs.kind,
                status: attrs.status,
                eventCount: attrs.eventCount,
            });
        });
        return rows.sort(
            (left, right) =>
                left.kind.localeCompare(right.kind) ||
                left.label.localeCompare(right.label),
        );
    }, [filter, query, topology.graph]);
    const visibleNodes = useMemo(
        () => matchingNodes.slice(0, nodeLimit),
        [matchingNodes, nodeLimit],
    );
    const routeResults = useMemo(
        () =>
            state.commandHistory
                .filter(
                    (result) =>
                        result.kind === 'rtc.send' || result.kind === 'ws.send',
                )
                .slice(-8)
                .reverse(),
        [state.commandHistory],
    );
    const routeSummary = useMemo(() => {
        const routes = state.commandHistory.filter(
            (result) => result.kind === 'rtc.send' || result.kind === 'ws.send',
        );
        return {
            total: routes.length,
            failed: routes.filter((result) => !result.ok).length,
            rtc: routes.filter((result) => result.kind === 'rtc.send').length,
            ws: routes.filter((result) => result.kind === 'ws.send').length,
        };
    }, [state.commandHistory]);

    useEffect(() => {
        if (!active) {
            return;
        }

        const container = containerRef.current;
        if (!container) {
            return;
        }

        const renderer = new Sigma(topology.graph, container, {
            allowInvalidContainer: true,
            hideEdgesOnMove: false,
            hideLabelsOnMove: true,
            labelRenderedSizeThreshold: 8,
            nodeReducer: (_node, attrs) => ({
                ...attrs,
                hidden: filter !== 'all' && attrs.status !== filter,
                highlighted: attrs.status === 'failed',
            }),
            edgeReducer: (_edge, attrs) => ({
                ...attrs,
                hidden: filter !== 'all' && attrs.status !== filter,
            }),
        });

        return () => renderer.kill();
    }, [active, filter, topology.graph]);

    return (
        <section className="panel topology-panel">
            <div className="panel-heading">
                <h2>Topology</h2>
                <span>{visibleCounts.nodes} nodes</span>
            </div>
            <div
                className="segmented topology-filters"
                role="group"
                aria-label="Topology filter"
            >
                {(['all', 'active', 'degraded', 'failed'] as const).map(
                    (entry) => (
                        <button
                            type="button"
                            key={entry}
                            className={filter === entry ? 'selected' : ''}
                            onClick={() => setFilter(entry)}
                        >
                            {topologyFilterLabel(entry)}
                        </button>
                    ),
                )}
            </div>
            <div className="topology-search-grid">
                <label className="field compact-field">
                    <span>Search</span>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="node, route, status"
                    />
                </label>
                <label className="field compact-field">
                    <span>Node Limit</span>
                    <select
                        value={nodeLimit}
                        onChange={(event) =>
                            setNodeLimit(Number(event.target.value))
                        }
                    >
                        {[18, 50, 100, 200].map((limit) => (
                            <option key={limit} value={limit}>
                                {limit}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <div className="topology-summary-grid">
                <Metric label="Edges" value={String(visibleCounts.edges)} />
                <Metric label="Rooms" value={String(topology.summary.rooms)} />
                <Metric
                    label="Sessions"
                    value={String(topology.summary.sessions)}
                />
                <Metric
                    label="Routes"
                    value={String(topology.summary.routes)}
                />
                <Metric
                    label="Degraded"
                    value={String(
                        topology.summary.degradedNodes +
                            topology.summary.degradedEdges,
                    )}
                    tone={
                        topology.summary.degradedNodes +
                            topology.summary.degradedEdges >
                        0
                            ? 'warn'
                            : 'good'
                    }
                />
                <Metric
                    label="Failed"
                    value={String(
                        topology.summary.failedNodes +
                            topology.summary.failedEdges,
                    )}
                    tone={
                        topology.summary.failedNodes +
                            topology.summary.failedEdges >
                        0
                            ? 'bad'
                            : 'good'
                    }
                />
                <Metric label="Route cmds" value={String(routeSummary.total)} />
                <Metric label="RTC routes" value={String(routeSummary.rtc)} />
                <Metric label="WS routes" value={String(routeSummary.ws)} />
                <Metric
                    label="Route failures"
                    value={String(routeSummary.failed)}
                    tone={routeSummary.failed > 0 ? 'bad' : 'good'}
                />
            </div>
            <div
                className="sigma-host"
                ref={containerRef}
                aria-label="Rallar topology graph"
            />
            <div className="topology-lists">
                <div className="topology-node-list">
                    <div className="section-heading">
                        <h3>Nodes</h3>
                        <span>
                            {visibleNodes.length} of {matchingNodes.length}
                        </span>
                    </div>
                    <div className="topology-list-body">
                        {visibleNodes.length === 0 && (
                            <div className="empty-state">No topology nodes</div>
                        )}
                        {visibleNodes.map((node) => (
                            <article
                                className="topology-node-row"
                                key={node.id}
                            >
                                <div>
                                    <strong>{node.label}</strong>
                                    <small>
                                        {node.kind} - {node.eventCount} events
                                    </small>
                                </div>
                                <span
                                    className={`pill ${node.status === 'failed' ? 'bad' : node.status === 'degraded' ? 'warn' : 'good'}`}
                                >
                                    {node.status}
                                </span>
                            </article>
                        ))}
                    </div>
                </div>
                <div className="topology-node-list">
                    <div className="section-heading">
                        <h3>Routes</h3>
                        <span>{routeResults.length} commands</span>
                    </div>
                    <div className="topology-list-body">
                        {routeResults.length === 0 && (
                            <div className="empty-state">No route commands</div>
                        )}
                        {routeResults.map((result, index) => (
                            <button
                                type="button"
                                className="topology-route-row"
                                key={`${result.commandId}-${index}`}
                                onClick={() =>
                                    onSelectCommand(result.commandId)
                                }
                            >
                                <span>{result.commandId}</span>
                                <small>{result.kind}</small>
                                <span
                                    className={`pill ${result.ok ? 'good' : 'bad'}`}
                                >
                                    {result.status}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

function WebSocketCommandCenterPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    browserStatus,
    busy,
    onSelectCommand,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
    busy: boolean;
    onSelectCommand(commandId: string): void;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = config
        ? rallarBlackBoxProviderModeFromConfig(config)
        : bootstrap.providerMode;
    const defaultContext = defaultWebSocketValuesFromContext(
        globalValues,
        config,
        bootstrap,
    );
    const [values, setValues] = useState<WebSocketCommandCenterValues>(() => ({
        apiBaseUrl: defaultContext.apiBaseUrl,
        connection: 'rallarApi',
        applicationId: defaultContext.applicationId,
        workspaceId: defaultContext.workspaceId,
        groupId: defaultContext.groupId,
        wsScope: defaultWebSocketScope(),
        typeId: defaultWebSocketTypeId(),
        topicId: defaultWebSocketTopicId(),
        contextId:
            webSocketPayloadPresetById(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID)
                .values?.contextId ?? defaultContext.contextId,
        resourceId: '',
        wsUrl: defaultWebSocketApiUrl(defaultContext.apiBaseUrl),
        protocols: '',
        payloadText:
            webSocketPayloadPresetText(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID) ??
            '{}',
        timeoutMs: 5_000,
        closeCode: 1000,
        closeReason: 'rallar-black-box cleanup',
    }));
    const [payloadPresetId, setPayloadPresetId] = useState(
        DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID,
    );
    const [sequence, setSequence] = useState(1);
    const [localError, setLocalError] = useState<string | undefined>();
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [actionFeedback, setActionFeedback] =
        useState<CommandCenterActionFeedback>(() =>
            idleActionFeedback(
                'Run a WebSocket operation to see action status.',
            ),
        );
    const [waitStatus, setWaitStatus] = useState<string>('idle');
    const [ticket, setTicket] = useState<AuthCommandCenterTicket | undefined>();
    const [subscription, setSubscription] = useState<
        WebSocketSubscriptionState | undefined
    >();
    const rawSocketRef = useRef<WebSocket | undefined>(undefined);
    const rawSocketAuthKey = authSession
        ? `${authSession.clientId}:${authSession.sessionId}`
        : 'anonymous';
    const stateRef = useRef(state);
    const defaultContextRef = useRef(defaultContext);
    const diagnostics = useMemo(
        () => deriveWebSocketDiagnostics(state, values.connection),
        [state, values.connection],
    );
    const activePreset = useMemo(
        () => webSocketPayloadPresetById(payloadPresetId),
        [payloadPresetId],
    );
    const canSendViaRallarSignaling = providerMode === 'browser-rallar';
    const routePreview = useMemo(
        () =>
            webSocketRoutePreview({
                values,
                diagnostics,
                providerMode,
                browserStatus,
            }),
        [browserStatus, diagnostics, providerMode, values],
    );
    const subscriptionStatusLabel = subscription
        ? 'listening'
        : 'not listening';
    const subscriptionStatusTone = subscription ? 'good' : 'muted';
    const receiveStatusText = subscription
        ? `Listening for ${subscription.label} at ${subscription.destination}.`
        : providerMode === 'browser-rallar'
          ? 'Not listening. Click Subscribe WS to receive app messages in this browser.'
          : 'Received messages appear here when WS message events are emitted.';
    const payloadResult = useMemo(() => {
        try {
            return {
                ok: true as const,
                value: JSON.parse(values.payloadText) as unknown,
            };
        } catch (error) {
            return {
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }, [values.payloadText]);

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    useEffect(() => {
        const previousDefault = defaultContextRef.current;
        defaultContextRef.current = defaultContext;
        setValues((current) => {
            const previousDefaultWsUrl = defaultWebSocketApiUrl(
                previousDefault.apiBaseUrl,
            );
            const next = {
                ...current,
                apiBaseUrl:
                    current.apiBaseUrl === previousDefault.apiBaseUrl
                        ? defaultContext.apiBaseUrl
                        : current.apiBaseUrl,
                applicationId:
                    current.applicationId === previousDefault.applicationId
                        ? defaultContext.applicationId
                        : current.applicationId,
                workspaceId:
                    current.workspaceId === previousDefault.workspaceId
                        ? defaultContext.workspaceId
                        : current.workspaceId,
                groupId:
                    current.groupId === previousDefault.groupId ||
                    current.groupId === ''
                        ? defaultContext.groupId
                        : current.groupId,
                contextId:
                    current.contextId === previousDefault.contextId ||
                    current.contextId === previousDefault.groupId ||
                    current.contextId === ''
                        ? defaultContext.contextId
                        : current.contextId,
                wsUrl:
                    current.wsUrl === previousDefaultWsUrl
                        ? defaultWebSocketApiUrl(defaultContext.apiBaseUrl)
                        : current.wsUrl,
            };

            return JSON.stringify(next) === JSON.stringify(current)
                ? current
                : next;
        });
    }, [
        defaultContext.apiBaseUrl,
        defaultContext.applicationId,
        defaultContext.workspaceId,
        defaultContext.groupId,
        defaultContext.contextId,
    ]);

    useEffect(() => () => subscription?.unsubscribe(), [subscription]);

    useEffect(() => {
        return () => {
            const socket = rawSocketRef.current;
            rawSocketRef.current = undefined;
            if (
                socket &&
                socket.readyState !== WebSocket.CLOSING &&
                socket.readyState !== WebSocket.CLOSED
            ) {
                socket.close(1000, 'rallar-black-box auth cleanup');
            }
        };
    }, [rawSocketAuthKey]);

    const updateValue = <K extends keyof WebSocketCommandCenterValues>(
        key: K,
        value: WebSocketCommandCenterValues[K],
    ): void => {
        setValues((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const updateGroupId = (groupId: string): void => {
        setValues((current) => ({
            ...current,
            groupId,
            contextId:
                current.contextId === current.groupId ||
                current.contextId === '' ||
                current.contextId === 'all' ||
                current.contextId === current.wsScope
                    ? groupId || current.wsScope
                    : current.contextId,
        }));
    };

    const updateWsScope = (
        wsScope: WebSocketCommandCenterValues['wsScope'],
    ): void => {
        setValues((current) => ({
            ...current,
            wsScope,
            contextId:
                current.contextId === current.wsScope ||
                current.contextId === current.groupId ||
                current.contextId === 'all' ||
                current.contextId === 'world' ||
                current.contextId === 'room'
                    ? wsScope === 'room'
                        ? current.groupId || 'room'
                        : wsScope
                    : current.contextId,
        }));
    };

    const selectPayloadPreset = (presetId: string): void => {
        setPayloadPresetId(presetId);
        const preset = WEBSOCKET_PAYLOAD_PRESETS.find(
            (entry) => entry.presetId === presetId,
        );
        if (preset?.values) {
            setValues((current) => ({
                ...current,
                ...preset.values,
                contextId:
                    preset.values?.contextId ??
                    current.groupId ??
                    current.contextId,
            }));
        }
        const text = webSocketPayloadPresetText(presetId);
        if (text) {
            updateValue('payloadText', text);
        }
    };

    const directContext = (): Parameters<
        typeof runDirectRallarStatusCheck
    >[0] => ({
        providerMode,
        apiBaseUrl: values.apiBaseUrl,
        applicationId: values.applicationId,
        workspaceId: values.workspaceId,
        roomId: values.groupId.trim(),
        actor:
            authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: values.connection,
        authSession,
        timeoutMs: values.timeoutMs,
    });

    const recordWebSocketEvent = (
        topic: string,
        payload: unknown,
        lastAction: string,
        severity: RallarBlackBoxTestRuntimeEventInput['severity'] = 'info',
        kind: RallarBlackBoxTestRuntimeEventInput['kind'] = 'diagnostic',
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: directContext(),
                kind,
                transport: 'ws',
                severity,
                payload,
            }),
            lastAction,
        );
    };

    const recordDirectResult = (
        result: DirectRallarOperationResult,
        completedAction: string,
        failedAction: string,
    ): void => {
        result.events.forEach((event) =>
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(event),
        );
        if (result.status === 'failed') {
            setLocalError(result.error?.message ?? failedAction);
            setWaitStatus('failed');
        } else {
            setWaitStatus('completed');
        }
        recordWebSocketEvent(
            `rallar.direct.websocket.${result.kind}.${result.status}`,
            {
                status: result.status,
                durationMs: result.durationMs,
                value: result.value,
                error: result.error,
            },
            result.status === 'failed' ? failedAction : completedAction,
            result.status === 'failed' ? 'error' : 'info',
            'state',
        );
    };

    const configure = async (): Promise<void> => {
        setBusyAction('Configure WebSocket');
        setLocalError(undefined);
        const label = 'Configure WebSocket';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                values.connection,
                'Recording the current WebSocket configuration.',
            ),
        );
        try {
            setSequence((current) => current + 1);
            recordWebSocketEvent(
                'rallar.direct.raw_ws.configure.completed',
                {
                    connection: values.connection,
                    apiBaseUrl: values.apiBaseUrl,
                    wsUrl: values.wsUrl,
                    groupId: values.groupId,
                    selector: {
                        typeId: values.typeId,
                        topicId: values.topicId,
                    },
                },
                'Configure WebSocket',
            );
            setWaitStatus('configured');
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.connection,
                    ok: true,
                    status: 'configured',
                    message: `Configured ${routePreview.destination}.`,
                }),
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.connection,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const requestWsTicket = async (): Promise<AuthCommandCenterTicket> => {
        const response = await executeRallarServerRestRequest({
            apiBaseUrl: values.apiBaseUrl,
            method: 'POST',
            path: '/api/auth/ws-ticket',
            headersText: '{}',
            queryText: '{}',
            bodyText: '{}',
            responseBodyMode: 'json',
            attachAuth: true,
            authSession,
            timeoutMs: values.timeoutMs,
        });
        const body = optionalRecord(response.bodyJson);
        if (
            response.ok &&
            typeof body.ticket === 'string' &&
            typeof body.sessionId === 'string' &&
            typeof body.expiresAtEpochMs === 'number'
        ) {
            const wsTicket = body as WebSocketTicketResponse;
            const nextTicket = {
                ticket: wsTicket.ticket,
                sessionId: wsTicket.sessionId,
                expiresAtEpochMs: wsTicket.expiresAtEpochMs,
                issuedAtEpochMs: Date.now(),
            };
            setTicket(nextTicket);
            return nextTicket;
        }

        throw new Error(
            response.error?.message ??
                `WS ticket request returned ${response.status}`,
        );
    };

    const open = async (
        url = values.wsUrl,
        options: { useTicket?: boolean } = { useTicket: true },
    ): Promise<void> => {
        setBusyAction('Open WebSocket');
        setLocalError(undefined);
        const label =
            options.useTicket === false
                ? 'Open WebSocket without ticket'
                : 'Open WebSocket';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                url,
                options.useTicket === false
                    ? 'Opening raw WebSocket without acquiring a ticket.'
                    : 'Creating a ticket and opening the raw WebSocket.',
            ),
        );
        try {
            const nextTicket =
                options.useTicket === false
                    ? undefined
                    : await requestWsTicket();
            const resolvedUrl = resolveWebSocketUrlTemplate(
                url,
                values.apiBaseUrl,
                authSession,
                nextTicket,
            );
            setActionFeedback(
                runningActionFeedback(
                    label,
                    resolvedUrl,
                    'Opening raw WebSocket connection.',
                ),
            );
            const protocols = values.protocols
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            rawSocketRef.current?.close(values.closeCode, 'replace raw socket');
            const socket = new WebSocket(
                resolvedUrl,
                protocols.length > 0 ? protocols : undefined,
            );
            rawSocketRef.current = socket;
            setSequence((current) => current + 1);
            socket.addEventListener('open', () => {
                recordWebSocketEvent(
                    'rallar.direct.raw_ws.open.completed',
                    {
                        connection: values.connection,
                        url: resolvedUrl,
                        readyState: socket.readyState,
                    },
                    'Open WebSocket',
                );
                setWaitStatus('raw ws open');
                setActionFeedback(
                    completedActionFeedback({
                        label,
                        startedAtEpochMs,
                        target: resolvedUrl,
                        ok: true,
                        status: 'open',
                        message: 'Raw WebSocket is open.',
                    }),
                );
            });
            socket.addEventListener('message', (event) => {
                let data: unknown = event.data;
                if (typeof event.data === 'string') {
                    try {
                        data = JSON.parse(event.data);
                    } catch {
                        data = event.data;
                    }
                }
                recordWebSocketEvent(
                    'rallar.direct.raw_ws.message',
                    {
                        connection: values.connection,
                        data,
                    },
                    'Raw WebSocket message received',
                    'info',
                    'message',
                );
            });
            socket.addEventListener('error', () => {
                recordWebSocketEvent(
                    'rallar.direct.raw_ws.error',
                    {
                        connection: values.connection,
                        url: resolvedUrl,
                        readyState: socket.readyState,
                    },
                    'Raw WebSocket error',
                    'error',
                );
                setWaitStatus('raw ws error');
                setActionFeedback(
                    completedActionFeedback({
                        label,
                        startedAtEpochMs,
                        target: resolvedUrl,
                        ok: false,
                        statusText: 'error',
                        message: 'Raw WebSocket emitted an error.',
                    }),
                );
            });
            socket.addEventListener('close', (event) => {
                recordWebSocketEvent(
                    'rallar.direct.raw_ws.close',
                    {
                        connection: values.connection,
                        code: event.code,
                        reason: event.reason,
                        wasClean: event.wasClean,
                    },
                    'Raw WebSocket closed',
                    event.wasClean ? 'info' : 'warning',
                );
                setWaitStatus('raw ws closed');
            });
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: resolvedUrl,
                    ok: true,
                    status: 'requested',
                    message: 'Raw WebSocket open was requested.',
                }),
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setWaitStatus('raw ws open failed');
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: url,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const send = async (): Promise<void> => {
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Send WebSocket JSON',
                    startedAtEpochMs: Date.now(),
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'invalid payload',
                    message: payloadResult.error,
                }),
            );
            return;
        }
        if (values.wsScope === 'room' && !values.groupId.trim()) {
            const message = 'Room-scoped WS sends require a Group.';
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Send WebSocket JSON',
                    startedAtEpochMs: Date.now(),
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'invalid target',
                    message,
                }),
            );
            return;
        }
        setBusyAction('Send WebSocket JSON');
        setLocalError(undefined);
        const label = 'Send WebSocket JSON';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                routePreview.destination,
                `Sending ${routePreview.selector} through Rallar WS messages.`,
            ),
        );
        try {
            const result = await runDirectRallarWsSend(
                directContext(),
                {
                    scope: values.wsScope,
                    typeId: values.typeId,
                    topicId: values.topicId,
                    contextId: values.contextId,
                    resourceId: values.resourceId || undefined,
                    payload: payloadResult.value,
                },
                loadBrowserRallarFacade,
            );
            setSequence((current) => current + 1);
            recordDirectResult(
                result,
                'Rallar WS JSON sent',
                'Rallar WS send failed',
            );
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: routePreview.destination,
                    ok: result.status === 'completed',
                    status: result.status,
                    durationMs: result.durationMs,
                    message:
                        result.status === 'completed'
                            ? `Sent ${routePreview.selector}.`
                            : (result.error?.message ??
                              'Rallar WS send failed.'),
                }),
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const close = async (reason = values.closeReason): Promise<void> => {
        setBusyAction('Close WebSocket');
        setLocalError(undefined);
        const label = 'Close WebSocket';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                values.wsUrl,
                'Closing the raw WebSocket if one is open.',
            ),
        );
        try {
            const socket = rawSocketRef.current;
            rawSocketRef.current = undefined;
            socket?.close(values.closeCode, reason);
            recordWebSocketEvent(
                'rallar.direct.raw_ws.close.requested',
                {
                    connection: values.connection,
                    closeCode: values.closeCode,
                    closeReason: reason,
                },
                'Close WebSocket',
            );
            setSequence((current) => current + 1);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.wsUrl,
                    ok: true,
                    status: socket ? 'close requested' : 'no socket',
                    message: socket
                        ? 'Raw WebSocket close was requested.'
                        : 'No raw WebSocket was open.',
                }),
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.wsUrl,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const reconnect = async (): Promise<void> => {
        await close('reconnect');
        await open(values.wsUrl);
    };

    const cleanup = async (): Promise<void> => {
        setTicket(undefined);
        await close('cleanup');
    };

    const subscribeWs = async (): Promise<void> => {
        if (!values.typeId.trim()) {
            const message = 'WS subscription requires a Type ID.';
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Subscribe WS',
                    startedAtEpochMs: Date.now(),
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'invalid selector',
                    message,
                }),
            );
            return;
        }
        if (values.wsScope === 'room' && !values.groupId.trim()) {
            const message = 'Room-scoped WS subscriptions require a Group.';
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Subscribe WS',
                    startedAtEpochMs: Date.now(),
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'invalid target',
                    message,
                }),
            );
            return;
        }
        setBusyAction('Subscribe WS');
        setLocalError(undefined);
        const label = 'Subscribe WS';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                routePreview.destination,
                `Subscribing to ${routePreview.selector}.`,
            ),
        );
        try {
            subscription?.unsubscribe();
            const selector = {
                typeId: values.typeId,
                ...(values.topicId ? { topicId: values.topicId } : {}),
            };
            const result = await runDirectRallarWsSubscribe(
                directContext(),
                selector,
                (message) => {
                    const record = optionalRecord(message);
                    recordWebSocketEvent(
                        'rallar.direct.ws.message',
                        {
                            roomId:
                                record.roomId ??
                                record.groupId ??
                                values.groupId,
                            applicationId: values.applicationId,
                            workspaceId: values.workspaceId,
                            typeId: record.typeId ?? values.typeId,
                            topicId: record.topicId ?? values.topicId,
                            contextId: record.contextId ?? values.contextId,
                            resourceId: record.resourceId,
                            senderId: record.senderId,
                            data: record.payload ?? message,
                            raw: message,
                        },
                        'Rallar WS message received',
                        'info',
                        'message',
                    );
                },
                loadBrowserRallarFacade,
            );
            recordDirectResult(
                result,
                'Rallar WS subscribed',
                'Rallar WS subscribe failed',
            );
            if (result.status === 'completed' && result.unsubscribe) {
                setSubscription({
                    label: `${selector.topicId ?? '*'} / ${selector.typeId}`,
                    destination: routePreview.destination,
                    groupId: values.groupId,
                    subscribedAtEpochMs: Date.now(),
                    unsubscribe: result.unsubscribe,
                });
                setWaitStatus('subscribed');
            }
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: routePreview.destination,
                    ok: result.status === 'completed',
                    status: result.status,
                    durationMs: result.durationMs,
                    message:
                        result.status === 'completed'
                            ? `Subscribed to ${selector.topicId ?? '*'} / ${selector.typeId}.`
                            : (result.error?.message ??
                              'Rallar WS subscribe failed.'),
                }),
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const unsubscribeWs = (): void => {
        const startedAtEpochMs = Date.now();
        subscription?.unsubscribe();
        setSubscription(undefined);
        setWaitStatus('unsubscribed');
        setActionFeedback(
            completedActionFeedback({
                label: 'Unsubscribe WS',
                startedAtEpochMs,
                target: subscription?.destination ?? routePreview.destination,
                ok: true,
                status: subscription ? 'unsubscribed' : 'no subscription',
                message: subscription
                    ? 'Rallar WS subscription cleared.'
                    : 'No Rallar WS subscription was active.',
            }),
        );
    };

    const createTicket = async (): Promise<void> => {
        setBusyAction('Create WS ticket');
        setLocalError(undefined);
        const label = 'Create WS ticket';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                '/api/auth/ws-ticket',
                'Requesting a WebSocket ticket.',
            ),
        );
        try {
            const nextTicket = await requestWsTicket();
            recordWebSocketEvent(
                'rallar.direct.raw_ws.ticket.created',
                {
                    sessionId: nextTicket.sessionId,
                    expiresAtEpochMs: nextTicket.expiresAtEpochMs,
                    ticket: '<redacted:ws-ticket>',
                },
                'Create WS ticket',
            );
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: '/api/auth/ws-ticket',
                    ok: true,
                    status: 'created',
                    message: `Ticket expires at ${formatTime(nextTicket.expiresAtEpochMs)}.`,
                }),
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: '/api/auth/ws-ticket',
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const waitForMessage = async (): Promise<void> => {
        const startCount = diagnostics.inboundCount;
        const startedAt = Date.now();
        const label = 'Wait for WS message';
        setWaitStatus('waiting');
        setBusyAction(label);
        setLocalError(undefined);
        setActionFeedback(
            runningActionFeedback(
                label,
                values.connection,
                `Waiting up to ${formatDuration(values.timeoutMs)} for inbound WS traffic.`,
            ),
        );
        try {
            await new Promise<void>((resolve, reject) => {
                const interval = window.setInterval(() => {
                    const latest = deriveWebSocketDiagnostics(
                        stateRef.current,
                        values.connection,
                    );
                    if (latest.inboundCount > startCount) {
                        window.clearInterval(interval);
                        resolve();
                        return;
                    }
                    if (Date.now() - startedAt > values.timeoutMs) {
                        window.clearInterval(interval);
                        reject(
                            new Error(
                                'Timed out waiting for WebSocket message.',
                            ),
                        );
                    }
                }, 100);
            });
            setWaitStatus('message observed');
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs: startedAt,
                    target: values.connection,
                    ok: true,
                    status: 'observed',
                    message: 'A WebSocket message was observed.',
                }),
            );
        } catch (error) {
            setWaitStatus('timeout');
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs: startedAt,
                    target: values.connection,
                    ok: false,
                    statusText: 'timeout',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const waitForRallarWsOpen = async (): Promise<void> => {
        setBusyAction('Wait for Rallar WS open');
        setLocalError(undefined);
        const label = 'Wait for Rallar WS open';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                values.apiBaseUrl,
                'Starting Rallar signaling and waiting for WS open.',
            ),
        );
        try {
            if (providerMode !== 'browser-rallar') {
                throw new Error(
                    'Rallar WS wait requires provider=browser-rallar.',
                );
            }
            if (!authSession) {
                throw new Error(
                    'Rallar WS wait requires a logged-in browser session.',
                );
            }
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: values.apiBaseUrl });
            facade.setDefaults({
                applicationId: values.applicationId,
                workspaceId: values.workspaceId,
                room: values.groupId
                    ? {
                          roomId: values.groupId,
                          roomRef: {
                              applicationId: values.applicationId,
                              workspaceId: values.workspaceId,
                              groupId: values.groupId,
                          },
                      }
                    : undefined,
            });
            await facade.start({
                connect: true,
                refreshRooms: false,
                refreshPeople: false,
                timeoutMs: values.timeoutMs,
            });
            const result = await facade.ws.waitForOpen({
                timeoutMs: values.timeoutMs,
            });
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                createDirectRallarRuntimeEvent({
                    topic:
                        result.status === 'open'
                            ? 'rallar.direct.ws.wait_open.completed'
                            : 'rallar.direct.ws.wait_open.failed',
                    context: {
                        providerMode,
                        apiBaseUrl: values.apiBaseUrl,
                        applicationId: values.applicationId,
                        workspaceId: values.workspaceId,
                        roomId: values.groupId,
                        actor:
                            authSession.username ??
                            authSession.clientId ??
                            bootstrap.actor,
                        connection: values.connection,
                        authSession,
                        timeoutMs: values.timeoutMs,
                    },
                    transport: 'ws',
                    severity: result.status === 'open' ? 'info' : 'error',
                    payload: result,
                }),
                result.status === 'open'
                    ? 'Rallar WS open observed'
                    : 'Rallar WS open wait failed',
            );
            setWaitStatus(
                result.status === 'open' ? 'rallar ws open' : result.status,
            );
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.apiBaseUrl,
                    ok: result.status === 'open',
                    status: result.status,
                    message:
                        result.status === 'open'
                            ? 'Rallar signaling WebSocket is open.'
                            : 'Rallar signaling WebSocket did not open.',
                }),
            );
        } catch (error) {
            setWaitStatus('rallar ws wait failed');
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.apiBaseUrl,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    values,
                    diagnostics,
                    subscription: subscription
                        ? {
                              label: subscription.label,
                              destination: subscription.destination,
                              groupId: subscription.groupId,
                              subscribedAtEpochMs:
                                  subscription.subscribedAtEpochMs,
                          }
                        : undefined,
                    ticket: ticket
                        ? {
                              ...ticket,
                              ticket: '<redacted:ws-ticket>',
                              expiresInMs: ticket.expiresAtEpochMs - Date.now(),
                          }
                        : undefined,
                    waitStatus,
                },
                state,
                authSession,
            ),
        );
    };

    const copyRecipe = (includeRtcParity = false): void => {
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }
        void navigator.clipboard?.writeText(
            webSocketCommandCenterRecipe({
                values,
                payload: payloadResult.value,
                bootstrap,
                providerMode,
                authSession,
                sequence,
                includeRtcParity,
            }),
        );
    };

    const openMissingTicket = (): Promise<void> =>
        open('{config.wsBaseUrl}/api/ws/{auth.sessionId}', {
            useTicket: false,
        });

    return (
        <section className="panel websocket-command-center-panel">
            <div className="panel-heading">
                <h2>WebSocket Command Center</h2>
                <span
                    className={`pill ${diagnostics.status === 'error' ? 'bad' : diagnostics.status === 'open' ? 'good' : 'muted'}`}
                >
                    {diagnostics.statusLabel}
                </span>
            </div>
            <CollapsiblePanelSection
                title="WebSocket Inputs"
                meta={routePreview.destination}
            >
                <div className="websocket-context-grid">
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={values.apiBaseUrl}
                            onChange={(event) =>
                                updateValue('apiBaseUrl', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Connection</span>
                        <input
                            value={values.connection}
                            onChange={(event) =>
                                updateValue('connection', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Application</span>
                        <input
                            value={values.applicationId}
                            onChange={(event) =>
                                updateValue('applicationId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Workspace</span>
                        <input
                            value={values.workspaceId}
                            onChange={(event) =>
                                updateValue('workspaceId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Group</span>
                        <input
                            value={values.groupId}
                            onChange={(event) =>
                                updateGroupId(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>WS Scope</span>
                        <select
                            value={values.wsScope}
                            onChange={(event) =>
                                updateWsScope(
                                    event.target
                                        .value as WebSocketCommandCenterValues['wsScope'],
                                )
                            }
                        >
                            <option value="room">room</option>
                            <option value="all">all</option>
                            <option value="world">world</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Type ID</span>
                        <input
                            value={values.typeId}
                            onChange={(event) =>
                                updateValue('typeId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Topic ID</span>
                        <input
                            value={values.topicId}
                            onChange={(event) =>
                                updateValue('topicId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Context ID</span>
                        <input
                            value={values.contextId}
                            onChange={(event) =>
                                updateValue('contextId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Resource ID</span>
                        <input
                            value={values.resourceId}
                            onChange={(event) =>
                                updateValue('resourceId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field websocket-url-field">
                        <span>WebSocket URL</span>
                        <input
                            value={values.wsUrl}
                            onChange={(event) =>
                                updateValue('wsUrl', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Protocols</span>
                        <input
                            value={values.protocols}
                            onChange={(event) =>
                                updateValue('protocols', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Timeout</span>
                        <input
                            type="number"
                            min={0}
                            value={values.timeoutMs}
                            onChange={(event) =>
                                updateValue(
                                    'timeoutMs',
                                    Number(event.target.value),
                                )
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Close Code</span>
                        <input
                            type="number"
                            value={values.closeCode}
                            onChange={(event) =>
                                updateValue(
                                    'closeCode',
                                    Number(event.target.value),
                                )
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Close Reason</span>
                        <input
                            value={values.closeReason}
                            onChange={(event) =>
                                updateValue('closeReason', event.target.value)
                            }
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <CommandCenterActionFeedbackPanel
                feedback={actionFeedback}
                state={state}
                authSession={authSession}
            />
            <div
                className="command-center-live-grid"
                aria-label="WebSocket live subscription status"
            >
                <Metric
                    label="WS subscribed"
                    value={subscription ? 'yes' : 'no'}
                    tone={subscription ? 'good' : 'warn'}
                />
                <Metric
                    label="Subscribed group"
                    value={subscription?.groupId || '-'}
                />
                <Metric
                    label="Subscribed selector"
                    value={subscription?.label ?? '-'}
                />
                <Metric
                    label="Subscribed since"
                    value={formatTime(subscription?.subscribedAtEpochMs)}
                />
                <Metric
                    label="Signal WS"
                    value={browserStatus.signalingLabel}
                    tone={browserStatus.signalingTone}
                />
                <Metric
                    label="Raw WS"
                    value={diagnostics.statusLabel}
                    tone={
                        diagnostics.status === 'open'
                            ? 'good'
                            : diagnostics.status === 'error'
                              ? 'bad'
                              : 'muted'
                    }
                />
            </div>
            <div className="websocket-action-section">
                <div className="section-heading">
                    <h3>Rallar WS Messages</h3>
                    <span>rallar.messages.ws</span>
                </div>
                <div className="websocket-action-grid">
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void send()}
                    >
                        {routePreview.sendLabel}
                    </button>
                    <button
                        type="button"
                        disabled={
                            busy ||
                            Boolean(busyAction) ||
                            providerMode !== 'browser-rallar' ||
                            !authSession
                        }
                        onClick={() => void subscribeWs()}
                    >
                        Subscribe WS
                    </button>
                    <button
                        type="button"
                        disabled={!subscription}
                        onClick={unsubscribeWs}
                    >
                        Unsubscribe WS
                    </button>
                    <button
                        type="button"
                        disabled={
                            busy ||
                            Boolean(busyAction) ||
                            providerMode !== 'browser-rallar' ||
                            !authSession
                        }
                        onClick={() => void waitForRallarWsOpen()}
                    >
                        Wait Rallar WS open
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void waitForMessage()}
                    >
                        Wait for message
                    </button>
                    <button type="button" onClick={() => copyRecipe(false)}>
                        Copy WS recipe
                    </button>
                    <button type="button" onClick={() => copyRecipe(true)}>
                        Copy WS/RTC compare recipe
                    </button>
                </div>
            </div>
            <div className="websocket-action-section">
                <div className="section-heading">
                    <h3>Raw WebSocket Diagnostics</h3>
                    <span>ticket/socket checks</span>
                </div>
                <div className="websocket-action-grid">
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void configure()}
                    >
                        Configure WS
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction) || !authSession}
                        onClick={() => void createTicket()}
                    >
                        Create WS ticket
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void open()}
                    >
                        Open
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() =>
                            void open(defaultWebSocketApiUrl(values.apiBaseUrl))
                        }
                    >
                        Open API WS
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void reconnect()}
                    >
                        Reconnect
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void close()}
                    >
                        Close
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void cleanup()}
                    >
                        Cleanup
                    </button>
                    <button
                        type="button"
                        disabled={busy || Boolean(busyAction)}
                        onClick={() => void openMissingTicket()}
                    >
                        Missing ticket open
                    </button>
                    <button type="button" onClick={copyDiagnostics}>
                        Copy diagnostics
                    </button>
                </div>
            </div>
            <CollapsiblePanelSection
                title="WebSocket Payload"
                meta={activePreset.label}
            >
                <div className="websocket-payload-grid">
                    <label className="field">
                        <span>Payload Preset</span>
                        <select
                            value={payloadPresetId}
                            onChange={(event) =>
                                selectPayloadPreset(event.target.value)
                            }
                        >
                            {WEBSOCKET_PAYLOAD_PRESETS.map((preset) => (
                                <option
                                    key={preset.presetId}
                                    value={preset.presetId}
                                >
                                    {preset.label}
                                </option>
                            ))}
                        </select>
                        <small>{activePreset.description}</small>
                    </label>
                    <label className="json-editor">
                        <span>Payload JSON</span>
                        <textarea
                            value={values.payloadText}
                            onChange={(event) =>
                                updateValue('payloadText', event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div
                className="websocket-route-preview"
                aria-label="WebSocket route preview"
            >
                <div>
                    <span>Destination</span>
                    <strong>{routePreview.destination}</strong>
                    <small>{routePreview.destinationDetail}</small>
                </div>
                <div>
                    <span>Selector</span>
                    <strong>{routePreview.selector}</strong>
                    <small>{routePreview.selectorDetail}</small>
                </div>
                <div>
                    <span>Transport</span>
                    <strong>{routePreview.transport}</strong>
                    <small>{routePreview.transportDetail}</small>
                </div>
            </div>
            <div
                className="websocket-received-panel"
                aria-label="Received WebSocket messages"
            >
                <div className="websocket-received-heading">
                    <div>
                        <h3>Received WS Messages</h3>
                        <p>{receiveStatusText}</p>
                    </div>
                    <span className={`pill ${subscriptionStatusTone}`}>
                        {subscriptionStatusLabel}
                    </span>
                </div>
                <div className="websocket-received-summary">
                    <Metric
                        label="Listening group"
                        value={subscription?.groupId || '-'}
                    />
                    <Metric
                        label="Listening selector"
                        value={subscription?.label ?? '-'}
                    />
                    <Metric
                        label="Received"
                        value={String(diagnostics.receivedMessages.length)}
                    />
                    <Metric
                        label="Listening since"
                        value={formatTime(subscription?.subscribedAtEpochMs)}
                    />
                    <Metric
                        label="Last received"
                        value={formatTime(
                            diagnostics.receivedMessages.at(-1)?.atEpochMs,
                        )}
                    />
                </div>
                <div className="websocket-received-list">
                    {diagnostics.receivedMessages.length === 0 && (
                        <div className="empty-state">
                            No received WebSocket messages
                        </div>
                    )}
                    {diagnostics.receivedMessages
                        .slice()
                        .reverse()
                        .map((message) => (
                            <article
                                className="websocket-received-row"
                                key={message.eventId}
                            >
                                <div>
                                    <strong>
                                        {message.topicId} / {message.typeId}
                                    </strong>
                                    <small>
                                        {formatTime(message.atEpochMs)} - group{' '}
                                        {message.roomId} - sender{' '}
                                        {message.senderId}
                                    </small>
                                    <small>
                                        context {message.contextId} - resource{' '}
                                        {message.resourceId}
                                    </small>
                                </div>
                                <pre className="mini-json">
                                    {redactedJson(
                                        message.payload,
                                        state,
                                        authSession,
                                    )}
                                </pre>
                            </article>
                        ))}
                </div>
            </div>
            <div className="websocket-status-grid">
                <Metric label="Provider" value={providerMode} />
                <Metric
                    label="Raw WS"
                    value={diagnostics.statusLabel}
                    tone={
                        diagnostics.status === 'open'
                            ? 'good'
                            : diagnostics.status === 'error'
                              ? 'bad'
                              : 'muted'
                    }
                />
                <Metric
                    label="Signal WS"
                    value={browserStatus.signalingLabel}
                    tone={browserStatus.signalingTone}
                />
                <Metric
                    label="Rallar WS send"
                    value={
                        canSendViaRallarSignaling ||
                        diagnostics.status === 'open'
                            ? 'available'
                            : '-'
                    }
                    tone={
                        canSendViaRallarSignaling ||
                        diagnostics.status === 'open'
                            ? 'good'
                            : 'muted'
                    }
                />
                <Metric
                    label="Raw ready state"
                    value={diagnostics.readyState}
                />
                <Metric
                    label="Inbound"
                    value={String(diagnostics.inboundCount)}
                />
                <Metric
                    label="Outbound"
                    value={String(diagnostics.outboundCount)}
                />
                <Metric
                    label="Errors"
                    value={String(diagnostics.errorCount)}
                    tone={diagnostics.errorCount > 0 ? 'bad' : 'good'}
                />
                <Metric label="Wait" value={waitStatus} />
                <Metric label="Group" value={values.groupId || '-'} />
                <Metric
                    label="Selector"
                    value={`${values.topicId || '*'} / ${values.typeId || '-'}`}
                />
                <Metric
                    label="Subscription"
                    value={subscription?.label ?? '-'}
                />
                <Metric label="Ticket" value={ticket ? 'redacted' : '-'} />
                <Metric
                    label="Ticket expires"
                    value={formatTime(ticket?.expiresAtEpochMs)}
                />
                <Metric
                    label="Last open"
                    value={formatTime(diagnostics.lastOpenAtEpochMs)}
                />
                <Metric
                    label="Last close"
                    value={formatTime(diagnostics.lastCloseAtEpochMs)}
                />
                <Metric
                    label="Close code"
                    value={String(diagnostics.closeCode ?? '-')}
                />
                <Metric
                    label="Close reason"
                    value={String(diagnostics.closeReason ?? '-')}
                />
            </div>
            {(localError || !payloadResult.ok) && (
                <div
                    className={
                        localError || !payloadResult.ok
                            ? 'workbench-error'
                            : 'command-center-status'
                    }
                    role="status"
                >
                    {localError ??
                        (!payloadResult.ok ? payloadResult.error : undefined)}
                </div>
            )}
            {canSendViaRallarSignaling && !localError && (
                <div className="command-center-status" role="status">
                    Send JSON uses rallar.messages.ws.send and connects Rallar
                    signaling if needed. Open is only for raw WebSocket checks.
                </div>
            )}
            <div className="websocket-event-log-heading">
                <h3>WebSocket Event Log</h3>
                <span>{diagnostics.recentEvents.length} recent</span>
            </div>
            <div className="websocket-event-list">
                {diagnostics.recentEvents.length === 0 && (
                    <div className="empty-state">No WebSocket events yet</div>
                )}
                {diagnostics.recentEvents
                    .slice()
                    .reverse()
                    .map((event) => (
                        <article
                            className="websocket-event-row"
                            key={event.eventId}
                        >
                            <div>
                                <strong>{event.topic}</strong>
                                <small>
                                    {formatTime(event.atEpochMs)} - {event.kind}
                                </small>
                            </div>
                            <span
                                className={`pill ${event.severity === 'error' ? 'bad' : event.kind === 'message' ? 'good' : 'muted'}`}
                            >
                                {event.severity}
                            </span>
                            <pre className="mini-json">
                                {redactedJson(
                                    event.payload,
                                    state,
                                    authSession,
                                )}
                            </pre>
                        </article>
                    ))}
            </div>
        </section>
    );
}

function RtcRealtimePanel({
    state,
    bootstrap,
    authSession,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [transport, setTransport] =
        useState<RtcRealtimeTransport>('realtime');
    const [laneId, setLaneId] = useState('realtime');
    const [peerIdsText, setPeerIdsText] = useState('');
    const [typeId, setTypeId] = useState('room.manual.message');
    const [topicId, setTopicId] = useState('room.manual.message');
    const [contextId, setContextId] = useState(globalValues.roomId || 'room');
    const [payloadText, setPayloadText] = useState(() =>
        json({
            text: 'hello from direct RTC/Realtimes',
            seq: 1,
        }),
    );
    const [minSnapshotVersion, setMinSnapshotVersion] = useState('');
    const [reliability, setReliability] = useState<
        'best-effort' | 'at-least-once'
    >('best-effort');
    const [ack, setAck] = useState<
        'none' | 'receiver' | 'all-logical-recipients' | 'group-leader'
    >('none');
    const [ownership, setOwnership] = useState<'shared' | 'exclusive'>(
        'shared',
    );
    const [timeoutMs, setTimeoutMs] = useState<number>(
        RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
    );
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [actionFeedback, setActionFeedback] =
        useState<CommandCenterActionFeedback>(() =>
            idleActionFeedback(
                'Run an RTC/Realtimes operation to see action status.',
            ),
        );
    const [result, setResult] = useState<unknown>();
    const [received, setReceived] = useState<readonly RtcRealtimeReceivedRow[]>(
        [],
    );
    const [health, setHealth] = useState<unknown>();
    const [subscriptions, setSubscriptions] = useState<
        readonly RtcRealtimeSubscriptionRow[]
    >([]);
    const subscriptionsRef = useRef<readonly RtcRealtimeSubscriptionRow[]>([]);
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const activeGroupId = globalValues.roomId.trim();
    const peerIds = splitCsvValues(peerIdsText);
    const canRun = realBackendReady && Boolean(authSession) && !busyAction;

    useEffect(() => {
        setContextId((current) =>
            current && current !== 'room'
                ? current
                : globalValues.roomId || 'room',
        );
    }, [globalValues.roomId]);

    useEffect(
        () => () => {
            subscriptionsRef.current.forEach((subscription) =>
                subscription.unsubscribe(),
            );
            subscriptionsRef.current = [];
        },
        [],
    );

    const context = () => ({
        providerMode,
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        roomId: activeGroupId,
        actor:
            authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: 'rtc-realtime',
        authSession,
        timeoutMs,
    });

    const recordDirectEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction?: string,
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: context(),
                transport,
                severity,
                payload,
            }),
            lastAction,
        );
    };

    const nowMs = (): number =>
        typeof performance === 'undefined' ? Date.now() : performance.now();

    const recordPhase = (
        phase: string,
        severity: RallarBlackBoxTestSeverity,
        payload: Record<string, unknown>,
    ): void => {
        recordDirectEvent('rallar.direct.rtc_realtime.phase', severity, {
            phase,
            ...payload,
        });
    };

    const runTimedPhase = async <T,>(
        phase: string,
        action: () => Promise<T> | T,
        details: Record<string, unknown> = {},
    ): Promise<T> => {
        const startedAtMs = nowMs();
        try {
            const value = await action();
            recordPhase(phase, 'info', {
                ...details,
                status: 'ok',
                durationMs: Math.round((nowMs() - startedAtMs) * 100) / 100,
            });
            return value;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            recordPhase(phase, 'error', {
                ...details,
                status: 'error',
                durationMs: Math.round((nowMs() - startedAtMs) * 100) / 100,
                error: message,
            });
            throw error;
        }
    };

    const isFacadeJoinedToActiveGroup = (
        facade: BrowserRallarFacade,
    ): boolean => {
        if (!activeGroupId || !authSession?.sessionId) {
            return false;
        }

        const snapshot = optionalRecord(facade.rooms.current());
        const group = optionalRecord(snapshot.group);
        const groupId = stringValue(group.groupId ?? snapshot.groupId);
        if (groupId !== activeGroupId) {
            return false;
        }

        return recordArray(snapshot.activeSessions).some(
            (session) =>
                stringValue(session.sessionId) === authSession.sessionId,
        );
    };

    const ensureActiveGroupJoined = async (
        facade: BrowserRallarFacade,
    ): Promise<void> => {
        if (!activeGroupId) {
            return;
        }

        if (isFacadeJoinedToActiveGroup(facade)) {
            recordPhase('join', 'info', {
                status: 'skipped',
                groupId: activeGroupId,
                reason: 'current browser session is already active in the group',
            });
            return;
        }

        await runTimedPhase(
            'join',
            () =>
                facade.rooms.join(activeGroupId, {
                    scope: {
                        applicationId: globalValues.applicationId,
                        workspaceId: globalValues.workspaceId,
                    },
                    timeoutMs,
                }),
            {
                groupId: activeGroupId,
            },
        );
    };

    const withFacade = async <T,>(
        actionLabel: string,
        action: (facade: BrowserRallarFacade) => Promise<T>,
    ): Promise<T> => {
        if (!realBackendReady) {
            throw new Error('RTC/Realtimes requires provider=browser-rallar.');
        }
        if (!authSession) {
            throw new Error(
                'RTC/Realtimes requires a logged-in browser session.',
            );
        }
        const facade = await runTimedPhase('load-facade', () =>
            loadBrowserRallarFacade(),
        );
        await runTimedPhase('configure', () => {
            configureDirectRallarFacade(facade, context());
        });
        await runTimedPhase('start', () =>
            facade.start({
                connect: true,
                refreshRooms: false,
                refreshPeople: false,
                timeoutMs,
            }),
        );
        await ensureActiveGroupJoined(facade);
        return await runTimedPhase(actionLabel, () => action(facade));
    };

    const runAction = async (
        label: string,
        action: () => Promise<unknown>,
    ): Promise<void> => {
        setBusyAction(label);
        setLocalError(undefined);
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                `${activeGroupId || '-'} / ${transport}`,
                'Calling the browser Rallar facade.',
            ),
        );
        try {
            const nextResult = await action();
            setResult(nextResult);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: `${activeGroupId || '-'} / ${transport}`,
                    ok: true,
                    status: 'completed',
                    message: `${label} completed.`,
                }),
            );
            recordDirectEvent(
                `rallar.direct.${transport}.${label.toLowerCase().replaceAll(' ', '_')}.completed`,
                'info',
                nextResult,
                `${label} completed`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: `${activeGroupId || '-'} / ${transport}`,
                    ok: false,
                    statusText: 'error',
                    message,
                }),
            );
            recordDirectEvent(
                `rallar.direct.${transport}.${label.toLowerCase().replaceAll(' ', '_')}.failed`,
                'error',
                { error: message },
                `${label} failed`,
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const addSubscription = (
        subscription: RtcRealtimeSubscriptionRow,
    ): void => {
        subscriptionsRef.current
            .filter(
                (entry) => entry.subscriptionId === subscription.subscriptionId,
            )
            .forEach((entry) => entry.unsubscribe());
        subscriptionsRef.current = [
            ...subscriptionsRef.current.filter(
                (entry) => entry.subscriptionId !== subscription.subscriptionId,
            ),
            subscription,
        ];
        setSubscriptions(subscriptionsRef.current);
    };

    const addReceived = (row: RtcRealtimeReceivedRow): void => {
        setReceived((current) => [...current, row].slice(-50));
        recordDirectEvent(
            'rallar.direct.rtc_realtime.message',
            'info',
            row,
            'RTC/Realtimes message received',
        );
    };

    const subscribeRealtime = (): Promise<void> =>
        runAction('Subscribe realtime', async () => {
            return await withFacade('subscribe-realtime', async (facade) => {
                const unsubscribe = facade.realtime.onJson<unknown>(
                    laneId,
                    (message) => {
                        addReceived({
                            rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            atEpochMs: message.receivedAtEpochMs,
                            transport: 'realtime',
                            peerId: message.peerId,
                            laneId: message.laneId,
                            roomId: activeGroupId || '-',
                            typeId: '-',
                            topicId: '-',
                            contextId: activeGroupId || '-',
                            payload: message.data,
                            raw: message,
                        });
                    },
                );
                addSubscription({
                    subscriptionId: `realtime:${activeGroupId || '-'}:${laneId || '-'}`,
                    transport: 'realtime',
                    label: `lane ${laneId || '-'}`,
                    laneId,
                    groupId: activeGroupId || '-',
                    subscribedAtEpochMs: Date.now(),
                    unsubscribe,
                });
                return {
                    subscribed: 'realtime',
                    laneId,
                };
            });
        });

    const subscribeRtcMessages = (): Promise<void> =>
        runAction('Subscribe RTC messages', async () => {
            return await withFacade(
                'subscribe-rtc-messages',
                async (facade) => {
                    const selector = {
                        typeId,
                        ...(topicId ? { topicId } : {}),
                    };
                    const unsubscribe = facade.messages.rtc.onMessage(
                        selector,
                        (message) => {
                            const record = optionalRecord(message);
                            addReceived({
                                rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                                atEpochMs: Date.now(),
                                transport: 'messages.rtc',
                                peerId: String(
                                    record.senderId ?? record.peerId ?? '-',
                                ),
                                laneId,
                                roomId: String(
                                    record.roomId ?? activeGroupId ?? '-',
                                ),
                                typeId: String(record.typeId ?? typeId),
                                topicId: String(record.topicId ?? topicId),
                                contextId: String(
                                    record.contextId ?? contextId,
                                ),
                                payload: record.payload ?? message,
                                raw: message,
                            });
                        },
                    );
                    addSubscription({
                        subscriptionId: `messages.rtc:${activeGroupId || '-'}:${topicId || '*'}:${typeId}`,
                        transport: 'messages.rtc',
                        label: `${topicId || '*'} / ${typeId}`,
                        laneId,
                        groupId: activeGroupId || '-',
                        subscribedAtEpochMs: Date.now(),
                        unsubscribe,
                    });
                    return {
                        subscribed: 'messages.rtc',
                        selector,
                    };
                },
            );
        });

    const clearSubscriptions = (): void => {
        const startedAtEpochMs = Date.now();
        subscriptionsRef.current.forEach((subscription) =>
            subscription.unsubscribe(),
        );
        subscriptionsRef.current = [];
        setSubscriptions([]);
        setActionFeedback(
            completedActionFeedback({
                label: 'Clear RTC/Realtimes subscriptions',
                startedAtEpochMs,
                target: activeGroupId || '-',
                ok: true,
                status: 'cleared',
                message: 'RTC/Realtimes subscriptions cleared.',
            }),
        );
        recordDirectEvent(
            'rallar.direct.rtc_realtime.unsubscribe.completed',
            'info',
            {},
            'RTC/Realtimes subscriptions cleared',
        );
    };

    const sendRealtime = (): Promise<void> =>
        runAction('Send realtime JSON', async () => {
            const payload = parseJsonText(payloadText, {});
            return await withFacade(
                'send-realtime-json',
                async (facade) =>
                    await facade.realtime.sendJson({
                        data: payload,
                        laneId,
                        roomId: activeGroupId,
                        roomRef: activeGroupId
                            ? {
                                  applicationId: globalValues.applicationId,
                                  workspaceId: globalValues.workspaceId,
                                  groupId: activeGroupId,
                              }
                            : undefined,
                        peerIds: peerIds.length > 0 ? peerIds : undefined,
                        openTimeoutMs: timeoutMs,
                    }),
            );
        });

    const sendRtcMessage = (): Promise<void> =>
        runAction('Send RTC message', async () => {
            const payload = parseJsonText(payloadText, {});
            return await withFacade(
                'send-rtc-message',
                async (facade) =>
                    await facade.messages.rtc.send({
                        roomId: activeGroupId,
                        roomRef: activeGroupId
                            ? {
                                  applicationId: globalValues.applicationId,
                                  workspaceId: globalValues.workspaceId,
                                  groupId: activeGroupId,
                              }
                            : undefined,
                        typeId,
                        topicId,
                        contextId: contextId || activeGroupId || typeId,
                        payload,
                        minSnapshotVersion: minSnapshotVersion.trim()
                            ? Number(minSnapshotVersion)
                            : undefined,
                        reliability,
                        ack,
                        ownership,
                        nextHopPeerIds:
                            peerIds.length > 0 ? peerIds : undefined,
                        overlayId: activeGroupId || undefined,
                    }),
            );
        });

    const waitForRoomLane = (): Promise<void> =>
        runAction(
            'Wait room lane',
            async () =>
                await withFacade(
                    'wait-room-lane',
                    async (facade) =>
                        await facade.rtc.waitForRoomLane(
                            {
                                applicationId: globalValues.applicationId,
                                workspaceId: globalValues.workspaceId,
                                groupId: activeGroupId,
                            },
                            laneId,
                            { timeoutMs },
                        ),
                ),
        );

    const refreshHealth = (): Promise<void> =>
        runAction('Refresh lane health', async () => {
            return await withFacade('refresh-lane-health', async (facade) => {
                const nextHealth = facade.realtime.health({
                    peerIds: peerIds.length > 0 ? peerIds : undefined,
                    laneIds: laneId ? [laneId] : undefined,
                });
                setHealth(nextHealth);
                return nextHealth;
            });
        });

    const copyRecipe = (): void => {
        const payload = (() => {
            try {
                return parseJsonText(payloadText, {});
            } catch {
                return {};
            }
        })();
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    recipeId: 'rallar-direct-rtc-realtime-export',
                    name: 'Direct RTC/Realtimes export from Rallar Black Box',
                    requirements: [
                        'provider=browser-rallar',
                        'logged-in browser session',
                        'joined group with RTC signaling available',
                    ],
                    commands: [
                        {
                            kind: 'rtc.connect',
                            commandId: 'rtc-realtime-connect',
                            roomId: activeGroupId,
                            transport,
                            timeoutMs,
                            rallar: {
                                applicationId: globalValues.applicationId,
                                workspaceId: globalValues.workspaceId,
                                roomRef: {
                                    applicationId: globalValues.applicationId,
                                    workspaceId: globalValues.workspaceId,
                                    groupId: activeGroupId,
                                },
                            },
                        },
                        {
                            kind: 'rtc.send',
                            commandId: 'rtc-realtime-send',
                            roomId: activeGroupId,
                            transport,
                            send: payload,
                            targetClient: peerIds[0],
                            rallar: {
                                typeId,
                                topicId,
                                contextId,
                                laneId,
                            },
                            timeoutMs,
                        },
                    ],
                },
                state,
                authSession,
            ),
        );
    };

    return (
        <section
            className="panel rtc-realtime-panel"
            aria-label="RTC/Realtimes"
        >
            <div className="panel-heading">
                <h2>RTC/Realtimes</h2>
                <span className={`pill ${realBackendReady ? 'good' : 'warn'}`}>
                    {realBackendReady
                        ? 'direct Rallar'
                        : 'real backend required'}
                </span>
            </div>
            <div className="rtc-realtime-summary-grid">
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={realBackendReady ? 'good' : 'warn'}
                />
                <Metric
                    label="Group"
                    value={activeGroupId || '-'}
                    tone={activeGroupId ? 'good' : 'warn'}
                />
                <Metric label="Transport" value={transport} />
                <Metric label="Lane" value={laneId || '-'} />
                <Metric
                    label="Peer targets"
                    value={peerIds.length ? peerIds.join(', ') : 'room/default'}
                />
                <Metric
                    label="Subscriptions"
                    value={String(subscriptions.length)}
                />
                <Metric label="Received" value={String(received.length)} />
            </div>
            <CommandCenterActionFeedbackPanel
                feedback={actionFeedback}
                state={state}
                authSession={authSession}
            />
            <div
                className="command-center-live-grid"
                aria-label="RTC realtime subscription status"
            >
                <Metric
                    label="Realtime sub"
                    value={
                        subscriptions.some(
                            (subscription) =>
                                subscription.transport === 'realtime',
                        )
                            ? 'yes'
                            : 'no'
                    }
                    tone={
                        subscriptions.some(
                            (subscription) =>
                                subscription.transport === 'realtime',
                        )
                            ? 'good'
                            : 'warn'
                    }
                />
                <Metric
                    label="RTC message sub"
                    value={
                        subscriptions.some(
                            (subscription) =>
                                subscription.transport === 'messages.rtc',
                        )
                            ? 'yes'
                            : 'no'
                    }
                    tone={
                        subscriptions.some(
                            (subscription) =>
                                subscription.transport === 'messages.rtc',
                        )
                            ? 'good'
                            : 'warn'
                    }
                />
                <Metric
                    label="Subscribed group"
                    value={subscriptions.at(-1)?.groupId ?? '-'}
                />
                <Metric
                    label="Subscribed lane"
                    value={subscriptions.at(-1)?.laneId ?? '-'}
                />
                <Metric
                    label="Subscribed selector"
                    value={subscriptions.at(-1)?.label ?? '-'}
                />
                <Metric
                    label="Subscribed since"
                    value={formatTime(
                        subscriptions.at(-1)?.subscribedAtEpochMs,
                    )}
                />
            </div>
            <CollapsiblePanelSection
                title="RTC/Realtimes Inputs"
                meta={`${activeGroupId || '-'} / ${transport}`}
            >
                <div className="rtc-realtime-context-grid">
                    <label className="field">
                        <span>Transport</span>
                        <select
                            value={transport}
                            onChange={(event) =>
                                setTransport(
                                    event.target.value as RtcRealtimeTransport,
                                )
                            }
                        >
                            <option value="realtime">realtime.sendJson</option>
                            <option value="messages.rtc">
                                messages.rtc.send
                            </option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Lane ID</span>
                        <input
                            value={laneId}
                            onChange={(event) => setLaneId(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Peer IDs</span>
                        <input
                            value={peerIdsText}
                            onChange={(event) =>
                                setPeerIdsText(event.target.value)
                            }
                            placeholder="comma separated"
                        />
                    </label>
                    <label className="field">
                        <span>Type ID</span>
                        <input
                            value={typeId}
                            onChange={(event) => setTypeId(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Topic ID</span>
                        <input
                            value={topicId}
                            onChange={(event) => setTopicId(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Context ID</span>
                        <input
                            value={contextId}
                            onChange={(event) =>
                                setContextId(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Min Snapshot</span>
                        <input
                            value={minSnapshotVersion}
                            onChange={(event) =>
                                setMinSnapshotVersion(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Timeout</span>
                        <input
                            type="number"
                            min={0}
                            value={timeoutMs}
                            onChange={(event) =>
                                setTimeoutMs(Number(event.target.value))
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Reliability</span>
                        <select
                            value={reliability}
                            onChange={(event) =>
                                setReliability(
                                    event.target.value as typeof reliability,
                                )
                            }
                        >
                            <option value="best-effort">best-effort</option>
                            <option value="at-least-once">at-least-once</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Ack</span>
                        <select
                            value={ack}
                            onChange={(event) =>
                                setAck(event.target.value as typeof ack)
                            }
                        >
                            <option value="none">none</option>
                            <option value="receiver">receiver</option>
                            <option value="all-logical-recipients">
                                all-logical-recipients
                            </option>
                            <option value="group-leader">group-leader</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Ownership</span>
                        <select
                            value={ownership}
                            onChange={(event) =>
                                setOwnership(
                                    event.target.value as typeof ownership,
                                )
                            }
                        >
                            <option value="shared">shared</option>
                            <option value="exclusive">exclusive</option>
                        </select>
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="rtc-realtime-action-grid">
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void subscribeRealtime()}
                >
                    Subscribe realtime
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void subscribeRtcMessages()}
                >
                    Subscribe RTC messages
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void sendRealtime()}
                >
                    Send realtime JSON
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void sendRtcMessage()}
                >
                    Send RTC message
                </button>
                <button
                    type="button"
                    disabled={!canRun || !activeGroupId}
                    onClick={() => void waitForRoomLane()}
                >
                    Wait room lane
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void refreshHealth()}
                >
                    Refresh lane health
                </button>
                <button
                    type="button"
                    disabled={subscriptions.length === 0}
                    onClick={clearSubscriptions}
                >
                    Clear subscriptions
                </button>
                <button type="button" onClick={copyRecipe}>
                    Copy RTC recipe
                </button>
            </div>
            <CollapsiblePanelSection
                title="RTC/Realtimes Payload"
                meta={`${received.length} received`}
            >
                <div className="rtc-realtime-work-grid">
                    <label className="json-editor">
                        <span>Payload JSON</span>
                        <textarea
                            value={payloadText}
                            onChange={(event) =>
                                setPayloadText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <section
                        className="rtc-realtime-received-panel"
                        aria-label="RTC/Realtimes received messages"
                    >
                        <div className="section-heading">
                            <h3>Received Messages</h3>
                            <span>{received.length} rows</span>
                        </div>
                        <div className="websocket-received-list">
                            {received.length === 0 && (
                                <div className="empty-state">
                                    No received RTC/Realtimes messages
                                </div>
                            )}
                            {received
                                .slice()
                                .reverse()
                                .map((message) => (
                                    <article
                                        className="websocket-received-row"
                                        key={message.rowId}
                                    >
                                        <div>
                                            <strong>
                                                {message.transport}{' '}
                                                {message.topicId} /{' '}
                                                {message.typeId}
                                            </strong>
                                            <small>
                                                {formatTime(message.atEpochMs)}{' '}
                                                - peer {message.peerId}
                                            </small>
                                            <small>
                                                group {message.roomId} - lane{' '}
                                                {message.laneId} - context{' '}
                                                {message.contextId}
                                            </small>
                                        </div>
                                        <pre className="mini-json">
                                            {redactedJson(
                                                message.payload,
                                                state,
                                                authSession,
                                            )}
                                        </pre>
                                    </article>
                                ))}
                        </div>
                    </section>
                </div>
            </CollapsiblePanelSection>
            {(localError || !realBackendReady || !authSession) && (
                <div
                    className={
                        localError ? 'workbench-error' : 'command-center-status'
                    }
                    role="status"
                >
                    {localError ??
                        (!realBackendReady
                            ? 'RTC/Realtimes requires provider=browser-rallar.'
                            : !authSession
                              ? 'RTC/Realtimes requires a logged-in browser session.'
                              : undefined)}
                </div>
            )}
            <div className="rtc-realtime-result-grid">
                <section>
                    <div className="section-heading">
                        <h3>Last Result</h3>
                        <span>{busyAction ?? 'idle'}</span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(result ?? {}, state, authSession)}
                    </pre>
                </section>
                <section>
                    <div className="section-heading">
                        <h3>Lane Health</h3>
                        <span>
                            {Array.isArray(health) ? health.length : 0} rows
                        </span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(health ?? [], state, authSession)}
                    </pre>
                </section>
            </div>
        </section>
    );
}

type CrdtAdminDocumentStatus = Readonly<{
    document: Readonly<Record<string, unknown>>;
    documentKey: string;
    lifecycle: string;
    rollout?: string;
    updateCount: number;
    snapshotCount: number;
    lastAppendSequence: number;
    updatedAtEpochMs: number;
    quarantineReason?: string;
}>;

type CrdtAdminListResult = Readonly<{
    documents: readonly CrdtAdminDocumentStatus[];
    hasMore: boolean;
    nextCursor?: string;
}>;

type CrdtEditorDocument = RallarCrdtDocument<
    CrdtEditorValue,
    RallarCrdtOperationBatch
>;

function CrdtEditorPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [documentName, setDocumentName] = useState('black-box-crdt-editor');
    const [documentId, setDocumentId] = useState(() =>
        `crdt-editor-${globalValues.roomId || 'local'}`,
    );
    const [transport, setTransport] =
        useState<CrdtEditorTransport>('local-only');
    const [persist, setPersist] = useState(true);
    const [tabSync, setTabSync] = useState(true);
    const [view, setView] = useState<CrdtEditorView>('board');
    const [newColumnTitle, setNewColumnTitle] = useState('Review');
    const [newCardTitle, setNewCardTitle] = useState('Coordinate move');
    const [selectedColumnId, setSelectedColumnId] =
        useState('column-backlog');
    const [selectedCardId, setSelectedCardId] = useState('card-first');
    const [cardStatus, setCardStatus] = useState('done');
    const [tagLabel, setTagLabel] = useState('needs-sync');
    const [entityId, setEntityId] = useState('entity-player-1');
    const [entityType, setEntityType] = useState('player');
    const [entityX, setEntityX] = useState(4);
    const [entityY, setEntityY] = useState(6);
    const [entityStatus, setEntityStatus] = useState('moving');
    const [entityDelta, setEntityDelta] = useState(5);
    const [cooldownMin, setCooldownMin] = useState(2);
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [opened, setOpened] = useState(false);
    const [value, setValue] = useState<CrdtEditorValue>(() =>
        createCrdtEditorInitialValue(),
    );
    const [health, setHealth] = useState<unknown>();
    const [lastResult, setLastResult] = useState<unknown>();
    const [lastBatch, setLastBatch] = useState<RallarCrdtOperationBatch>();
    const [lastOperationGroupId, setLastOperationGroupId] =
        useState<string>();
    const documentRef = useRef<CrdtEditorDocument | undefined>(undefined);
    const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
    const providerReady = bootstrap.providerMode === 'browser-rallar';
    const canUseLiveTransport = providerReady && Boolean(authSession);
    const canRun =
        !busyAction &&
        (transport === 'local-only' || canUseLiveTransport);
    const columns = value.columns ?? createCrdtEditorInitialValue().columns ?? [];
    const entities =
        value.entities ?? createCrdtEditorInitialValue().entities ?? [];
    const selectedColumn = columns.find(
        (column) => column.id === selectedColumnId,
    );
    const selectedCard =
        selectedColumn?.cards.find((card) => card.id === selectedCardId) ??
        columns.flatMap((column) => column.cards).find(
            (card) => card.id === selectedCardId,
        );

    useEffect(
        () => () => {
            unsubscribeRef.current?.();
            void documentRef.current?.close();
        },
        [],
    );

    const recordCrdtEditorEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction: string,
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: {
                    providerMode: bootstrap.providerMode,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    roomId: globalValues.roomId,
                    actor:
                        authSession?.username ??
                        authSession?.clientId ??
                        bootstrap.actor,
                    connection: 'crdt-editor',
                    authSession,
                    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
                },
                payload: optionalRecord(payload),
                severity,
            }),
            lastAction,
        );
    };

    const loadFacade = async (): Promise<BrowserRallarFacade> => {
        if (transport !== 'local-only' && !providerReady) {
            throw new Error(
                'Live CRDT editor transports require provider=browser-rallar.',
            );
        }
        if (transport !== 'local-only' && !authSession) {
            throw new Error('Login is required for live CRDT transports.');
        }
        const facade = await loadBrowserRallarFacade();
        facade.configure({ apiBaseUrl: globalValues.apiBaseUrl });
        facade.setDefaults({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            room: globalValues.roomId
                ? {
                      roomRef: {
                          applicationId: globalValues.applicationId,
                          workspaceId: globalValues.workspaceId,
                          groupId: globalValues.roomId,
                      },
                  }
                : undefined,
        });
        return facade;
    };

    const openDocument = async (): Promise<CrdtEditorDocument> => {
        if (documentRef.current) {
            return documentRef.current;
        }
        const facade = await loadFacade();
        const document = await facade.crdt.open<
            CrdtEditorValue,
            RallarCrdtOperationBatch
        >(documentName, {
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            documentId,
            documentType: 'black-box-crdt-editor',
            transport: transport as RallarCrdtTransportStrategy,
            persist,
            tabSync,
            actorId:
                authSession?.clientId ??
                authSession?.username ??
                bootstrap.actor,
            sessionId: authSession?.sessionId ?? bootstrap.sessionId,
            initialValue: createCrdtEditorInitialValue(),
        });
        documentRef.current = document;
        unsubscribeRef.current = document.subscribe((snapshot) => {
            setValue(snapshot.value);
            setHealth(document.health());
        });
        setValue(document.read());
        setHealth(document.health());
        setOpened(true);
        setLastResult({
            action: 'open',
            ref: document.ref,
            health: document.health(),
            value: document.read(),
        });
        recordCrdtEditorEvent(
            'rallar.direct.crdt.editor.opened',
            'info',
            {
                document: document.ref,
                transport,
                persist,
                tabSync,
            },
            'CRDT editor opened',
        );
        return document;
    };

    const runEditorAction = async (
        action: string,
        runner: (document: CrdtEditorDocument) => Promise<unknown>,
    ): Promise<void> => {
        setBusyAction(action);
        setError(undefined);
        try {
            const document = await openDocument();
            const result = await runner(document);
            setValue(document.read());
            setHealth(document.health());
            setLastResult(result);
            recordCrdtEditorEvent(
                `rallar.direct.crdt.editor.${action}`,
                'info',
                {
                    document: document.ref,
                    transport,
                    result,
                    health: document.health(),
                },
                `CRDT editor ${action}`,
            );
        } catch (caught) {
            const message =
                caught instanceof Error ? caught.message : String(caught);
            setError(message);
            recordCrdtEditorEvent(
                'rallar.direct.crdt.editor.failed',
                'error',
                {
                    action,
                    error: message,
                    transport,
                },
                `CRDT editor ${action} failed`,
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const applyBatch = async (
        action: string,
        batch: RallarCrdtOperationBatch,
    ): Promise<void> => {
        setLastBatch(batch);
        setLastOperationGroupId(batch.operationGroupId);
        await runEditorAction(action, async (document) => {
            const update = await document.applyLocal(batch);
            return {
                action,
                updateId: update.updateId,
                operationGroupId: batch.operationGroupId,
                operations: batch.operations,
            };
        });
    };

    const closeDocument = async (): Promise<void> => {
        await runEditorAction('close', async (document) => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = undefined;
            await document.close();
            documentRef.current = undefined;
            setOpened(false);
            return { action: 'close', document: document.ref };
        });
    };

    const destroyDocument = async (): Promise<void> => {
        await runEditorAction('destroy', async (document) => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = undefined;
            await document.destroy();
            documentRef.current = undefined;
            setOpened(false);
            setValue(createCrdtEditorInitialValue());
            return { action: 'destroy', document: document.ref };
        });
    };

    return (
        <section className="crdt-editor-panel">
            <div className="section-heading">
                <h3>CRDT Editor</h3>
                <span>{opened ? 'open' : 'closed'}</span>
            </div>
            <div className="metric-row">
                <Metric label="Transport" value={transport} />
                <Metric label="Document" value={documentId} />
                <Metric
                    label="Runtime"
                    value={providerReady ? 'browser-rallar' : 'local import'}
                    tone={providerReady ? 'good' : 'warn'}
                />
                <Metric
                    label="Live Auth"
                    value={canUseLiveTransport ? 'ready' : 'local-only'}
                    tone={
                        transport === 'local-only' || canUseLiveTransport
                            ? 'good'
                            : 'warn'
                    }
                />
            </div>
            <div className="form-grid crdt-editor-controls">
                <label>
                    Document name
                    <input
                        value={documentName}
                        onChange={(event) =>
                            setDocumentName(event.target.value)
                        }
                        disabled={opened}
                    />
                </label>
                <label>
                    Document id
                    <input
                        value={documentId}
                        onChange={(event) => setDocumentId(event.target.value)}
                        disabled={opened}
                    />
                </label>
                <label>
                    Transport
                    <select
                        value={transport}
                        onChange={(event) =>
                            setTransport(
                                event.target.value as CrdtEditorTransport,
                            )
                        }
                        disabled={opened}
                    >
                        {CRDT_EDITOR_TRANSPORTS.map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={persist}
                        onChange={(event) => setPersist(event.target.checked)}
                        disabled={opened}
                    />
                    Persist locally
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={tabSync}
                        onChange={(event) => setTabSync(event.target.checked)}
                        disabled={opened}
                    />
                    Tab sync
                </label>
            </div>
            <div className="button-row">
                <button
                    type="button"
                    disabled={!canRun || opened}
                    onClick={() =>
                        void runEditorAction('open', async (document) => ({
                            action: 'open',
                            document: document.ref,
                            value: document.read(),
                            health: document.health(),
                        }))
                    }
                >
                    Open
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('sync', async (document) => ({
                            action: 'sync',
                            result: await document.sync({
                                reason: 'black-box-crdt-editor',
                                transport,
                            }),
                        }))
                    }
                >
                    Sync
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('read', async (document) => ({
                            action: 'read',
                            value: document.read(),
                            health: document.health(),
                        }))
                    }
                >
                    Read
                </button>
                <button
                    type="button"
                    disabled={!opened || !lastBatch || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('undo', async (document) => ({
                            action: 'undo',
                            update: await document.undoOperationGroup({
                                targetOperationGroupId:
                                    lastOperationGroupId ?? '',
                                operations: lastBatch?.operations ?? [],
                                operationGroupId:
                                    crdtEditorOperationGroupId('undo'),
                            }),
                        }))
                    }
                >
                    Undo
                </button>
                <button
                    type="button"
                    disabled={!opened || !lastBatch || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('redo', async (document) => ({
                            action: 'redo',
                            update: await document.redoOperationGroup({
                                targetOperationGroupId:
                                    lastOperationGroupId ?? '',
                                operations: lastBatch?.operations ?? [],
                                operationGroupId:
                                    crdtEditorOperationGroupId('redo'),
                            }),
                        }))
                    }
                >
                    Redo
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() => void closeDocument()}
                >
                    Close
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() => void destroyDocument()}
                >
                    Destroy
                </button>
            </div>
            {busyAction && (
                <div className="status-line">CRDT editor action: {busyAction}</div>
            )}
            {transport !== 'local-only' && !canUseLiveTransport && (
                <div className="workbench-error" role="status">
                    Live CRDT transports require provider=browser-rallar and a
                    login session. Switch to local-only for offline sandboxing.
                </div>
            )}
            {error && (
                <div className="workbench-error" role="status">
                    {error}
                </div>
            )}
            <div className="button-row segmented-row">
                <button
                    type="button"
                    className={view === 'board' ? 'selected' : ''}
                    onClick={() => setView('board')}
                >
                    Board
                </button>
                <button
                    type="button"
                    className={view === 'entities' ? 'selected' : ''}
                    onClick={() => setView('entities')}
                >
                    Entities
                </button>
            </div>
            {view === 'board' ? (
                <section className="crdt-editor-workbench">
                    <div className="form-grid">
                        <label>
                            Column
                            <select
                                value={selectedColumnId}
                                onChange={(event) =>
                                    setSelectedColumnId(event.target.value)
                                }
                            >
                                {columns.map((column) => (
                                    <option key={column.id} value={column.id}>
                                        {column.title}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            Card
                            <select
                                value={selectedCardId}
                                onChange={(event) =>
                                    setSelectedCardId(event.target.value)
                                }
                            >
                                {columns.flatMap((column) =>
                                    column.cards.map((card) => (
                                        <option key={card.id} value={card.id}>
                                            {card.title}
                                        </option>
                                    )),
                                )}
                            </select>
                        </label>
                        <label>
                            New column
                            <input
                                value={newColumnTitle}
                                onChange={(event) =>
                                    setNewColumnTitle(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            New card
                            <input
                                value={newCardTitle}
                                onChange={(event) =>
                                    setNewCardTitle(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            Card status
                            <input
                                value={cardStatus}
                                onChange={(event) =>
                                    setCardStatus(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            Tag
                            <input
                                value={tagLabel}
                                onChange={(event) =>
                                    setTagLabel(event.target.value)
                                }
                            />
                        </label>
                    </div>
                    <div className="button-row">
                        <button
                            type="button"
                            disabled={!opened || Boolean(busyAction)}
                            onClick={() => {
                                const columnId = `column-${Date.now()}`;
                                setSelectedColumnId(columnId);
                                void applyBatch(
                                    'add-column',
                                    addCrdtEditorColumnBatch({
                                        columnId,
                                        title: newColumnTitle,
                                        positionId: `${columnId}@${Date.now()}`,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'add-column',
                                            ),
                                    }),
                                );
                            }}
                        >
                            Add Column
                        </button>
                        <button
                            type="button"
                            disabled={
                                !opened ||
                                !selectedColumn ||
                                Boolean(busyAction)
                            }
                            onClick={() =>
                                void applyBatch(
                                    'rename-column',
                                    renameCrdtEditorColumnBatch({
                                        columnId: selectedColumnId,
                                        title: newColumnTitle,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'rename-column',
                                            ),
                                    }),
                                )
                            }
                        >
                            Rename Column
                        </button>
                        <button
                            type="button"
                            disabled={
                                !opened ||
                                !selectedColumn ||
                                Boolean(busyAction)
                            }
                            onClick={() => {
                                const cardId = `card-${Date.now()}`;
                                setSelectedCardId(cardId);
                                void applyBatch(
                                    'add-card',
                                    addCrdtEditorCardBatch({
                                        columnId: selectedColumnId,
                                        cardId,
                                        title: newCardTitle,
                                        positionId: `${cardId}@${Date.now()}`,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'add-card',
                                            ),
                                    }),
                                );
                            }}
                        >
                            Add Card
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !selectedCard}
                            onClick={() =>
                                void applyBatch(
                                    'move-card',
                                    moveCrdtEditorCardBatch({
                                        columnId: selectedColumnId,
                                        cardId: selectedCardId,
                                        positionId: `${selectedCardId}@${Date.now()}`,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'move-card',
                                            ),
                                    }),
                                )
                            }
                        >
                            Move Card
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !selectedCard}
                            onClick={() =>
                                void applyBatch(
                                    'set-card-status',
                                    updateCrdtEditorCardStatusBatch({
                                        cardId: selectedCardId,
                                        status: cardStatus,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'card-status',
                                            ),
                                    }),
                                )
                            }
                        >
                            Set Status
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !selectedCard}
                            onClick={() =>
                                void applyBatch(
                                    'delete-card',
                                    deleteCrdtEditorCardBatch({
                                        columnId: selectedColumnId,
                                        cardId: selectedCardId,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'delete-card',
                                            ),
                                    }),
                                )
                            }
                        >
                            Delete Card
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !tagLabel.trim()}
                            onClick={() => {
                                const tagId = `tag-${tagLabel.trim().toLowerCase().replaceAll(/\s+/g, '-')}`;
                                void applyBatch(
                                    'add-tag',
                                    addCrdtEditorTagBatch({
                                        tagId,
                                        label: tagLabel,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'add-tag',
                                            ),
                                    }),
                                );
                            }}
                        >
                            Add Tag
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !tagLabel.trim()}
                            onClick={() => {
                                const tagId = `tag-${tagLabel.trim().toLowerCase().replaceAll(/\s+/g, '-')}`;
                                void applyBatch(
                                    'remove-tag',
                                    removeCrdtEditorTagBatch({
                                        tagId,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'remove-tag',
                                            ),
                                    }),
                                );
                            }}
                        >
                            Remove Tag
                        </button>
                    </div>
                    <div className="crdt-board-preview">
                        {columns.map((column) => (
                            <section key={column.id} className="crdt-board-column">
                                <h4>{column.title}</h4>
                                {column.cards.map((card) => (
                                    <button
                                        key={card.id}
                                        type="button"
                                        className={
                                            selectedCardId === card.id
                                                ? 'crdt-card selected'
                                                : 'crdt-card'
                                        }
                                        onClick={() => {
                                            setSelectedColumnId(column.id);
                                            setSelectedCardId(card.id);
                                        }}
                                    >
                                        <strong>{card.title}</strong>
                                        <span>{card.status}</span>
                                    </button>
                                ))}
                                {column.cards.length === 0 && (
                                    <span className="muted">No cards</span>
                                )}
                            </section>
                        ))}
                    </div>
                </section>
            ) : (
                <section className="crdt-editor-workbench">
                    <div className="form-grid">
                        <label>
                            Entity id
                            <input
                                value={entityId}
                                onChange={(event) =>
                                    setEntityId(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            Type
                            <input
                                value={entityType}
                                onChange={(event) =>
                                    setEntityType(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            X
                            <input
                                type="number"
                                value={entityX}
                                onChange={(event) =>
                                    setEntityX(Number(event.target.value))
                                }
                            />
                        </label>
                        <label>
                            Y
                            <input
                                type="number"
                                value={entityY}
                                onChange={(event) =>
                                    setEntityY(Number(event.target.value))
                                }
                            />
                        </label>
                        <label>
                            Status
                            <input
                                value={entityStatus}
                                onChange={(event) =>
                                    setEntityStatus(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            Delta
                            <input
                                type="number"
                                value={entityDelta}
                                onChange={(event) =>
                                    setEntityDelta(Number(event.target.value))
                                }
                            />
                        </label>
                        <label>
                            Cooldown min
                            <input
                                type="number"
                                value={cooldownMin}
                                onChange={(event) =>
                                    setCooldownMin(Number(event.target.value))
                                }
                            />
                        </label>
                    </div>
                    <div className="button-row">
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'add-entity',
                                    addCrdtEditorEntityBatch({
                                        entityId,
                                        type: entityType,
                                        x: entityX,
                                        y: entityY,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'add-entity',
                                            ),
                                    }),
                                )
                            }
                        >
                            Add Entity
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'update-entity',
                                    updateCrdtEditorEntityBatch({
                                        entityId,
                                        x: entityX,
                                        y: entityY,
                                        status: entityStatus,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'update-entity',
                                            ),
                                    }),
                                )
                            }
                        >
                            Update Entity
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'entity-health',
                                    changeCrdtEditorEntityHealthBatch({
                                        entityId,
                                        delta: entityDelta,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'entity-health',
                                            ),
                                    }),
                                )
                            }
                        >
                            Health Delta
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'entity-score',
                                    addCrdtEditorEntityScoreBatch({
                                        entityId,
                                        delta: entityDelta,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'entity-score',
                                            ),
                                    }),
                                )
                            }
                        >
                            Add Score
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'entity-cooldown-min',
                                    setCrdtEditorCooldownMinBatch({
                                        entityId,
                                        value: cooldownMin,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'cooldown-min',
                                            ),
                                    }),
                                )
                            }
                        >
                            Min Cooldown
                        </button>
                    </div>
                    <div className="table-shell">
                        <table>
                            <thead>
                                <tr>
                                    <th>Entity</th>
                                    <th>Type</th>
                                    <th>Position</th>
                                    <th>Status</th>
                                    <th>Health</th>
                                    <th>Score</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entities.map((entity) => (
                                    <tr
                                        key={entity.id}
                                        className={
                                            entity.id === entityId
                                                ? 'selected'
                                                : ''
                                        }
                                        onClick={() => {
                                            setEntityId(entity.id);
                                            setEntityType(entity.type);
                                            setEntityX(entity.x);
                                            setEntityY(entity.y);
                                            setEntityStatus(entity.status);
                                        }}
                                    >
                                        <td>{entity.id}</td>
                                        <td>{entity.type}</td>
                                        <td>
                                            {entity.x}, {entity.y}
                                        </td>
                                        <td>{entity.status}</td>
                                        <td>{entity.health}</td>
                                        <td>{entity.score}</td>
                                    </tr>
                                ))}
                                {entities.length === 0 && (
                                    <tr>
                                        <td colSpan={6}>No entities.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
            <div className="crdt-editor-diagnostics">
                <section>
                    <div className="section-heading">
                        <h4>Value</h4>
                        <span>{columns.length} columns</span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(value, state, authSession)}
                    </pre>
                </section>
                <section>
                    <div className="section-heading">
                        <h4>Last Result / Health</h4>
                        <span>{lastOperationGroupId ?? 'no group'}</span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(
                            { lastResult, health, lastBatch },
                            state,
                            authSession,
                        )}
                    </pre>
                </section>
            </div>
        </section>
    );
}

function CrdtHealthPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [documents, setDocuments] = useState<
        readonly CrdtAdminDocumentStatus[]
    >([]);
    const [selectedDocumentKey, setSelectedDocumentKey] = useState<
        string | undefined
    >();
    const [lastResult, setLastResult] = useState<unknown>();
    const selectedDocument =
        documents.find(
            (document) => document.documentKey === selectedDocumentKey,
        ) ?? documents[0];
    const providerReady = bootstrap.providerMode === 'browser-rallar';
    const canCallAdmin =
        providerReady && Boolean(authSession?.accessToken) && !busyAction;

    const adminRequestForAction = (
        action: string,
    ): { path: string; body: Record<string, unknown> } | undefined => {
        if (!selectedDocument) {
            return undefined;
        }
        const body = { document: selectedDocument.document };
        switch (action) {
            case 'integrity':
                return { path: '/api/crdt/admin/documents/integrity', body };
            case 'debug-export':
                return {
                    path: '/api/crdt/admin/documents/debug-export',
                    body: { ...body, reason: 'black-box-crdt-health' },
                };
            case 'backup-export':
                return { path: '/api/crdt/admin/documents/backup-export', body };
            case 'compact':
                return {
                    path: '/api/crdt/admin/documents/compact',
                    body: {
                        ...body,
                        reason: 'black-box-crdt-health-compaction',
                    },
                };
            case 'rebuild':
                return {
                    path: '/api/crdt/admin/documents/rebuild-projection',
                    body: { ...body, projectionId: 'black-box-health' },
                };
            case 'archive':
                return {
                    path: '/api/crdt/admin/documents/lifecycle',
                    body: {
                        ...body,
                        lifecycle: 'archived',
                        changedAtEpochMs: Date.now(),
                    },
                };
            case 'destroy':
                return {
                    path: '/api/crdt/admin/documents/erase',
                    body: {
                        ...body,
                        mode: 'destroy-document',
                        reason: 'black-box-crdt-health-destroy',
                    },
                };
            case 'quarantine':
                return {
                    path: '/api/crdt/admin/documents/lifecycle',
                    body: {
                        ...body,
                        lifecycle: 'quarantined',
                        changedAtEpochMs: Date.now(),
                    },
                };
            default:
                return undefined;
        }
    };

    const copyAdminRecipe = (action: string): void => {
        const request = adminRequestForAction(action);
        if (!request) {
            return;
        }
        const recipe = {
            schemaVersion: 1,
            recipeId: `crdt-admin-${action}`,
            name: `CRDT admin ${action}`,
            commands: [
                {
                    kind: 'http.request',
                    commandId: `crdt-admin-${action}`,
                    request: {
                        method: 'POST',
                        url: `${globalValues.apiBaseUrl}${request.path}`,
                        headers: {
                            authorization: 'Bearer ${RALLAR_ADMIN_ACCESS_TOKEN}',
                        },
                        body: request.body,
                    },
                    response: {
                        body: 'json',
                    },
                    timeoutMs: 10_000,
                },
            ],
        };
        void navigator.clipboard?.writeText(json(recipe));
    };

    const callAdmin = async <TResult,>(
        path: string,
        body: unknown,
    ): Promise<TResult> => {
        const response = await fetch(`${globalValues.apiBaseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(authSession?.accessToken
                    ? { authorization: `Bearer ${authSession.accessToken}` }
                    : {}),
            },
            body: JSON.stringify(body),
        });
        const payload = (await response.json()) as {
            ok?: boolean;
            result?: TResult;
            error?: string;
        };
        if (!response.ok || payload.ok === false) {
            throw new Error(
                payload.error ??
                    `CRDT admin request failed with ${response.status}.`,
            );
        }
        return payload.result as TResult;
    };

    const refresh = async (): Promise<void> => {
        setBusyAction('refresh');
        setError(undefined);
        try {
            const result = await callAdmin<CrdtAdminListResult>(
                '/api/crdt/admin/documents/list',
                {
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    limit: 50,
                },
            );
            setDocuments(result.documents);
            setSelectedDocumentKey((current) =>
                current &&
                result.documents.some(
                    (document) => document.documentKey === current,
                )
                    ? current
                    : result.documents[0]?.documentKey,
            );
            setLastResult(result);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const runDocumentAction = async (action: string): Promise<void> => {
        if (!selectedDocument) {
            return;
        }
        setBusyAction(action);
        setError(undefined);
        try {
            const body = { document: selectedDocument.document };
            let result: unknown;
            switch (action) {
                case 'integrity':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/integrity',
                        body,
                    );
                    break;
                case 'debug-export':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/debug-export',
                        {
                            ...body,
                            reason: 'black-box-crdt-health',
                        },
                    );
                    break;
                case 'backup-export':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/backup-export',
                        body,
                    );
                    break;
                case 'compact':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/compact',
                        {
                            ...body,
                            reason: 'black-box-crdt-health-compaction',
                        },
                    );
                    break;
                case 'rebuild':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/rebuild-projection',
                        {
                            ...body,
                            projectionId: 'black-box-health',
                        },
                    );
                    break;
                case 'archive':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/lifecycle',
                        {
                            ...body,
                            lifecycle: 'archived',
                            changedAtEpochMs: Date.now(),
                        },
                    );
                    break;
                case 'destroy':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/erase',
                        {
                            ...body,
                            mode: 'destroy-document',
                            reason: 'black-box-crdt-health-destroy',
                        },
                    );
                    break;
                case 'quarantine':
                default:
                    result = await callAdmin(
                        '/api/crdt/admin/documents/lifecycle',
                        {
                            ...body,
                            lifecycle: 'quarantined',
                            changedAtEpochMs: Date.now(),
                        },
                    );
                    break;
            }
            setLastResult(result);
            if (
                [
                    'archive',
                    'compact',
                    'destroy',
                    'quarantine',
                    'rebuild',
                ].includes(action)
            ) {
                await refresh();
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    return (
        <section className="panel crdt-health-panel">
            <div className="section-heading">
                <h2>CRDT</h2>
                <span>{documents.length} documents</span>
            </div>
            <div className="metric-row">
                <Metric
                    label="Provider"
                    value={bootstrap.providerMode}
                    tone={providerReady ? 'good' : 'warn'}
                />
                <Metric label="API" value={globalValues.apiBaseUrl} />
                <Metric
                    label="Auth"
                    value={authSession ? 'session' : 'missing'}
                    tone={authSession ? 'good' : 'warn'}
                />
                <Metric
                    label="Workspace"
                    value={globalValues.workspaceId || '-'}
                />
            </div>
            <CrdtEditorPanel
                state={state}
                bootstrap={bootstrap}
                authSession={authSession}
                globalValues={globalValues}
            />
            <div className="section-heading">
                <h3>Admin Health</h3>
                <span>durable documents</span>
            </div>
            <div className="button-row">
                <button
                    type="button"
                    disabled={!canCallAdmin}
                    onClick={() => void refresh()}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('integrity')}
                >
                    Integrity
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('debug-export')}
                >
                    Debug Export
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('backup-export')}
                >
                    Backup Export
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('compact')}
                >
                    Compact
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('rebuild')}
                >
                    Rebuild
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('archive')}
                >
                    Archive
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('quarantine')}
                >
                    Quarantine
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('destroy')}
                >
                    Destroy
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('integrity')}
                >
                    Copy Integrity Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('debug-export')}
                >
                    Copy Debug Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('backup-export')}
                >
                    Copy Backup Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('compact')}
                >
                    Copy Compact Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('rebuild')}
                >
                    Copy Rebuild Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('archive')}
                >
                    Copy Archive Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('quarantine')}
                >
                    Copy Quarantine Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('destroy')}
                >
                    Copy Destroy Recipe
                </button>
            </div>
            {busyAction && (
                <div className="status-line">
                    CRDT admin action: {busyAction}
                </div>
            )}
            {!providerReady && (
                <div className="workbench-error" role="status">
                    CRDT admin health requires provider=browser-rallar.
                </div>
            )}
            {providerReady && !authSession && (
                <div className="workbench-error" role="status">
                    Login is required before calling CRDT admin routes.
                </div>
            )}
            {error && (
                <div className="workbench-error" role="status">
                    {error}
                </div>
            )}
            <div className="table-shell">
                <table>
                    <thead>
                        <tr>
                            <th>Document</th>
                            <th>Lifecycle</th>
                            <th>Updates</th>
                            <th>Snapshots</th>
                            <th>Append</th>
                            <th>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        {documents.map((document) => (
                            <tr
                                key={document.documentKey}
                                className={
                                    document.documentKey ===
                                    selectedDocument?.documentKey
                                        ? 'selected'
                                        : ''
                                }
                                onClick={() =>
                                    setSelectedDocumentKey(document.documentKey)
                                }
                            >
                                <td>{document.documentKey}</td>
                                <td>{document.lifecycle}</td>
                                <td>{document.updateCount}</td>
                                <td>{document.snapshotCount}</td>
                                <td>{document.lastAppendSequence}</td>
                                <td>{formatTime(document.updatedAtEpochMs)}</td>
                            </tr>
                        ))}
                        {documents.length === 0 && (
                            <tr>
                                <td colSpan={6}>No CRDT documents returned.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            <section>
                <div className="section-heading">
                    <h3>Selected / Last Result</h3>
                    <span>{selectedDocument?.lifecycle ?? 'none'}</span>
                </div>
                {selectedDocument && (
                    <div className="metric-row">
                        <Metric
                            label="Lifecycle"
                            value={selectedDocument.lifecycle}
                            tone={
                                selectedDocument.lifecycle === 'active'
                                    ? 'good'
                                    : selectedDocument.lifecycle === 'quarantined'
                                      ? 'bad'
                                      : 'warn'
                            }
                        />
                        <Metric
                            label="Rollout"
                            value={selectedDocument.rollout ?? '-'}
                        />
                        <Metric
                            label="Append"
                            value={String(selectedDocument.lastAppendSequence)}
                        />
                        <Metric
                            label="Quarantine"
                            value={selectedDocument.quarantineReason ?? '-'}
                            tone={
                                selectedDocument.quarantineReason
                                    ? 'bad'
                                    : 'muted'
                            }
                        />
                    </div>
                )}
                <pre className="mini-json">
                    {redactedJson(
                        lastResult ?? selectedDocument ?? {},
                        state,
                        authSession,
                    )}
                </pre>
            </section>
        </section>
    );
}

function RallarDataPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [storeName, setStoreName] = useState('rallar-black-box-store');
    const [scopeMode, setScopeMode] = useState<
        'app' | 'principal' | 'session' | 'custom'
    >('session');
    const [customScope, setCustomScope] = useState('custom:rallar-black-box');
    const [durability, setDurability] = useState<
        'write-through' | 'write-behind'
    >('write-through');
    const [hydrateMode, setHydrateMode] = useState<'eager' | 'lazy'>('eager');
    const [key, setKey] = useState('probe');
    const [valueText, setValueText] = useState(() =>
        json({
            text: 'hello from Rallar Data',
            seq: 1,
        }),
    );
    const [expectedText, setExpectedText] = useState('');
    const [operation, setOperation] = useState<RallarDataOperation>('open');
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [storeOpen, setStoreOpen] = useState(false);
    const [hydrated, setHydrated] = useState(false);
    const [result, setResult] = useState<unknown>();
    const [changes, setChanges] = useState<readonly RallarDataChangeRow[]>([]);
    const storeRef = useRef<RallarDataUiStore | undefined>(undefined);
    const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const canRun = realBackendReady && !busyAction;
    const resolvedScope =
        scopeMode === 'app'
            ? `app:${globalValues.applicationId}:${globalValues.workspaceId}`
            : scopeMode === 'principal'
              ? `principal:${globalValues.clientId || authSession?.clientId || bootstrap.actor}`
              : scopeMode === 'session'
                ? `session:${globalValues.sessionId || authSession?.sessionId || bootstrap.sessionId}`
                : customScope;

    useEffect(
        () => () => {
            unsubscribeRef.current?.();
            void storeRef.current?.close();
        },
        [],
    );

    const options = () => ({
        scope: resolvedScope,
        durability,
        hydrate: hydrateMode,
        sync: true,
    });

    const recordDataEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction: string,
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: {
                    providerMode,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    roomId: globalValues.roomId,
                    actor:
                        authSession?.username ??
                        authSession?.clientId ??
                        bootstrap.actor,
                    connection: 'rallar-data',
                    authSession,
                    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
                },
                payload: {
                    storeName,
                    scope: resolvedScope,
                    ...optionalRecord(payload),
                },
                severity,
            }),
            lastAction,
        );
    };

    const loadFacade = async (): Promise<
        Awaited<ReturnType<typeof loadBrowserRallarFacade>>
    > => {
        if (!realBackendReady) {
            throw new Error(
                'Rallar Data console requires provider=browser-rallar.',
            );
        }
        const facade = await loadBrowserRallarFacade();
        facade.configure({ apiBaseUrl: globalValues.apiBaseUrl });
        facade.setDefaults({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
        });
        return facade;
    };

    const attachChangeListener = (store: RallarDataUiStore): void => {
        unsubscribeRef.current?.();
        unsubscribeRef.current = store.onChange((event) => {
            const row = {
                rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                atEpochMs: Date.now(),
                event,
            };
            setChanges((current) => [...current, row].slice(-50));
            recordDataEvent(
                'rallar.direct.data.change',
                'info',
                row,
                'Rallar Data changed',
            );
        });
    };

    const openStore = async (): Promise<RallarDataUiStore> => {
        if (storeRef.current) {
            return storeRef.current;
        }
        const facade = await loadFacade();
        const store = await facade.data.open<unknown>(storeName, options());
        storeRef.current = store;
        setStoreOpen(true);
        setHydrated(store.isHydrated());
        attachChangeListener(store);
        return store;
    };

    const resetOpenStore = (): void => {
        unsubscribeRef.current?.();
        unsubscribeRef.current = undefined;
        storeRef.current = undefined;
        setStoreOpen(false);
        setHydrated(false);
    };

    const parseValue = (): unknown => parseJsonText(valueText, null);
    const parseExpected = (): unknown | undefined =>
        expectedText.trim()
            ? parseJsonText(expectedText, undefined)
            : undefined;

    const runOperation = async (): Promise<void> => {
        setBusyAction(operation);
        setLocalError(undefined);
        try {
            const facade = await loadFacade();
            let nextResult: unknown;
            if (operation === 'define') {
                nextResult = facade.data.define(storeName, options());
            } else if (operation === 'open') {
                nextResult = await openStore();
            } else if (operation === 'lookup') {
                const lookedUp = facade.data.lookup<unknown>(
                    storeName,
                    options(),
                );
                if (lookedUp) {
                    storeRef.current = lookedUp;
                    setStoreOpen(true);
                    setHydrated(lookedUp.isHydrated());
                    attachChangeListener(lookedUp);
                }
                nextResult = lookedUp
                    ? {
                          name: lookedUp.name,
                          repositoryId: lookedUp.repositoryId,
                          hydrated: lookedUp.isHydrated(),
                      }
                    : undefined;
            } else if (operation === 'close') {
                nextResult = await facade.data.close(storeName, options());
                resetOpenStore();
            } else if (operation === 'destroy') {
                nextResult = await facade.data.destroy(storeName, options());
                resetOpenStore();
            } else if (operation === 'close-scope') {
                nextResult = await facade.data.closeScope(resolvedScope);
                resetOpenStore();
            } else if (operation === 'clear-scope') {
                nextResult = await facade.data.clearScope(resolvedScope);
            } else if (operation === 'destroy-scope') {
                nextResult = await facade.data.destroyScope(resolvedScope);
                resetOpenStore();
            } else {
                const store = await openStore();
                switch (operation) {
                    case 'hydrate':
                        await store.hydrate();
                        nextResult = { hydrated: store.isHydrated() };
                        break;
                    case 'when-idle':
                        await store.whenIdle();
                        nextResult = { idle: true };
                        break;
                    case 'read':
                        nextResult = store.read(key);
                        break;
                    case 'get':
                        nextResult = await store.get(key);
                        break;
                    case 'keys':
                        nextResult = store.keys();
                        break;
                    case 'list-keys':
                        nextResult = await store.listKeys();
                        break;
                    case 'read-entries':
                        nextResult = store.readEntries();
                        break;
                    case 'get-entries':
                        nextResult = await store.getEntries();
                        break;
                    case 'read-all':
                        nextResult = store.readAllValues();
                        break;
                    case 'get-all':
                        nextResult = await store.getAll();
                        break;
                    case 'set':
                        await store.set(key, parseValue());
                        nextResult = await store.get(key);
                        break;
                    case 'update':
                        nextResult = await store.update(key, () =>
                            parseValue(),
                        );
                        break;
                    case 'update-or-create':
                        nextResult = await store.updateOrCreate(key, () =>
                            parseValue(),
                        );
                        break;
                    case 'set-if-absent':
                        nextResult = await store.setIfAbsent(key, () =>
                            parseValue(),
                        );
                        break;
                    case 'compare-and-set':
                        nextResult = await store.compareAndSet(
                            key,
                            parseExpected(),
                            parseValue(),
                        );
                        break;
                    case 'get-and-set':
                        nextResult = await store.getAndSet(key, parseValue());
                        break;
                    case 'delete':
                        nextResult = await store.delete(key);
                        break;
                    case 'delete-expired':
                        nextResult = await store.deleteExpired();
                        break;
                    case 'clear':
                        await store.clear();
                        nextResult = { cleared: true };
                        break;
                    case 'flush':
                        await store.flush();
                        nextResult = { flushed: true };
                        break;
                    case 'export':
                        nextResult = await store.exportData();
                        break;
                    case 'estimate-usage':
                        nextResult = await store.estimateUsage();
                        break;
                    default:
                        nextResult = undefined;
                }
                setHydrated(store.isHydrated());
            }
            setResult(nextResult);
            recordDataEvent(
                'rallar.direct.data.operation.completed',
                'info',
                {
                    operation,
                    result: nextResult,
                },
                `Rallar Data ${operation} completed`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            recordDataEvent(
                'rallar.direct.data.operation.failed',
                'error',
                {
                    operation,
                    error: message,
                },
                `Rallar Data ${operation} failed`,
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    providerMode,
                    storeName,
                    scope: resolvedScope,
                    durability,
                    hydrateMode,
                    storeOpen,
                    hydrated,
                    operation,
                    key,
                    result,
                    changes: changes.slice(-8),
                },
                state,
                authSession,
            ),
        );
    };

    const operations: readonly RallarDataOperation[] = [
        'define',
        'open',
        'lookup',
        'hydrate',
        'when-idle',
        'read',
        'get',
        'keys',
        'list-keys',
        'read-entries',
        'get-entries',
        'read-all',
        'get-all',
        'set',
        'update',
        'update-or-create',
        'set-if-absent',
        'compare-and-set',
        'get-and-set',
        'delete',
        'delete-expired',
        'clear',
        'flush',
        'export',
        'estimate-usage',
        'close',
        'destroy',
        'close-scope',
        'clear-scope',
        'destroy-scope',
    ];

    return (
        <section className="panel rallar-data-panel" aria-label="Rallar Data">
            <div className="panel-heading">
                <h2>Rallar Data</h2>
                <span
                    className={`pill ${storeOpen ? 'good' : realBackendReady ? 'muted' : 'warn'}`}
                >
                    {storeOpen
                        ? 'store open'
                        : realBackendReady
                          ? 'idle'
                          : 'real backend required'}
                </span>
            </div>
            <div className="rallar-data-summary-grid">
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={realBackendReady ? 'good' : 'warn'}
                />
                <Metric label="Store" value={storeName} />
                <Metric label="Scope" value={resolvedScope} />
                <Metric
                    label="Open"
                    value={storeOpen ? 'yes' : 'no'}
                    tone={storeOpen ? 'good' : 'muted'}
                />
                <Metric
                    label="Hydrated"
                    value={hydrated ? 'yes' : 'no'}
                    tone={hydrated ? 'good' : 'muted'}
                />
                <Metric label="Changes" value={String(changes.length)} />
            </div>
            <CollapsiblePanelSection
                title="Rallar Data Inputs"
                meta={`${storeName} / ${operation}`}
            >
                <div className="rallar-data-context-grid">
                    <label className="field">
                        <span>Store</span>
                        <input
                            value={storeName}
                            onChange={(event) => {
                                resetOpenStore();
                                setStoreName(event.target.value);
                            }}
                        />
                    </label>
                    <label className="field">
                        <span>Scope</span>
                        <select
                            value={scopeMode}
                            onChange={(event) => {
                                resetOpenStore();
                                setScopeMode(
                                    event.target.value as typeof scopeMode,
                                );
                            }}
                        >
                            <option value="app">app</option>
                            <option value="principal">principal</option>
                            <option value="session">session</option>
                            <option value="custom">custom</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Custom Scope</span>
                        <input
                            value={customScope}
                            onChange={(event) =>
                                setCustomScope(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Durability</span>
                        <select
                            value={durability}
                            onChange={(event) => {
                                resetOpenStore();
                                setDurability(
                                    event.target.value as typeof durability,
                                );
                            }}
                        >
                            <option value="write-through">write-through</option>
                            <option value="write-behind">write-behind</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Hydration</span>
                        <select
                            value={hydrateMode}
                            onChange={(event) => {
                                resetOpenStore();
                                setHydrateMode(
                                    event.target.value as typeof hydrateMode,
                                );
                            }}
                        >
                            <option value="eager">eager</option>
                            <option value="lazy">lazy</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Operation</span>
                        <select
                            value={operation}
                            onChange={(event) =>
                                setOperation(
                                    event.target.value as RallarDataOperation,
                                )
                            }
                        >
                            {operations.map((entry) => (
                                <option key={entry} value={entry}>
                                    {entry}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Key</span>
                        <input
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="rallar-data-actions">
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void runOperation()}
                >
                    Run data operation
                </button>
                <button type="button" onClick={copyDiagnostics}>
                    Copy diagnostics
                </button>
            </div>
            <CollapsiblePanelSection
                title="Rallar Data Values"
                meta={`${changes.length} changes`}
            >
                <div className="rallar-data-work-grid">
                    <label className="json-editor">
                        <span>Value JSON</span>
                        <textarea
                            value={valueText}
                            onChange={(event) =>
                                setValueText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <label className="json-editor">
                        <span>Expected JSON</span>
                        <textarea
                            value={expectedText}
                            onChange={(event) =>
                                setExpectedText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <section className="rallar-data-result-panel">
                        <div className="section-heading">
                            <h3>Result</h3>
                            <span>{busyAction ?? operation}</span>
                        </div>
                        <pre className="mini-json">
                            {redactedJson(result ?? {}, state, authSession)}
                        </pre>
                    </section>
                    <section className="rallar-data-result-panel">
                        <div className="section-heading">
                            <h3>Change Events</h3>
                            <span>{changes.length} rows</span>
                        </div>
                        <div className="websocket-received-list">
                            {changes.length === 0 && (
                                <div className="empty-state">
                                    No Rallar Data changes
                                </div>
                            )}
                            {changes
                                .slice()
                                .reverse()
                                .map((change) => (
                                    <article
                                        className="websocket-received-row"
                                        key={change.rowId}
                                    >
                                        <div>
                                            <strong>
                                                {formatTime(change.atEpochMs)}
                                            </strong>
                                            <small>{storeName}</small>
                                        </div>
                                        <pre className="mini-json">
                                            {redactedJson(
                                                change.event,
                                                state,
                                                authSession,
                                            )}
                                        </pre>
                                    </article>
                                ))}
                        </div>
                    </section>
                </div>
            </CollapsiblePanelSection>
            {(busyAction || localError || !realBackendReady) && (
                <div
                    className={
                        localError ? 'workbench-error' : 'command-center-status'
                    }
                    role="status"
                >
                    {localError ??
                        (!realBackendReady
                            ? 'Rallar Data requires provider=browser-rallar.'
                            : busyAction)}
                </div>
            )}
        </section>
    );
}

function MediaConsolePanel({
    state,
    bootstrap,
    authSession,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [audioEnabled, setAudioEnabled] = useState(true);
    const [videoEnabled, setVideoEnabled] = useState(true);
    const [policyText, setPolicyText] = useState(() =>
        json({
            receiveAudio: true,
            receiveVideo: true,
        }),
    );
    const [localStreamId, setLocalStreamId] = useState<string | undefined>();
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [result, setResult] = useState<unknown>();
    const [remoteStreams, setRemoteStreams] = useState<
        readonly MediaRemoteStreamRow[]
    >([]);
    const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const canRun = realBackendReady && Boolean(authSession) && !busyAction;

    useEffect(
        () => () => {
            unsubscribeRef.current?.();
        },
        [],
    );

    const recordMediaEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction: string,
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: {
                    providerMode,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    roomId: globalValues.roomId,
                    actor:
                        authSession?.username ??
                        authSession?.clientId ??
                        bootstrap.actor,
                    connection: 'media',
                    authSession,
                },
                transport: 'realtime',
                severity,
                payload,
            }),
            lastAction,
        );
    };

    const withFacade = async <T,>(
        action: (
            facade: Awaited<ReturnType<typeof loadBrowserRallarFacade>>,
        ) => Promise<T>,
    ): Promise<T> => {
        if (!realBackendReady) {
            throw new Error('Media console requires provider=browser-rallar.');
        }
        if (!authSession) {
            throw new Error(
                'Media console requires a logged-in browser session.',
            );
        }
        const facade = await loadBrowserRallarFacade();
        facade.configure({ apiBaseUrl: globalValues.apiBaseUrl });
        facade.setDefaults({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            room: globalValues.roomId
                ? {
                      roomId: globalValues.roomId,
                      roomRef: {
                          applicationId: globalValues.applicationId,
                          workspaceId: globalValues.workspaceId,
                          groupId: globalValues.roomId,
                      },
                  }
                : undefined,
        });
        await facade.start({
            connect: true,
            refreshRooms: false,
            refreshPeople: false,
            timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
        });
        return await action(facade);
    };

    const runMediaAction = async (
        label: string,
        action: () => Promise<unknown>,
    ): Promise<void> => {
        setBusyAction(label);
        setLocalError(undefined);
        try {
            const nextResult = await action();
            setResult(nextResult);
            recordMediaEvent(
                `rallar.direct.media.${label.toLowerCase().replaceAll(' ', '_')}.completed`,
                'info',
                nextResult,
                `${label} completed`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            recordMediaEvent(
                `rallar.direct.media.${label.toLowerCase().replaceAll(' ', '_')}.failed`,
                'error',
                { error: message },
                `${label} failed`,
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const attachLocal = (): Promise<void> =>
        runMediaAction('Attach local stream', async () => {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error(
                    'Browser mediaDevices.getUserMedia is not available.',
                );
            }
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: audioEnabled,
                video: videoEnabled,
            });
            await withFacade(async (facade) => {
                await facade.media.setLocalStream(stream);
            });
            setLocalStreamId(stream.id);
            return {
                streamId: stream.id,
                tracks: stream.getTracks().map((track) => ({
                    kind: track.kind,
                    enabled: track.enabled,
                    readyState: track.readyState,
                })),
            };
        });

    const toggleAudio = (): Promise<void> =>
        runMediaAction('Set audio', async () => {
            const next = !audioEnabled;
            await withFacade(async (facade) => {
                await facade.media.setAudioEnabled(next);
            });
            setAudioEnabled(next);
            return { audioEnabled: next };
        });

    const toggleVideo = (): Promise<void> =>
        runMediaAction('Set video', async () => {
            const next = !videoEnabled;
            await withFacade(async (facade) => {
                await facade.media.setVideoEnabled(next);
            });
            setVideoEnabled(next);
            return { videoEnabled: next };
        });

    const stopLocal = (kind: 'audio' | 'video' | 'all'): Promise<void> =>
        runMediaAction(`Stop ${kind}`, async () => {
            await withFacade(async (facade) => {
                await facade.media.stopLocal(kind);
            });
            if (kind === 'all') {
                setLocalStreamId(undefined);
            }
            return { stopped: kind };
        });

    const applyPolicy = (): Promise<void> =>
        runMediaAction('Apply media policy', async () => {
            const policy = parseJsonText(policyText, {});
            await withFacade(async (facade) => {
                await facade.media.setPolicy(
                    policy as Parameters<typeof facade.media.setPolicy>[0],
                );
            });
            return policy;
        });

    const subscribeRemote = (): Promise<void> =>
        runMediaAction('Subscribe remote streams', async () => {
            return await withFacade(async (facade) => {
                unsubscribeRef.current?.();
                unsubscribeRef.current = facade.media.onRemoteStream(
                    (remote) => {
                        const row = {
                            rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            atEpochMs: Date.now(),
                            peerId: remote.peerId,
                            streamId: remote.stream.id,
                        };
                        setRemoteStreams((current) =>
                            [...current, row].slice(-30),
                        );
                        recordMediaEvent(
                            'rallar.direct.media.remote_stream',
                            'info',
                            row,
                            'Remote media stream observed',
                        );
                    },
                );
                return { subscribed: true };
            });
        });

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    providerMode,
                    localStreamId,
                    audioEnabled,
                    videoEnabled,
                    policy: (() => {
                        try {
                            return parseJsonText(policyText, {});
                        } catch {
                            return policyText;
                        }
                    })(),
                    remoteStreams,
                    result,
                    localError,
                },
                state,
                authSession,
            ),
        );
    };

    return (
        <section
            className="panel media-console-panel"
            aria-label="Media Console"
        >
            <div className="panel-heading">
                <h2>Media</h2>
                <span
                    className={`pill ${localStreamId ? 'good' : realBackendReady ? 'muted' : 'warn'}`}
                >
                    {localStreamId
                        ? 'local attached'
                        : realBackendReady
                          ? 'idle'
                          : 'real backend required'}
                </span>
            </div>
            <div className="media-summary-grid">
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={realBackendReady ? 'good' : 'warn'}
                />
                <Metric label="Local stream" value={localStreamId ?? '-'} />
                <Metric
                    label="Audio"
                    value={audioEnabled ? 'enabled' : 'disabled'}
                />
                <Metric
                    label="Video"
                    value={videoEnabled ? 'enabled' : 'disabled'}
                />
                <Metric
                    label="Remote streams"
                    value={String(remoteStreams.length)}
                />
            </div>
            <div className="media-action-grid">
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void attachLocal()}
                >
                    Attach local stream
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void toggleAudio()}
                >
                    Toggle audio
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void toggleVideo()}
                >
                    Toggle video
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void stopLocal('audio')}
                >
                    Stop audio
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void stopLocal('video')}
                >
                    Stop video
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void stopLocal('all')}
                >
                    Stop all
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void applyPolicy()}
                >
                    Apply media policy
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void subscribeRemote()}
                >
                    Subscribe remote streams
                </button>
                <button type="button" onClick={copyDiagnostics}>
                    Copy diagnostics
                </button>
            </div>
            <CollapsiblePanelSection
                title="Media Inputs"
                meta={`${remoteStreams.length} remote`}
            >
                <div className="media-work-grid">
                    <label className="json-editor">
                        <span>Media Policy JSON</span>
                        <textarea
                            value={policyText}
                            onChange={(event) =>
                                setPolicyText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <section className="media-result-panel">
                        <div className="section-heading">
                            <h3>Remote Streams</h3>
                            <span>{remoteStreams.length} rows</span>
                        </div>
                        <div className="websocket-received-list">
                            {remoteStreams.length === 0 && (
                                <div className="empty-state">
                                    No remote streams
                                </div>
                            )}
                            {remoteStreams
                                .slice()
                                .reverse()
                                .map((remote) => (
                                    <article
                                        className="state-table-row"
                                        key={remote.rowId}
                                    >
                                        <div>
                                            <strong>{remote.peerId}</strong>
                                            <small>{remote.streamId}</small>
                                        </div>
                                        <span>
                                            {formatTime(remote.atEpochMs)}
                                        </span>
                                    </article>
                                ))}
                        </div>
                    </section>
                    <section className="media-result-panel">
                        <div className="section-heading">
                            <h3>Result</h3>
                            <span>{busyAction ?? 'idle'}</span>
                        </div>
                        <pre className="mini-json">
                            {redactedJson(result ?? {}, state, authSession)}
                        </pre>
                    </section>
                </div>
            </CollapsiblePanelSection>
            {(busyAction ||
                localError ||
                !realBackendReady ||
                !authSession) && (
                <div
                    className={
                        localError ? 'workbench-error' : 'command-center-status'
                    }
                    role="status"
                >
                    {localError ??
                        (!realBackendReady
                            ? 'Media console requires provider=browser-rallar.'
                            : !authSession
                              ? 'Media console requires a logged-in browser session.'
                              : busyAction)}
                </div>
            )}
        </section>
    );
}

function AuthCommandCenterPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    onAuthenticated,
    onLogout,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    onAuthenticated(session?: AuthSession): void;
    onLogout(): Promise<void>;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);
    const [apiBaseUrl, setApiBaseUrl] = useState(
        globalValues?.apiBaseUrl ?? config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
    );
    const [username, setUsername] = useState(
        authSession?.username ?? bootstrap.rallarUsername ?? bootstrap.actor,
    );
    const [password, setPassword] = useState(bootstrap.rallarPassword ?? '');
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [ticket, setTicket] = useState<AuthCommandCenterTicket | undefined>();
    const [actions, setActions] = useState<
        readonly CommandCenterRestActionLog[]
    >([]);
    const recipeText = useMemo(() => authRecipeSnippet(username), [username]);
    const diagnosticsText = useMemo(
        () =>
            redactedJson(
                {
                    providerMode,
                    apiBaseUrl,
                    session: authSession,
                    wsTicket: ticket
                        ? {
                              ...ticket,
                              ticket: '<redacted:ws-ticket>',
                              expiresInMs: ticket.expiresAtEpochMs - Date.now(),
                          }
                        : undefined,
                    recentActions: actions.slice(-6),
                },
                state,
                authSession,
            ),
        [actions, apiBaseUrl, authSession, providerMode, state, ticket],
    );
    const sessionExpiresInMs = authSession
        ? authSession.expiresAtEpochMs - Date.now()
        : undefined;
    const wsTicketExpiresInMs = ticket
        ? ticket.expiresAtEpochMs - Date.now()
        : undefined;

    const appendAction = (entry: CommandCenterRestActionLog): void => {
        setActions((current) => [...current, entry].slice(-12));
    };

    useEffect(() => {
        if (globalValues?.apiBaseUrl) {
            setApiBaseUrl(globalValues.apiBaseUrl);
        }
    }, [globalValues?.apiBaseUrl]);

    const runWithBusy = async (
        label: string,
        action: () => Promise<void>,
    ): Promise<void> => {
        setBusyAction(label);
        setLocalError(undefined);
        try {
            await action();
        } catch (error) {
            setLocalError(authErrorMessage(error));
        } finally {
            setBusyAction(undefined);
        }
    };

    const login = async (register: boolean): Promise<void> => {
        await runWithBusy(
            register ? 'Register and login' : 'Login',
            async () => {
                const session = await authenticateRallarBlackBox(
                    await loadBrowserRallarFacade(),
                    {
                        apiBaseUrl,
                        username,
                        password,
                        register,
                    },
                );
                rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                    bootstrapPatchFromAuthSession(session, apiBaseUrl),
                );
                onAuthenticated(session);
                appendAction({
                    actionId: `auth-${register ? 'register-login' : 'login'}-${Date.now()}`,
                    label: register ? 'Register and login' : 'Login',
                    atEpochMs: Date.now(),
                    ok: true,
                    status: register ? 201 : 200,
                    statusText: 'OK',
                    durationMs: 0,
                    bodyJson: session,
                });
            },
        );
    };

    const restore = (): void => {
        const restored = readCurrentAuthSession();
        onAuthenticated(restored);
        if (!restored) {
            setLocalError('No restorable browser auth session was found.');
            return;
        }
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromAuthSession(restored, apiBaseUrl),
        );
        appendAction({
            actionId: `auth-restore-${Date.now()}`,
            label: 'Restore session',
            atEpochMs: Date.now(),
            ok: true,
            status: 200,
            statusText: 'Restored',
            durationMs: 0,
            bodyJson: restored,
        });
    };

    const clearLocal = (): void => {
        clearSession();
        setTicket(undefined);
        onAuthenticated(undefined);
        appendAction({
            actionId: `auth-clear-${Date.now()}`,
            label: 'Clear local session',
            atEpochMs: Date.now(),
            ok: true,
            status: 200,
            statusText: 'Cleared',
            durationMs: 0,
        });
    };

    const createWsTicket = async (): Promise<void> => {
        await runWithBusy('Create WS ticket', async () => {
            const response = await executeRallarServerRestRequest({
                apiBaseUrl,
                method: 'POST',
                path: '/api/auth/ws-ticket',
                headersText: '{}',
                queryText: '{}',
                bodyText: '{}',
                responseBodyMode: 'json',
                attachAuth: true,
                authSession,
                timeoutMs: 5_000,
            });
            appendAction(restLogEntry('Create WS ticket', response));
            const body = optionalRecord(response.bodyJson);
            if (
                response.ok &&
                typeof body.ticket === 'string' &&
                typeof body.sessionId === 'string' &&
                typeof body.expiresAtEpochMs === 'number'
            ) {
                const wsTicket = body as WebSocketTicketResponse;
                setTicket({
                    ticket: wsTicket.ticket,
                    sessionId: wsTicket.sessionId,
                    expiresAtEpochMs: wsTicket.expiresAtEpochMs,
                    issuedAtEpochMs: Date.now(),
                });
            }
        });
    };

    const negativeWsTicket = async (): Promise<void> => {
        await runWithBusy('Missing auth WS ticket', async () => {
            const response = await executeRallarServerRestRequest({
                apiBaseUrl,
                method: 'POST',
                path: '/api/auth/ws-ticket',
                headersText: '{}',
                queryText: '{}',
                bodyText: '{}',
                responseBodyMode: 'json',
                attachAuth: false,
                timeoutMs: 5_000,
            });
            appendAction(restLogEntry('Missing auth WS ticket', response));
        });
    };

    const expiredWsTicket = async (): Promise<void> => {
        await runWithBusy('Expired auth WS ticket', async () => {
            const expiredSession = authSession
                ? {
                      ...authSession,
                      expiresAtEpochMs: Date.now() - 1_000,
                  }
                : undefined;
            const response = await executeRallarServerRestRequest({
                apiBaseUrl,
                method: 'POST',
                path: '/api/auth/ws-ticket',
                headersText: '{}',
                queryText: '{}',
                bodyText: '{}',
                responseBodyMode: 'json',
                attachAuth: true,
                authSession: expiredSession,
                timeoutMs: 5_000,
            });
            appendAction(restLogEntry('Expired auth WS ticket', response));
        });
    };

    const negativeLogin = async (): Promise<void> => {
        await runWithBusy('Bad credentials', async () => {
            const response = await executeRallarServerRestRequest({
                apiBaseUrl,
                method: 'POST',
                path: '/api/auth/login',
                headersText: '{}',
                queryText: '{}',
                bodyText: JSON.stringify({
                    username: username || 'unknown',
                    password: `${password || 'bad'}-invalid`,
                }),
                responseBodyMode: 'json',
                attachAuth: false,
                timeoutMs: 5_000,
            });
            appendAction(restLogEntry('Bad credentials', response));
        });
    };

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(diagnosticsText);
    };

    const copyRecipe = (): void => {
        void navigator.clipboard?.writeText(recipeText);
    };

    return (
        <section className="panel auth-command-center-panel">
            <div className="panel-heading">
                <h2>Auth Command Center</h2>
                <span className={`pill ${authSession ? 'good' : 'warn'}`}>
                    {authSession ? 'session active' : 'no session'}
                </span>
            </div>
            <CollapsiblePanelSection
                title="Auth Inputs"
                meta={authSession ? authSession.username : 'not logged in'}
            >
                <div className="auth-command-grid">
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) =>
                                setApiBaseUrl(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Username</span>
                        <input
                            value={username}
                            onChange={(event) =>
                                setUsername(event.target.value)
                            }
                            autoCapitalize="none"
                            autoComplete="username"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                    </label>
                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(event) =>
                                setPassword(event.target.value)
                            }
                            autoComplete="current-password"
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="auth-action-grid">
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void login(false)}
                >
                    Login
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void login(true)}
                >
                    Register and login
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={restore}
                >
                    Restore session
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction) || !authSession}
                    onClick={() => void onLogout()}
                >
                    Logout
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={clearLocal}
                >
                    Clear local session
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction) || !authSession}
                    onClick={() => void createWsTicket()}
                >
                    Create WS ticket
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void negativeLogin()}
                >
                    Bad credentials
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void negativeWsTicket()}
                >
                    Missing auth ticket
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction) || !authSession}
                    onClick={() => void expiredWsTicket()}
                >
                    Expired auth ticket
                </button>
                <button type="button" onClick={copyDiagnostics}>
                    Copy diagnostics
                </button>
                <button type="button" onClick={copyRecipe}>
                    Copy auth recipe
                </button>
            </div>
            <dl className="config-list auth-session-list">
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>User</dt>
                    <dd>{authSession?.username ?? '-'}</dd>
                </div>
                <div>
                    <dt>Client</dt>
                    <dd>{authSession?.clientId ?? '-'}</dd>
                </div>
                <div>
                    <dt>Session</dt>
                    <dd>{authSession?.sessionId ?? '-'}</dd>
                </div>
                <div>
                    <dt>Token</dt>
                    <dd>{authSession?.accessToken ? 'redacted' : '-'}</dd>
                </div>
                <div>
                    <dt>Session expires</dt>
                    <dd>{formatTime(authSession?.expiresAtEpochMs)}</dd>
                </div>
                <div>
                    <dt>Session TTL</dt>
                    <dd>{formatRelativeDuration(sessionExpiresInMs)}</dd>
                </div>
                <div>
                    <dt>WS ticket</dt>
                    <dd>{ticket ? 'redacted' : '-'}</dd>
                </div>
                <div>
                    <dt>Ticket expires</dt>
                    <dd>{formatTime(ticket?.expiresAtEpochMs)}</dd>
                </div>
                <div>
                    <dt>Ticket TTL</dt>
                    <dd>{formatRelativeDuration(wsTicketExpiresInMs)}</dd>
                </div>
            </dl>
            <div
                className="command-center-status auth-session-guidance"
                role="note"
            >
                Ordinary same-origin tabs share localStorage `auth.session`.
                Agent tabs opened from Connect Agents use one-time links and
                sessionStorage so the same logged-in user can create distinct
                targetable browser sessions.
            </div>
            {busyAction && (
                <div className="command-center-status" role="status">
                    {busyAction}
                </div>
            )}
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession, [password]),
                    )}
                </div>
            )}
            <div className="command-center-action-list">
                {actions.length === 0 && (
                    <div className="empty-state">No auth actions yet</div>
                )}
                {actions
                    .slice()
                    .reverse()
                    .map((action) => (
                        <article
                            className="command-center-action-row"
                            key={action.actionId}
                        >
                            <div>
                                <strong>{action.label}</strong>
                                <small>
                                    {formatTime(action.atEpochMs)} -{' '}
                                    {formatDuration(action.durationMs)}
                                </small>
                            </div>
                            <span
                                className={`pill ${action.ok ? 'good' : 'bad'}`}
                            >
                                {action.status || action.errorKind || 'local'}
                            </span>
                            <pre className="mini-json">
                                {redactedJson(
                                    action.bodyJson ??
                                        action.errorKind ??
                                        action.statusText,
                                    state,
                                    authSession,
                                    [password],
                                )}
                            </pre>
                        </article>
                    ))}
            </div>
        </section>
    );
}

function RoomsClientsPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    onGlobalValueChange,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
}) {
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

    return (
        <section className="panel rooms-clients-panel">
            <div className="panel-heading">
                <h2>Groups/Clients</h2>
                <span className={`pill ${authSession ? 'good' : 'bad'}`}>
                    {authSession ? 'auth attached' : 'needs auth'}
                </span>
            </div>
            <CollapsiblePanelSection
                title="Groups/Clients Inputs"
                meta={`${variables.groupId || '-'} / ${variables.principalId || '-'}`}
            >
                <div className="rooms-context-grid">
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) =>
                                setApiBaseUrl(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Application</span>
                        <input
                            value={variables.applicationId}
                            onChange={(event) =>
                                updateVariable(
                                    'applicationId',
                                    event.target.value,
                                )
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Workspace</span>
                        <input
                            value={variables.workspaceId}
                            onChange={(event) =>
                                updateVariable(
                                    'workspaceId',
                                    event.target.value,
                                )
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Group</span>
                        <input
                            value={variables.groupId}
                            onChange={(event) =>
                                updateVariable('groupId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Principal / Client</span>
                        <input
                            value={variables.principalId}
                            onChange={(event) =>
                                updateVariable(
                                    'principalId',
                                    event.target.value,
                                )
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Instance</span>
                        <input
                            value={variables.clientInstanceId}
                            onChange={(event) =>
                                updateVariable(
                                    'clientInstanceId',
                                    event.target.value,
                                )
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Session</span>
                        <input
                            value={variables.sessionId}
                            onChange={(event) =>
                                updateVariable('sessionId', event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Timeout</span>
                        <input
                            type="number"
                            min={0}
                            value={timeoutMs}
                            onChange={(event) =>
                                setTimeoutMs(Number(event.target.value))
                            }
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="rooms-utility-grid">
                <button
                    type="button"
                    disabled={Boolean(busyAction) || !authSession}
                    onClick={() => void refreshState()}
                >
                    Refresh state
                </button>
                <button type="button" onClick={copyStateRecipe}>
                    Copy state recipe
                </button>
            </div>
            <CommandCenterActionFeedbackPanel
                feedback={actionFeedback}
                state={state}
                authSession={authSession}
            />
            <div
                className="rooms-action-sections"
                aria-label="Groups and clients actions"
            >
                {ROOMS_CLIENTS_ACTION_GROUPS.map((category) => (
                    <section
                        key={category.categoryId}
                        className="rooms-action-category"
                        aria-label={`${category.title}. ${category.description}`}
                    >
                        <h3>{category.title}</h3>
                        {category.categoryId === 'groups' ? (
                            <div className="rooms-action-subsection">
                                <h4>Rallar facade</h4>
                                <div className="rooms-action-grid">
                                    <button
                                        type="button"
                                        disabled={
                                            Boolean(busyAction) ||
                                            !authSession ||
                                            bootstrap.providerMode !==
                                                'browser-rallar'
                                        }
                                        onClick={() =>
                                            void runDirectRoomsAction('refresh')
                                        }
                                    >
                                        Rallar refresh
                                    </button>
                                    <button
                                        type="button"
                                        disabled={
                                            Boolean(busyAction) ||
                                            !authSession ||
                                            bootstrap.providerMode !==
                                                'browser-rallar'
                                        }
                                        onClick={() =>
                                            void runDirectRoomsAction('create')
                                        }
                                    >
                                        Rallar create group
                                    </button>
                                    <button
                                        type="button"
                                        disabled={
                                            Boolean(busyAction) ||
                                            !authSession ||
                                            bootstrap.providerMode !==
                                                'browser-rallar'
                                        }
                                        onClick={() =>
                                            void runDirectRoomsAction('join')
                                        }
                                    >
                                        Rallar join group
                                    </button>
                                    <button
                                        type="button"
                                        disabled={
                                            Boolean(busyAction) ||
                                            !authSession ||
                                            bootstrap.providerMode !==
                                                'browser-rallar'
                                        }
                                        onClick={() =>
                                            void runDirectRoomsAction('leave')
                                        }
                                    >
                                        Rallar leave group
                                    </button>
                                </div>
                            </div>
                        ) : null}
                        <div className="rooms-action-subsection">
                            <h4>Rallar Server REST</h4>
                            <div className="rooms-action-grid">
                                {category.actions.map((action) => (
                                    <button
                                        key={action.actionId}
                                        type="button"
                                        disabled={
                                            Boolean(busyAction) || !authSession
                                        }
                                        onClick={() =>
                                            void runPresetAction(action)
                                        }
                                    >
                                        {action.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </section>
                ))}
            </div>
            <div
                className="rooms-filter-row"
                aria-label="Groups and clients filters"
            >
                <label className="check-field">
                    <input
                        type="checkbox"
                        checked={onlyGroupsWithMembers}
                        onChange={(event) =>
                            setOnlyGroupsWithMembers(event.target.checked)
                        }
                    />
                    <span>Groups with members</span>
                </label>
                <label className="check-field">
                    <input
                        type="checkbox"
                        checked={onlyOnlineClients}
                        onChange={(event) =>
                            setOnlyOnlineClients(event.target.checked)
                        }
                    />
                    <span>Online clients</span>
                </label>
                <span className="filter-summary">
                    {visibleGroupRows.length}/{groupRows.length} groups,{' '}
                    {visibleClientRows.length}/{clientRows.length} clients
                </span>
                <label className="field compact-field rooms-sort-field">
                    <span>Group sort</span>
                    <select
                        aria-label="Group sort"
                        value={groupSort}
                        onChange={(event) =>
                            setGroupSort(event.target.value as GroupSortId)
                        }
                    >
                        {GROUP_SORT_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field compact-field rooms-sort-field">
                    <span>Client sort</span>
                    <select
                        aria-label="Client sort"
                        value={clientSort}
                        onChange={(event) =>
                            setClientSort(event.target.value as ClientSortId)
                        }
                    >
                        {CLIENT_SORT_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field compact-field rooms-sort-field">
                    <span>Expected other client</span>
                    <input
                        aria-label="Expected other client"
                        value={expectedOtherClient}
                        onChange={(event) =>
                            setExpectedOtherClient(event.target.value)
                        }
                    />
                </label>
            </div>
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession),
                    )}
                </div>
            )}
            <div className="rooms-observed-grid">
                <Metric
                    label="Expected clients"
                    value={String(expectedClients.length)}
                />
                <Metric
                    label="Observed clients"
                    value={String(observedClients.length)}
                    tone={missingClients.length ? 'warn' : 'good'}
                />
                <Metric
                    label="Missing clients"
                    value={String(missingClients.length)}
                    tone={missingClients.length ? 'bad' : 'good'}
                />
                <Metric
                    label="Group rows"
                    value={String(visibleGroupRows.length)}
                />
                <Metric
                    label="Client rows"
                    value={String(visibleClientRows.length)}
                />
                <Metric label="Events" value={String(stateEvents.length)} />
                <Metric
                    label="Current client member"
                    value={currentClientOnline ? 'yes' : 'no'}
                    tone={currentClientOnline ? 'good' : 'warn'}
                />
                <Metric
                    label="Other browser visible"
                    value={expectedOtherClientVisible ? 'yes' : 'no'}
                    tone={expectedOtherClientVisible ? 'good' : 'warn'}
                />
            </div>
            <div className="rooms-state-grid">
                <section className="rooms-subpanel">
                    <div className="section-heading">
                        <h3>Groups</h3>
                        <span>{visibleGroupRows.length} rows</span>
                    </div>
                    <div className="state-table">
                        {visibleGroupRows.length === 0 && (
                            <div className="empty-state">
                                {groupRows.length === 0
                                    ? 'No group state loaded'
                                    : 'No groups match filters'}
                            </div>
                        )}
                        {sortedGroupRows.map((row) => (
                            <article
                                className="state-table-row"
                                key={row.rowId}
                            >
                                <div>
                                    <strong>{row.displayName}</strong>
                                    <small>{row.groupId}</small>
                                </div>
                                <span>{row.status}</span>
                                <span>{row.members} members</span>
                                <span>{row.online} online</span>
                                <small>
                                    {row.sessions.join(', ') || '-'}
                                    {' - active '}
                                    {formatTime(row.activeAtEpochMs)}
                                </small>
                            </article>
                        ))}
                    </div>
                </section>
                <section className="rooms-subpanel">
                    <div className="section-heading">
                        <h3>Clients</h3>
                        <span>{visibleClientRows.length} rows</span>
                    </div>
                    <div className="state-table">
                        {visibleClientRows.length === 0 && (
                            <div className="empty-state">
                                {clientRows.length === 0
                                    ? 'No client state loaded'
                                    : 'No clients match filters'}
                            </div>
                        )}
                        {sortedClientRows.map((row) => (
                            <article
                                className="state-table-row"
                                key={row.rowId}
                            >
                                <div>
                                    <strong>{row.username}</strong>
                                    <small>{row.principalId}</small>
                                </div>
                                <span>{row.status}</span>
                                <span>{row.online}</span>
                                <span>{row.sessions.length} sessions</span>
                                <small>
                                    {row.sessions.join(', ') || '-'}
                                    {' - active '}
                                    {formatTime(row.activeAtEpochMs)}
                                </small>
                            </article>
                        ))}
                    </div>
                </section>
                <section className="rooms-subpanel rooms-events-panel">
                    <div className="section-heading">
                        <h3>State Events</h3>
                        <span>{stateEvents.length} rows</span>
                    </div>
                    <div className="state-table">
                        {stateEvents.length === 0 && (
                            <div className="empty-state">
                                No state events loaded
                            </div>
                        )}
                        {stateEvents.map((row) => (
                            <article
                                className="state-table-row"
                                key={row.rowId}
                            >
                                <div>
                                    <strong>{row.eventType}</strong>
                                    <small>{row.rowId}</small>
                                </div>
                                <span>{row.subject}</span>
                                <span>v{row.snapshotVersion}</span>
                                <span>{formatTime(row.atEpochMs)}</span>
                            </article>
                        ))}
                    </div>
                </section>
                <section className="rooms-subpanel">
                    <div className="section-heading">
                        <h3>Actions</h3>
                        <span>{actions.length} recent</span>
                    </div>
                    <div className="command-center-action-list">
                        {actions.length === 0 && (
                            <div className="empty-state">
                                No state actions yet
                            </div>
                        )}
                        {actions
                            .slice()
                            .reverse()
                            .map((action) => (
                                <article
                                    className="command-center-action-row"
                                    key={action.actionId}
                                >
                                    <div>
                                        <strong>{action.label}</strong>
                                        <small>
                                            {formatTime(action.atEpochMs)} -{' '}
                                            {formatDuration(action.durationMs)}
                                        </small>
                                    </div>
                                    <span
                                        className={`pill ${action.ok ? 'good' : 'bad'}`}
                                    >
                                        {action.status ||
                                            action.errorKind ||
                                            'local'}
                                    </span>
                                </article>
                            ))}
                    </div>
                </section>
            </div>
        </section>
    );
}

function RallarServerRequestFeedbackPanel({
    feedback,
    authSession,
}: {
    feedback: RallarServerRequestFeedback;
    authSession?: AuthSession;
}) {
    const tone =
        feedback.state === 'success'
            ? 'good'
            : feedback.state === 'error'
              ? 'bad'
              : feedback.state === 'sending'
                ? 'active'
                : 'muted';
    const label =
        feedback.state === 'success'
            ? 'success'
            : feedback.state === 'error'
              ? 'failed'
              : feedback.state === 'sending'
                ? 'sending'
                : 'idle';
    const title =
        feedback.state === 'idle'
            ? 'No request sent yet'
            : `${feedback.method ?? 'Request'} ${feedback.state}`;
    const statusText =
        feedback.status !== undefined
            ? `${feedback.status} ${feedback.statusText ?? ''}`.trim()
            : (feedback.errorKind ?? '-');
    const urlText = feedback.url
        ? redactRallarServerUrl(feedback.url, authSession)
        : (feedback.path ?? '-');
    const message = feedback.message
        ? redactRallarServerText(feedback.message, authSession)
        : feedback.state === 'sending'
          ? 'Waiting for Rallar Server response.'
          : feedback.state === 'idle'
            ? 'Configure an endpoint and send a request.'
            : '-';

    return (
        <section
            className={`rest-request-feedback ${tone}`}
            role="status"
            aria-live="polite"
        >
            <div>
                <span className={`pill ${tone}`}>{label}</span>
                <strong>{title}</strong>
                <small>
                    {feedback.atEpochMs ? formatTime(feedback.atEpochMs) : '-'}
                </small>
            </div>
            <dl>
                <div>
                    <dt>Endpoint</dt>
                    <dd>{urlText}</dd>
                </div>
                <div>
                    <dt>Status</dt>
                    <dd>{statusText}</dd>
                </div>
                <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(feedback.durationMs)}</dd>
                </div>
                <div>
                    <dt>Message</dt>
                    <dd>{message}</dd>
                </div>
            </dl>
        </section>
    );
}

function RallarServerPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    control,
    onGlobalValueChange,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    control: RallarBlackBoxControlSnapshot;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);
    const variables = useMemo(
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
                    authSession?.username ?? config?.actor ?? bootstrap.actor,
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
    const initialDraft = useMemo(
        () =>
            applyRallarServerEndpointPreset(
                RALLAR_SERVER_ENDPOINT_PRESETS[0],
                variables,
            ),
        [variables],
    );
    const defaultServerDraft = useMemo<RallarServerWorkbenchDraft>(
        () => ({
            apiBaseUrl:
                globalValues?.apiBaseUrl ??
                config?.apiBaseUrl ??
                bootstrap.apiBaseUrl,
            selectedPresetId: RALLAR_SERVER_ENDPOINT_PRESETS[0].presetId,
            method: initialDraft.method,
            path: initialDraft.path,
            headersText: initialDraft.headersText,
            queryText: initialDraft.queryText,
            bodyText: initialDraft.bodyText,
            responseBodyMode: initialDraft.responseBodyMode,
            attachAuth: initialDraft.attachAuth,
            timeoutMs: 5_000,
        }),
        [
            bootstrap.apiBaseUrl,
            config?.apiBaseUrl,
            globalValues?.apiBaseUrl,
            initialDraft,
        ],
    );
    const collectionTemplates = useMemo(
        () => createRallarServerRestCollectionTemplates(variables),
        [variables],
    );
    const defaultCollectionDraft =
        useMemo<RallarServerRestCollectionDraft>(() => {
            const collection = collectionTemplates[0];
            return {
                selectedCollectionId: collection.collectionId,
                collection,
                variables: collection.variables ?? {},
            };
        }, [collectionTemplates]);
    const [initialServerDraft] = useState(() => {
        const stored = readRallarServerWorkbenchDraft(
            browserUiStorage(),
            defaultServerDraft,
        );
        return {
            draft: stored ?? defaultServerDraft,
            restored: Boolean(stored),
        };
    });
    const [initialCollectionDraft] = useState(
        () =>
            readRallarServerRestCollectionDraft(
                browserUiStorage(),
                defaultCollectionDraft,
            ) ?? defaultCollectionDraft,
    );
    const [serverDraftEdited, setServerDraftEdited] = useState(
        initialServerDraft.restored,
    );
    const [apiBaseUrl, setApiBaseUrl] = useState(
        initialServerDraft.draft.apiBaseUrl,
    );
    const [selectedPresetId, setSelectedPresetId] = useState(
        initialServerDraft.draft.selectedPresetId,
    );
    const [serverOpenApiPresets, setServerOpenApiPresets] = useState<
        readonly RallarServerEndpointPreset[]
    >([]);
    const [method, setMethod] = useState<RallarServerRestMethod>(
        initialServerDraft.draft.method,
    );
    const [path, setPath] = useState(initialServerDraft.draft.path);
    const [headersText, setHeadersText] = useState(
        initialServerDraft.draft.headersText,
    );
    const [queryText, setQueryText] = useState(
        initialServerDraft.draft.queryText,
    );
    const [bodyText, setBodyText] = useState(initialServerDraft.draft.bodyText);
    const [responseBodyMode, setResponseBodyMode] =
        useState<RallarServerResponseBodyMode>(
            initialServerDraft.draft.responseBodyMode,
        );
    const [attachAuth, setAttachAuth] = useState(
        initialServerDraft.draft.attachAuth,
    );
    const [timeoutMs, setTimeoutMs] = useState(
        initialServerDraft.draft.timeoutMs,
    );
    const [busy, setBusy] = useState(false);
    const [openApiBusy, setOpenApiBusy] = useState(false);
    const [localError, setLocalError] = useState<string | undefined>();
    const [response, setResponse] = useState<
        RallarServerRestResponse | undefined
    >();
    const [requestFeedback, setRequestFeedback] =
        useState<RallarServerRequestFeedback>({
            state: 'idle',
        });
    const [selectedCollectionId, setSelectedCollectionId] = useState(
        initialCollectionDraft.selectedCollectionId,
    );
    const [collectionText, setCollectionText] = useState(() =>
        json(initialCollectionDraft.collection),
    );
    const [collectionVariablesText, setCollectionVariablesText] = useState(() =>
        json(initialCollectionDraft.variables),
    );
    const [collectionBusy, setCollectionBusy] = useState(false);
    const [collectionError, setCollectionError] = useState<
        string | undefined
    >();
    const [collectionResults, setCollectionResults] = useState<
        readonly RallarServerRestCollectionStepResult[]
    >([]);
    const allPresets = useMemo(
        () => [...RALLAR_SERVER_ENDPOINT_PRESETS, ...serverOpenApiPresets],
        [serverOpenApiPresets],
    );
    const activePreset =
        allPresets.find((preset) => preset.presetId === selectedPresetId) ??
        RALLAR_SERVER_ENDPOINT_PRESETS[0];
    const requestInput: RallarServerRestRequestInput = {
        apiBaseUrl,
        method,
        path,
        headersText,
        queryText,
        bodyText,
        responseBodyMode,
        attachAuth,
        timeoutMs,
        authSession,
        forbidPlaceholderBaseUrl: providerMode === 'browser-rallar',
    };
    const commandPreview = useMemo(() => {
        try {
            return json(
                redactRallarServerValue(
                    toRallarServerBlackBoxCommand(
                        requestInput,
                        'rallar-server-rest-request',
                    ),
                    authSession,
                ),
            );
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }, [requestInput]);
    const responseBodyText = response
        ? response.bodyKind === 'json'
            ? json(redactRallarServerValue(response.bodyJson, authSession))
            : response.bodyText
              ? redactRallarServerText(response.bodyText, authSession)
              : '-'
        : 'No response';
    const responseHeadersText = response
        ? json(redactRallarServerValue(response.headers, authSession))
        : '{}';
    const latestBody = response?.bodyJson;
    const latestGroupId = findStringDeep(latestBody, ['groupId', 'roomId']);
    const latestClientId = findStringDeep(latestBody, [
        'clientId',
        'principalId',
        'username',
    ]);
    const latestSessionId = findStringDeep(latestBody, ['sessionId']);

    useEffect(() => {
        if (!serverDraftEdited) {
            setApiBaseUrl(
                globalValues?.apiBaseUrl ??
                    config?.apiBaseUrl ??
                    bootstrap.apiBaseUrl,
            );
        }
    }, [
        bootstrap.apiBaseUrl,
        config?.apiBaseUrl,
        globalValues?.apiBaseUrl,
        serverDraftEdited,
    ]);

    useEffect(() => {
        writeRallarServerWorkbenchDraft(
            browserUiStorage(),
            {
                apiBaseUrl,
                selectedPresetId,
                method,
                path,
                headersText,
                queryText,
                bodyText,
                responseBodyMode,
                attachAuth,
                timeoutMs,
            },
            uiSecretValues(undefined, authSession),
        );
    }, [
        apiBaseUrl,
        attachAuth,
        authSession?.accessToken,
        bodyText,
        headersText,
        method,
        path,
        queryText,
        responseBodyMode,
        selectedPresetId,
        timeoutMs,
    ]);

    useEffect(() => {
        try {
            writeRallarServerRestCollectionDraft(
                browserUiStorage(),
                {
                    selectedCollectionId,
                    collection: parseRallarServerCollectionText(collectionText),
                    variables: parseRallarServerCollectionVariablesText(
                        collectionVariablesText,
                    ),
                },
                uiSecretValues(undefined, authSession),
            );
        } catch {
            // Invalid collection drafts remain editable but are not persisted.
        }
    }, [
        authSession?.accessToken,
        collectionText,
        collectionVariablesText,
        selectedCollectionId,
    ]);

    const applyPreset = (preset: RallarServerEndpointPreset): void => {
        const draft = applyRallarServerEndpointPreset(preset, variables);
        setServerDraftEdited(true);
        setSelectedPresetId(preset.presetId);
        setMethod(draft.method);
        setPath(draft.path);
        setHeadersText(draft.headersText);
        setQueryText(draft.queryText);
        setBodyText(draft.bodyText);
        setResponseBodyMode(draft.responseBodyMode);
        setAttachAuth(draft.attachAuth);
        setLocalError(undefined);
    };

    const sendRequest = async (): Promise<void> => {
        setBusy(true);
        setLocalError(undefined);
        setResponse(undefined);
        let requestSummary: RallarServerRequestFeedback = {
            state: 'sending',
            method,
            path,
            atEpochMs: Date.now(),
        };
        try {
            const request = buildRallarServerRestRequest(requestInput);
            requestSummary = {
                state: 'sending',
                method: request.method,
                path,
                url: request.url,
                atEpochMs: Date.now(),
            };
            setRequestFeedback(requestSummary);
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                {
                    kind: 'event',
                    topic: 'rallar.server.rest.request.started',
                    severity: 'info',
                    actor: authSession?.username,
                    payload: {
                        method: request.method,
                        path,
                        url: redactRallarServerUrl(request.url, authSession),
                        attachAuth,
                        responseBodyMode,
                        timeoutMs,
                    },
                },
                `Rallar Server ${request.method} request started`,
            );

            const nextResponse =
                await executeRallarServerRestRequest(requestInput);
            setResponse(nextResponse);
            const nextFeedback: RallarServerRequestFeedback = {
                state: nextResponse.ok ? 'success' : 'error',
                method: request.method,
                path,
                url: nextResponse.url,
                status: nextResponse.status,
                statusText: nextResponse.statusText,
                durationMs: nextResponse.durationMs,
                errorKind: nextResponse.error?.kind,
                message:
                    nextResponse.error?.message ??
                    (nextResponse.ok
                        ? 'Request completed successfully.'
                        : 'Request failed.'),
                atEpochMs: Date.now(),
            };
            setRequestFeedback(nextFeedback);
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                {
                    kind: nextResponse.ok ? 'event' : 'diagnostic',
                    topic: nextResponse.ok
                        ? 'rallar.server.rest.request.completed'
                        : 'rallar.server.rest.request.failed',
                    severity: nextResponse.ok ? 'info' : 'error',
                    actor: authSession?.username,
                    payload: {
                        method: request.method,
                        path,
                        url: redactRallarServerUrl(
                            nextResponse.url,
                            authSession,
                        ),
                        status: nextResponse.status,
                        statusText: nextResponse.statusText,
                        durationMs: nextResponse.durationMs,
                        error: nextResponse.error,
                        bodyKind: nextResponse.bodyKind,
                        bodyText: nextResponse.bodyText
                            ? redactRallarServerText(
                                  nextResponse.bodyText,
                                  authSession,
                              )
                            : undefined,
                        bodyJson:
                            nextResponse.bodyJson === undefined
                                ? undefined
                                : redactRallarServerValue(
                                      nextResponse.bodyJson,
                                      authSession,
                                  ),
                    },
                },
                nextResponse.ok
                    ? `Rallar Server ${request.method} request completed`
                    : `Rallar Server ${request.method} request failed`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setRequestFeedback({
                ...requestSummary,
                state: 'error',
                errorKind: 'request-build',
                message,
                atEpochMs: Date.now(),
            });
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                {
                    kind: 'diagnostic',
                    topic: 'rallar.server.rest.request.failed',
                    severity: 'error',
                    actor: authSession?.username,
                    payload: {
                        method: requestSummary.method,
                        path: requestSummary.path,
                        url: requestSummary.url
                            ? redactRallarServerUrl(
                                  requestSummary.url,
                                  authSession,
                              )
                            : undefined,
                        error: {
                            kind: 'request-build',
                            message: redactRallarServerText(
                                message,
                                authSession,
                            ),
                        },
                    },
                },
                `Rallar Server ${requestSummary.method ?? 'REST'} request failed`,
            );
        } finally {
            setBusy(false);
        }
    };

    const refreshOpenApi = async (): Promise<void> => {
        setOpenApiBusy(true);
        setLocalError(undefined);
        try {
            setServerOpenApiPresets(
                await fetchRallarServerOpenApiEndpoints(apiBaseUrl),
            );
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            setOpenApiBusy(false);
        }
    };

    const copyCurl = (): void => {
        try {
            void navigator.clipboard?.writeText(
                toRallarServerCurl(requestInput),
            );
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const copyCommand = (): void => {
        void navigator.clipboard?.writeText(commandPreview);
    };

    const applyCollectionTemplate = (collectionId: string): void => {
        const template = collectionTemplates.find(
            (entry) => entry.collectionId === collectionId,
        );
        if (!template) {
            return;
        }
        setSelectedCollectionId(template.collectionId);
        setCollectionText(json(template));
        setCollectionVariablesText(json(template.variables ?? {}));
        setCollectionResults([]);
        setCollectionError(undefined);
    };

    const addCurrentRequestToCollection = (): void => {
        try {
            const collection = parseRallarServerCollectionText(collectionText);
            const bodyValue =
                bodyText.trim().length === 0 || method === 'GET'
                    ? undefined
                    : (JSON.parse(bodyText) as unknown);
            const nextStep = {
                stepId: `request-${collection.steps.length + 1}`,
                label: activePreset.label,
                request: {
                    method,
                    path,
                    headers: JSON.parse(headersText || '{}') as Record<
                        string,
                        unknown
                    >,
                    query: JSON.parse(queryText || '{}') as Record<
                        string,
                        unknown
                    >,
                    ...(bodyValue === undefined ? {} : { body: bodyValue }),
                    responseBodyMode,
                    attachAuth,
                    timeoutMs,
                },
                expect: {
                    status: response?.status ?? 200,
                },
            };
            setCollectionText(
                json({
                    ...collection,
                    steps: [...collection.steps, nextStep],
                }),
            );
            setCollectionError(undefined);
        } catch (error) {
            setCollectionError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const runCollection = async (): Promise<void> => {
        setCollectionBusy(true);
        setCollectionError(undefined);
        setCollectionResults([]);
        try {
            const collection = parseRallarServerCollectionText(collectionText);
            let collectionVariables: RallarServerRestCollectionVariables = {
                ...(collection.variables ?? {}),
                ...parseRallarServerCollectionVariablesText(
                    collectionVariablesText,
                ),
            };
            const nextResults: RallarServerRestCollectionStepResult[] = [];

            for (const step of collection.steps) {
                const stepResponse = await executeRallarServerRestRequest(
                    buildRallarServerCollectionStepRequestInput({
                        step,
                        apiBaseUrl,
                        variables: collectionVariables,
                        authSession,
                        defaultTimeoutMs: timeoutMs,
                        forbidPlaceholderBaseUrl:
                            providerMode === 'browser-rallar',
                    }),
                );
                const assertions = assertRallarServerRestResponse(
                    stepResponse,
                    step.expect,
                    collectionVariables,
                );
                const extracted = extractRallarServerRestVariables(
                    stepResponse,
                    step.extract,
                );
                const ok = assertions.every((assertion) => assertion.ok);
                const result = {
                    stepId: step.stepId,
                    label: step.label,
                    ok,
                    response: stepResponse,
                    assertions,
                    extracted,
                };
                nextResults.push(result);
                setCollectionResults([...nextResults]);
                collectionVariables = {
                    ...collectionVariables,
                    ...extracted,
                };
                setCollectionVariablesText(json(collectionVariables));
                if (!ok) {
                    break;
                }
            }
        } catch (error) {
            setCollectionError(
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            setCollectionBusy(false);
        }
    };

    const copyCollection = (): void => {
        try {
            const collection = parseRallarServerCollectionText(collectionText);
            const collectionVariables =
                parseRallarServerCollectionVariablesText(
                    collectionVariablesText,
                );
            void navigator.clipboard?.writeText(
                redactedJson(
                    {
                        ...collection,
                        variables: collectionVariables,
                    },
                    state,
                    authSession,
                ),
            );
        } catch (error) {
            setCollectionError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const copyCollectionRecipe = (): void => {
        try {
            const collection = parseRallarServerCollectionText(collectionText);
            const collectionVariables =
                parseRallarServerCollectionVariablesText(
                    collectionVariablesText,
                );
            const recipe = toRallarServerRestCollectionRecipe({
                collection,
                apiBaseUrl,
                variables: collectionVariables,
                authSession,
                defaultTimeoutMs: timeoutMs,
                forbidPlaceholderBaseUrl: providerMode === 'browser-rallar',
            });
            void navigator.clipboard?.writeText(
                redactedJson(recipe, state, authSession),
            );
        } catch (error) {
            setCollectionError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    return (
        <section className="panel rallar-server-panel">
            <div className="panel-heading">
                <h2>Rallar Server</h2>
                <span
                    className={`pill ${authSession ? 'good' : providerMode === 'browser-rallar' ? 'bad' : 'muted'}`}
                >
                    {authSession ? 'authenticated' : 'no session'}
                </span>
            </div>
            <dl className="config-list rest-context-list">
                <div>
                    <dt>API base</dt>
                    <dd>{apiBaseUrl}</dd>
                </div>
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>User</dt>
                    <dd>{authSession?.username ?? config?.actor ?? 'none'}</dd>
                </div>
                <div>
                    <dt>Client</dt>
                    <dd>{authSession?.clientId ?? config?.actor ?? 'none'}</dd>
                </div>
                <div>
                    <dt>Session</dt>
                    <dd>
                        {authSession?.sessionId ?? config?.sessionId ?? 'none'}
                    </dd>
                </div>
                <div>
                    <dt>Access token</dt>
                    <dd>{authSession?.accessToken ? 'redacted' : 'none'}</dd>
                </div>
                <div>
                    <dt>Control</dt>
                    <dd>{control.state}</dd>
                </div>
                <div>
                    <dt>Preset source</dt>
                    <dd>
                        {serverOpenApiPresets.length > 0
                            ? 'server OpenAPI'
                            : 'local OpenAPI'}
                    </dd>
                </div>
            </dl>
            <CollapsiblePanelSection
                title="REST Request Inputs"
                meta={`${method} ${path}`}
            >
                <div className="rest-workbench-grid">
                    <label className="field">
                        <span>Endpoint</span>
                        <select
                            value={selectedPresetId}
                            onChange={(event) => {
                                const nextPreset = allPresets.find(
                                    (preset) =>
                                        preset.presetId === event.target.value,
                                );
                                if (nextPreset) {
                                    applyPreset(nextPreset);
                                }
                            }}
                        >
                            {allPresets.map((preset) => (
                                <option
                                    key={preset.presetId}
                                    value={preset.presetId}
                                >
                                    {preset.tag} - {preset.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setApiBaseUrl(event.target.value);
                            }}
                        />
                    </label>
                    <label className="field compact-field">
                        <span>Method</span>
                        <select
                            value={method}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setMethod(
                                    event.target
                                        .value as RallarServerRestMethod,
                                );
                            }}
                        >
                            {(['GET', 'POST', 'PUT', 'DELETE'] as const).map(
                                (entry) => (
                                    <option key={entry} value={entry}>
                                        {entry}
                                    </option>
                                ),
                            )}
                        </select>
                    </label>
                    <label className="field compact-field">
                        <span>Timeout</span>
                        <input
                            type="number"
                            min={0}
                            value={timeoutMs}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setTimeoutMs(Number(event.target.value));
                            }}
                        />
                    </label>
                    <label className="field rest-path-field">
                        <span>Path</span>
                        <input
                            value={path}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setPath(event.target.value);
                            }}
                        />
                    </label>
                    <label className="field compact-field">
                        <span>Body Mode</span>
                        <select
                            value={responseBodyMode}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setResponseBodyMode(
                                    event.target
                                        .value as RallarServerResponseBodyMode,
                                );
                            }}
                        >
                            {(['auto', 'json', 'text', 'none'] as const).map(
                                (entry) => (
                                    <option key={entry} value={entry}>
                                        {entry}
                                    </option>
                                ),
                            )}
                        </select>
                    </label>
                    <label className="check-field rest-auth-check">
                        <input
                            type="checkbox"
                            checked={attachAuth}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setAttachAuth(event.target.checked);
                            }}
                        />
                        <span>Attach auth</span>
                    </label>
                </div>
                <div className="rest-editors">
                    <label className="json-editor">
                        <span>Query JSON</span>
                        <textarea
                            value={queryText}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setQueryText(event.target.value);
                            }}
                            spellCheck={false}
                        />
                    </label>
                    <label className="json-editor">
                        <span>Headers JSON</span>
                        <textarea
                            value={headersText}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setHeadersText(event.target.value);
                            }}
                            spellCheck={false}
                        />
                    </label>
                    <label className="json-editor">
                        <span>Body JSON</span>
                        <textarea
                            value={bodyText}
                            onChange={(event) => {
                                setServerDraftEdited(true);
                                setBodyText(event.target.value);
                            }}
                            spellCheck={false}
                            disabled={method === 'GET'}
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="rest-actions">
                <button
                    type="button"
                    onClick={() => void sendRequest()}
                    disabled={busy}
                >
                    {busy ? 'Sending' : 'Send'}
                </button>
                <button
                    type="button"
                    onClick={() => applyPreset(activePreset)}
                    disabled={busy}
                >
                    Reset Preset
                </button>
                <button
                    type="button"
                    onClick={() => void refreshOpenApi()}
                    disabled={openApiBusy}
                >
                    {openApiBusy ? 'Loading OpenAPI' : 'Refresh OpenAPI'}
                </button>
                <button type="button" onClick={copyCurl}>
                    Copy cURL
                </button>
                <button type="button" onClick={copyCommand}>
                    Copy Command
                </button>
                <button
                    type="button"
                    disabled={!latestGroupId || !onGlobalValueChange}
                    onClick={() =>
                        latestGroupId &&
                        onGlobalValueChange?.('roomId', latestGroupId)
                    }
                >
                    Use group in Quick Test
                </button>
                <button
                    type="button"
                    disabled={!latestClientId || !onGlobalValueChange}
                    onClick={() =>
                        latestClientId &&
                        onGlobalValueChange?.('clientId', latestClientId)
                    }
                >
                    Use client globally
                </button>
                <button
                    type="button"
                    disabled={!latestSessionId || !onGlobalValueChange}
                    onClick={() =>
                        latestSessionId &&
                        onGlobalValueChange?.('sessionId', latestSessionId)
                    }
                >
                    Use session globally
                </button>
            </div>
            <RallarServerRequestFeedbackPanel
                feedback={requestFeedback}
                authSession={authSession}
            />
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession),
                    )}
                </div>
            )}
            <section className="rest-collection-panel">
                <div className="section-heading">
                    <h3>REST Collection</h3>
                    <span>{collectionResults.length} results</span>
                </div>
                <div className="rest-collection-toolbar">
                    <label className="field">
                        <span>Collection Template</span>
                        <select
                            value={selectedCollectionId}
                            onChange={(event) =>
                                applyCollectionTemplate(event.target.value)
                            }
                        >
                            {collectionTemplates.map((template) => (
                                <option
                                    key={template.collectionId}
                                    value={template.collectionId}
                                >
                                    {template.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        onClick={addCurrentRequestToCollection}
                    >
                        Add Current Request
                    </button>
                    <button
                        type="button"
                        onClick={() => void runCollection()}
                        disabled={collectionBusy}
                    >
                        {collectionBusy
                            ? 'Running Collection'
                            : 'Run Collection'}
                    </button>
                    <button type="button" onClick={copyCollection}>
                        Copy Collection
                    </button>
                    <button type="button" onClick={copyCollectionRecipe}>
                        Copy Collection Recipe
                    </button>
                </div>
                <div className="rest-collection-editors">
                    <label className="json-editor">
                        <span>Variables JSON</span>
                        <textarea
                            value={collectionVariablesText}
                            onChange={(event) =>
                                setCollectionVariablesText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <label className="json-editor">
                        <span>Collection JSON</span>
                        <textarea
                            value={collectionText}
                            onChange={(event) =>
                                setCollectionText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                </div>
                {collectionError && (
                    <div className="workbench-error" role="status">
                        {redactRallarBlackBoxValue(
                            collectionError,
                            uiRedactionOptions(state, authSession),
                        )}
                    </div>
                )}
                <div className="rest-collection-results">
                    {collectionResults.length === 0 && (
                        <div className="empty-state">
                            No collection results yet
                        </div>
                    )}
                    {collectionResults.map((result) => (
                        <article
                            className="rest-collection-result-row"
                            key={result.stepId}
                        >
                            <div>
                                <strong>{result.label}</strong>
                                <small>
                                    {result.stepId} -{' '}
                                    {formatDuration(result.response.durationMs)}
                                </small>
                            </div>
                            <span
                                className={`pill ${result.ok ? 'good' : 'bad'}`}
                            >
                                {result.response.status ||
                                    result.response.error?.kind ||
                                    'failed'}
                            </span>
                            <div className="rest-assertion-list">
                                {result.assertions.map((assertion) => (
                                    <span
                                        className={`pill ${assertion.ok ? 'good' : 'bad'}`}
                                        key={assertion.label}
                                    >
                                        {assertion.label}
                                    </span>
                                ))}
                            </div>
                            {Object.keys(result.extracted).length > 0 && (
                                <pre className="mini-json">
                                    {redactedJson(
                                        result.extracted,
                                        state,
                                        authSession,
                                    )}
                                </pre>
                            )}
                        </article>
                    ))}
                </div>
            </section>
            <div className="rest-response-grid">
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Response</h3>
                        <span
                            className={`pill ${response?.ok ? 'good' : response ? 'bad' : 'muted'}`}
                        >
                            {response
                                ? response.status > 0
                                    ? String(response.status)
                                    : (response.error?.kind ?? 'failed')
                                : 'idle'}
                        </span>
                    </div>
                    <dl className="result-summary">
                        <div>
                            <dt>Status</dt>
                            <dd>
                                {response
                                    ? `${response.status} ${response.statusText}`
                                    : '-'}
                            </dd>
                        </div>
                        <div>
                            <dt>Duration</dt>
                            <dd>{formatDuration(response?.durationMs)}</dd>
                        </div>
                        <div>
                            <dt>Body</dt>
                            <dd>{response?.bodyKind ?? '-'}</dd>
                        </div>
                        <div>
                            <dt>Error</dt>
                            <dd>{response?.error?.kind ?? 'none'}</dd>
                        </div>
                    </dl>
                    {response?.error && (
                        <div className="workbench-error" role="status">
                            {redactRallarServerValue(
                                response.error.message,
                                authSession,
                            )}
                        </div>
                    )}
                    <pre className="json-block">{responseBodyText}</pre>
                </section>
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Headers</h3>
                        <span>
                            {response
                                ? redactRallarServerUrl(
                                      response.url,
                                      authSession,
                                  )
                                : '-'}
                        </span>
                    </div>
                    <pre className="json-block">{responseHeadersText}</pre>
                </section>
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Command</h3>
                        <span>{method}</span>
                    </div>
                    <pre className="json-block">{commandPreview}</pre>
                </section>
            </div>
        </section>
    );
}


export default function App() {
    const {
        state,
        control,
        bootstrapping,
        busy,
        runState,
        lastAction,
        lastError,
        loadedFixtureId,
        bootstrap,
    } = useRallarBlackBoxRuntimeStore();
    const queueRows = useMemo(() => deriveQueue(state), [state]);
    const history = selectRallarBlackBoxCommandHistory(state);
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const now = useNow(250);
    const [selectedCommandId, setSelectedCommandId] = useState<
        string | undefined
    >(() => readStoredSelectedCommandId(browserUiStorage()));
    const [runnerDistributedSelection, setRunnerDistributedSelection] =
        useState<RunnerDistributedRunSelection | undefined>();
    const [navigation, setNavigation] = useState<AppNavigationState>(() =>
        readInitialAppNavigation(),
    );
    const {
        mode: activeMode,
        tab: activeTab,
        advancedSurface: activeAdvancedSurface,
    } = navigation;
    const [authSession, setAuthSession] = useState<AuthSession | undefined>(
        () =>
            bootstrap.rallarAgentSessionTicket
                ? undefined
                : readCurrentAuthSession(),
    );
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState<string | undefined>();
    const defaultGlobalValues = useMemo(
        () => commandCenterGlobalValuesFromState(state, bootstrap, authSession),
        [
            authSession?.clientId,
            authSession?.sessionId,
            authSession?.username,
            bootstrap.actor,
            bootstrap.apiBaseUrl,
            bootstrap.roomId,
            bootstrap.sessionId,
            state.currentConfig,
        ],
    );
    const [globalValues, setGlobalValues] =
        useState<CommandCenterGlobalValues>(defaultGlobalValues);
    const [globalValuesEdited, setGlobalValuesEdited] = useState(false);
    const browserStatus = useMemo(
        () => deriveRallarBrowserStatus(state, globalValues),
        [globalValues, state],
    );
    const lastGlobalAuthKey = useRef<string | undefined>(
        authSession
            ? `${authSession.clientId ?? authSession.username}:${authSession.sessionId}`
            : undefined,
    );
    const requiresLogin = bootstrap.providerMode === 'browser-rallar';
    const canEnterApp = !requiresLogin || Boolean(authSession);

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const handlePopState = (): void =>
            setNavigation(readInitialAppNavigation());
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    useEffect(() => {
        if (!requiresLogin) {
            return;
        }

        let cancelled = false;
        let unsubscribe: (() => void) | undefined;
        void loadBrowserRallarFacade()
            .then((facade) => {
                if (cancelled) {
                    return;
                }

                facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
                unsubscribe = facade.auth.onChange((state) => {
                    if (bootstrap.rallarAgentSessionTicket) {
                        return;
                    }
                    const nextSession = readAuthSessionFromRallarAuthState(state);
                    setAuthSession(nextSession);
                    if (!nextSession) {
                        setAuthBusy(false);
                    }
                }, { emitCurrent: true });
            })
            .catch(() => {
                // Connect-time diagnostics will surface configuration conflicts.
            });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, [bootstrap.apiBaseUrl, bootstrap.rallarAgentSessionTicket, requiresLogin]);

    useEffect(() => {
        if (requiresLogin && authSession) {
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(
                    authSession,
                    bootstrap.apiBaseUrl,
                ),
            );
        }
    }, [authSession, bootstrap.apiBaseUrl, requiresLogin]);

    useEffect(() => {
        if (
            !requiresLogin ||
            !bootstrap.rallarAgentSessionTicket
        ) {
            return;
        }

        let cancelled = false;
        setAuthBusy(true);
        setAuthError(undefined);

        void (async () => {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
            clearSession();
            const session = await consumeBootstrapAgentSessionTicket(
                bootstrap.rallarAgentSessionTicket ?? '',
                bootstrap.apiBaseUrl,
            );
            if (cancelled) {
                return;
            }

            writeSession(session);
            scrubAgentSessionTicketFromUrl();
            setAuthSession(session);
            setAuthBusy(false);
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                {
                    ...bootstrapPatchFromAuthSession(
                        session,
                        bootstrap.apiBaseUrl,
                    ),
                    rallarAgentSessionTicket: undefined,
                },
            );
        })()
            .catch((error) => {
                if (!cancelled) {
                    setAuthError(authErrorMessage(error));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setAuthBusy(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        bootstrap.apiBaseUrl,
        bootstrap.rallarAgentSessionTicket,
        requiresLogin,
    ]);

    useEffect(() => {
        const authKey = authSession
            ? `${authSession.clientId ?? authSession.username}:${authSession.sessionId}`
            : undefined;
        const authChanged = authKey !== lastGlobalAuthKey.current;
        lastGlobalAuthKey.current = authKey;

        setGlobalValues((current) => {
            if (!globalValuesEdited) {
                return sameCommandCenterGlobalValues(
                    current,
                    defaultGlobalValues,
                )
                    ? current
                    : defaultGlobalValues;
            }

            const nextValues = {
                ...current,
                apiBaseUrl:
                    current.apiBaseUrl || defaultGlobalValues.apiBaseUrl,
                applicationId:
                    current.applicationId || defaultGlobalValues.applicationId,
                workspaceId:
                    current.workspaceId || defaultGlobalValues.workspaceId,
                roomId: current.roomId || defaultGlobalValues.roomId,
                clientId:
                    authChanged && authSession
                        ? (authSession.clientId ?? authSession.username)
                        : current.clientId || defaultGlobalValues.clientId,
                sessionId:
                    authChanged && authSession
                        ? authSession.sessionId
                        : current.sessionId || defaultGlobalValues.sessionId,
            };

            return sameCommandCenterGlobalValues(current, nextValues)
                ? current
                : nextValues;
        });
    }, [
        authSession?.clientId,
        authSession?.sessionId,
        authSession?.username,
        defaultGlobalValues,
        globalValuesEdited,
    ]);

    useEffect(() => {
        if (canEnterApp && activeMode === 'black-box-runner') {
            rallarBlackBoxRuntimeStore.ensureBootstrapped();
        }
    }, [activeMode, canEnterApp]);

    useEffect(() => {
        if (activeCommand) {
            setSelectedCommandId(activeCommand.commandId);
            return;
        }

        if (!selectedCommandId && history.length > 0) {
            setSelectedCommandId(history.at(-1)?.commandId);
        }
    }, [activeCommand, history, selectedCommandId]);

    useEffect(() => {
        writeStoredSelectedCommandId(browserUiStorage(), selectedCommandId);
    }, [selectedCommandId]);

    const selectedResult = findSelectedResult(history, selectedCommandId);
    const selectNavigation = (nextNavigation: AppNavigationState): void => {
        setNavigation(nextNavigation);
        writeAppNavigationToUrl(nextNavigation);
    };
    const selectTab = (
        tab: AppTabId,
        advancedSurface?: RunnerAdvancedSurfaceId,
    ): void => {
        const visibleTab = visibleAppTabForTab(tab);
        const mode = appTabInMode(visibleTab, activeMode)
            ? activeMode
            : appModeForTab(visibleTab);
        selectNavigation(
            normalizeAppNavigation({
                mode,
                tab,
                advancedSurface,
            }),
        );
    };
    const selectMode = (mode: AppModeId): void => {
        selectNavigation(
            normalizeAppNavigation({
                mode,
                tab: appTabInMode(activeTab, mode)
                    ? activeTab
                    : defaultAppTabForMode(mode),
                advancedSurface: activeAdvancedSurface,
            }),
        );
    };
    const updateGlobalValue = <K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void => {
        const nextValues = {
            ...globalValues,
            [key]: value,
        };
        setGlobalValues(nextValues);
        setGlobalValuesEdited(true);
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromGlobalValues(nextValues),
        );
    };
    const resetGlobalValues = (): void => {
        setGlobalValues(defaultGlobalValues);
        setGlobalValuesEdited(false);
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromGlobalValues(defaultGlobalValues),
        );
    };

    const logout = async (): Promise<void> => {
        setAuthBusy(true);
        setAuthError(undefined);
        try {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
            await facade.disconnect();
            await facade.auth.logout();
        } catch (error) {
            setAuthError(authErrorMessage(error));
        } finally {
            setAuthSession(readCurrentAuthSession());
            setAuthBusy(false);
        }
    };

    if (requiresLogin && bootstrap.rallarAgentSessionTicket) {
        return (
            <main className="auth-shell">
                <section className="auth-panel">
                    <div className="auth-heading">
                        <p className="eyebrow">Rallar Kit</p>
                        <h1>Connecting agent session</h1>
                        <span className="pill active">one-time link</span>
                    </div>
                    <p className="auth-guidance">
                        Preparing a fresh per-tab session for this agent.
                    </p>
                    {authBusy && (
                        <div className="command-center-status" role="status">
                            Consuming one-time agent ticket...
                        </div>
                    )}
                    {authError && (
                        <div className="workbench-error" role="status">
                            {authError}
                        </div>
                    )}
                </section>
            </main>
        );
    }

    if (requiresLogin && !authSession) {
        return (
            <LoginScreen
                bootstrap={bootstrap}
                onAuthenticated={(session) => {
                    setAuthError(undefined);
                    setAuthSession(session);
                }}
            />
        );
    }

    return (
        <main className={`app-shell mode-${activeMode}`}>
            <Header
                mode={activeMode}
                state={state}
                control={control}
                bootstrap={bootstrap}
                globalValues={globalValues}
                browserStatus={browserStatus}
                bootstrapping={bootstrapping}
                lastAction={lastAction}
                authSession={authSession}
                authBusy={authBusy}
                onLogout={() => void logout()}
            />
            {authError && (
                <div className="workbench-error app-error" role="status">
                    {authError}
                </div>
            )}
            <GlobalContextBar
                values={globalValues}
                authSession={authSession}
                onChange={updateGlobalValue}
                onReset={resetGlobalValues}
            />
            <AppModeSwitch activeMode={activeMode} onSelect={selectMode} />
            <AppTabs
                activeMode={activeMode}
                activeTab={activeTab}
                onSelect={selectTab}
            />
            <div className="tab-shell">
                <section
                    id="panel-recipes"
                    className="workspace-grid tab-workspace recipes-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-recipes"
                    hidden={activeTab !== 'recipes'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'recipes' && (
                            <RunnerRecipesPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                                authSession={authSession}
                                globalValues={globalValues}
                                busy={busy}
                                runState={runState}
                                lastError={lastError}
                                onDistributedRunStarted={(selection) => {
                                    setRunnerDistributedSelection(selection);
                                    selectTab('runs');
                                }}
                                onOpenTab={selectTab}
                            />
                        )}
                </section>
                <section
                    id="panel-runs"
                    className="workspace-grid tab-workspace runs-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-runs"
                    hidden={activeTab !== 'runs'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'runs' && (
                            <RunnerRunsPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                                authSession={authSession}
                                preferredDistributedRun={runnerDistributedSelection}
                            />
                        )}
                </section>
                <section
                    id="panel-fleet"
                    className="workspace-grid tab-workspace fleet-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-fleet"
                    hidden={activeTab !== 'fleet'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'fleet' && (
                            <RunnerFleetPanel
                                bootstrap={bootstrap}
                                control={control}
                                globalValues={globalValues}
                            />
                        )}
                </section>
                <section
                    id="panel-builder"
                    className="workspace-grid tab-workspace builder-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-builder"
                    hidden={activeTab !== 'builder'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'builder' && (
                        <div
                            id="panel-flow-builder"
                            className="workspace-grid tab-workspace flow-builder-tab-grid"
                        >
                            <FlowBuilderPanel
                                state={state}
                                authSession={authSession}
                                globalValues={globalValues}
                                busy={busy}
                                onSelectCommand={setSelectedCommandId}
                            />
                        </div>
                    )}
                </section>
                <section
                    id="panel-advanced"
                    className="workspace-grid tab-workspace advanced-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-advanced"
                    hidden={activeTab !== 'advanced'}
                >
                    <RunnerAdvancedPanel
                        state={state}
                        bootstrap={bootstrap}
                        control={control}
                        authSession={authSession}
                        globalValues={globalValues}
                        globalValuesEdited={globalValuesEdited}
                        busy={busy}
                        runState={runState}
                        loadedFixtureId={loadedFixtureId}
                        lastError={lastError}
                        selectedCommandId={selectedCommandId}
                        queueRows={queueRows}
                        initialSurface={activeAdvancedSurface}
                        onSelectCommand={setSelectedCommandId}
                        onGlobalValueChange={updateGlobalValue}
                        onSurfaceChange={(surface) =>
                            selectNavigation({
                                mode: 'black-box-runner',
                                tab: 'advanced',
                                advancedSurface: surface,
                            })}
                    />
                </section>
                <section
                    id="panel-quick-test"
                    className="workspace-grid tab-workspace quick-test-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-quick-test"
                    hidden={activeTab !== 'quick-test'}
                >
                    <QuickRallarTestPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        browserStatus={browserStatus}
                        onGlobalValueChange={updateGlobalValue}
                        onOpenAuth={() => selectTab('auth')}
                        onOpenRunnerMode={() => selectMode('black-box-runner')}
                    />
                </section>
                <section
                    id="panel-auth"
                    className="workspace-grid tab-workspace auth-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-auth"
                    hidden={activeTab !== 'auth'}
                >
                    <AuthCommandCenterPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        onAuthenticated={(session) => setAuthSession(session)}
                        onLogout={logout}
                    />
                </section>
                <section
                    id="legacy-panel-manual-rallar"
                    className="workspace-grid tab-workspace manual-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-manual-rallar"
                    hidden={activeTab !== 'manual-rallar'}
                >
                    <ManualRallarSection
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        globalValuesEdited={globalValuesEdited}
                        busy={busy}
                        history={history}
                        selectedCommandId={selectedCommandId}
                        onSelectCommand={setSelectedCommandId}
                        onGlobalValueChange={updateGlobalValue}
                    />
                </section>
                <section
                    id="panel-rooms-clients"
                    className="workspace-grid tab-workspace rooms-clients-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rooms-clients"
                    hidden={activeTab !== 'rooms-clients'}
                >
                    <RoomsClientsPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        onGlobalValueChange={updateGlobalValue}
                    />
                </section>
                <section
                    id="panel-websocket"
                    className="workspace-grid tab-workspace websocket-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-websocket"
                    hidden={activeTab !== 'websocket'}
                >
                    <WebSocketCommandCenterPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        browserStatus={browserStatus}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                    />
                </section>
                <section
                    id="panel-rtc-realtime"
                    className="workspace-grid tab-workspace rtc-realtime-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rtc-realtime"
                    hidden={activeTab !== 'rtc-realtime'}
                >
                    <RtcRealtimePanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                    />
                </section>
                <section
                    id="panel-topology"
                    className="workspace-grid tab-workspace topology-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-topology"
                    hidden={activeTab !== 'topology'}
                >
                    <TopologyGraphPanel
                        state={state}
                        active={activeTab === 'topology'}
                        onSelectCommand={setSelectedCommandId}
                    />
                </section>
                <section
                    id="panel-rtc-diagnostics"
                    className="workspace-grid tab-workspace rtc-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rtc-diagnostics"
                    hidden={activeTab !== 'rtc-diagnostics'}
                >
                    <RtcDiagnosticsPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                    />
                    <FailurePanel state={state} authSession={authSession} />
                    <StatsPanel state={state} />
                </section>
                <section
                    id="panel-rallar-data"
                    className="workspace-grid tab-workspace rallar-data-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rallar-data"
                    hidden={activeTab !== 'rallar-data'}
                >
                    <RallarDataPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                    />
                </section>
                <section
                    id="panel-crdt-health"
                    className="workspace-grid tab-workspace crdt-health-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-crdt-health"
                    hidden={activeTab !== 'crdt-health'}
                >
                    <CrdtHealthPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                    />
                </section>
                <section
                    id="panel-media"
                    className="workspace-grid tab-workspace media-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-media"
                    hidden={activeTab !== 'media'}
                >
                    <MediaConsolePanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                    />
                </section>
                <section
                    id="legacy-panel-local-workbench"
                    className="workspace-grid tab-workspace workbench-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-local-workbench"
                    hidden={activeTab !== 'local-workbench'}
                >
                    <LocalWorkbenchSection
                        state={state}
                        bootstrap={bootstrap}
                        control={control}
                        authSession={authSession}
                        busy={busy}
                        runState={runState}
                        loadedFixtureId={loadedFixtureId}
                        lastError={lastError}
                        queueRows={queueRows}
                        selectedCommandId={selectedCommandId}
                        onSelectCommand={setSelectedCommandId}
                    />
                </section>
                <section
                    id="legacy-panel-run-manager"
                    className="workspace-grid tab-workspace run-manager-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-run-manager"
                    hidden={activeTab !== 'run-manager'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'run-manager' && (
                            <RunManagerPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                            />
                        )}
                </section>
                <section
                    id="legacy-panel-distributed-recipes"
                    className="workspace-grid tab-workspace distributed-recipes-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-distributed-recipes"
                    hidden={activeTab !== 'distributed-recipes'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'distributed-recipes' && (
                            <DistributedRecipesPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                                globalValues={globalValues}
                            />
                        )}
                </section>
                <section
                    id="panel-rallar-trace"
                    className="workspace-grid tab-workspace rallar-trace-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rallar-trace"
                    hidden={activeTab !== 'rallar-trace'}
                >
                    <RallarTracePanel state={state} authSession={authSession} />
                </section>
                <section
                    id="panel-event-stream"
                    className="workspace-grid tab-workspace events-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-event-stream"
                    hidden={activeTab !== 'event-stream'}
                >
                    <ExecutionFocusPanel
                        result={selectedResult}
                        activeCommand={activeCommand}
                        startedAtEpochMs={state.activeCommandStartedAtEpochMs}
                        now={now}
                        redactionOptions={uiRedactionOptions(
                            state,
                            authSession,
                        )}
                    />
                    <CommandHistoryPanel
                        history={history}
                        selectedCommandId={selectedCommandId}
                        onSelect={setSelectedCommandId}
                    />
                    <StatsPanel state={state} />
                    <FailurePanel state={state} authSession={authSession} />
                    <EventStreamPanel state={state} />
                </section>
                <section
                    id="panel-rallar-server"
                    className="workspace-grid tab-workspace server-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rallar-server"
                    hidden={activeTab !== 'rallar-server'}
                >
                    <RallarServerPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        control={control}
                        onGlobalValueChange={updateGlobalValue}
                    />
                </section>
                <section
                    id="legacy-panel-flow-builder"
                    className="workspace-grid tab-workspace flow-builder-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-flow-builder"
                    hidden={activeTab !== 'flow-builder'}
                >
                    <FlowBuilderPanel
                        state={state}
                        authSession={authSession}
                        globalValues={globalValues}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                    />
                </section>
                <section
                    id="legacy-panel-shared-test"
                    className="workspace-grid tab-workspace shared-test-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-shared-test"
                    hidden={activeTab !== 'shared-test'}
                >
                    <SharedTestPanel />
                </section>
            </div>
            <div className="diagnostic-drawer" aria-label="Workspace diagnostics">
                {activeMode === 'rallar' && (
                    <DirectRallarBoundaryPanel
                        state={state}
                        bootstrap={bootstrap}
                        globalValues={globalValues}
                        authSession={authSession}
                        onOpenAuth={() => selectTab('auth')}
                        onOpenRunnerMode={() => selectMode('black-box-runner')}
                    />
                )}
                {activeMode === 'black-box-runner' && (
                    <RunnerModeBoundaryPanel control={control} />
                )}
                <RallarBrowserTraceBar
                    mode={activeMode}
                    state={state}
                    status={browserStatus}
                    onOpenTrace={() => selectTab('rallar-trace')}
                    onOpenEvents={() => selectTab('event-stream')}
                />
            </div>
        </main>
    );
}
