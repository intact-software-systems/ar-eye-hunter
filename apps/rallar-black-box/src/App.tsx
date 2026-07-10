import {
    type ChangeEvent,
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
import {
    consumeAgentSessionTicket,
    issueAgentSessionTickets,
} from '@shared-web/browser/api-integration.ts';
import {
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxCurrentConfig,
    selectRallarBlackBoxEvents,
    selectRallarBlackBoxFailures,
    selectRallarBlackBoxFirstFailure,
    selectRallarBlackBoxLatestStats,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestEventKind,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestRedactionOptions,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestState,
    RallarBlackBoxTestTransport,
} from '@shared-test/rallar-bb-test/types.ts';
import type {
    RallarCrdtOperationBatch,
    RallarCrdtTransportStrategy,
} from '@shared/crdt/crdt-types.ts';
import type { RallarCrdtDocument } from '@shared-web/browser/rallar-crdt.ts';
import {
    isDistributedRunTerminalState,
    type RallarBlackBoxDistributedGroupRef,
    type RallarBlackBoxDistributedRunManifest,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
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
import {
    createRunnerAgentLaunchUrl,
    runnerAgentId,
    runnerNewAgentLaunchSuffix,
} from './runner-agent-launch.ts';
import type { RallarBlackBoxControlSnapshot } from './control-client.ts';
import {
    cancelDistributedRun,
    createDistributedRun,
    controlHttpBaseUrlFromWsUrl,
    fetchDistributedRun,
    fetchDistributedRunArtifactBundle,
    fetchDistributedRuns,
    fetchFleetReportBundle,
    fetchFleetReports,
    fetchControlRunSnapshot,
    fetchControlServerSnapshot,
    rebuildFleetReports,
    resolveDistributedTargets,
    stageDistributedRun,
    startDistributedRun,
    type ControlDistributedRunArtifactBundle,
    type ControlDistributedRunSnapshot,
    type ControlFleetAgentRunOutcome,
    type ControlFleetFailureSignature,
    type ControlFleetReportBundle,
    type ControlFleetReportFilter,
    type ControlFleetReportsResponse,
    type ControlFleetRunReport,
    type ControlFleetTimingDistribution,
    type ControlRunSnapshot,
    type ControlServerSnapshot,
    type RallarBlackBoxDistributedTargetResolution,
} from './control-run-manager.ts';
import {
    deriveControlAgentBoardRows,
    summarizeControlAgentBoardRows,
} from './control-agent-board.ts';
import { FleetWorldMap } from './fleet-world-map.tsx';
import {
    DEFAULT_FLEET_WORLD_MAP_LAYER_STATE,
    FLEET_WORLD_MAP_LAYER_IDS,
    deriveFleetWorldMapModel,
    routeEvidenceFromControlRun,
    type FleetWorldMapLayerId,
    type FleetWorldMapLayerState,
    type FleetWorldMapRegion,
} from './world-map-model.ts';
import {
    resolveBlackBoxControlToken,
    type BlackBoxControlTokenSession,
} from './control-operator-token.ts';
import {
    RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
    RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    recipeFixtureText,
} from './recipe-fixtures.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from './client-defaults.ts';
import {
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    MANUAL_PAYLOAD_PRESETS,
    buildManualWorkbenchCommands,
    deriveManualReceivedMessages,
    manualRtcDeliveryMatrixCommands,
    manualRtcNackProbeCommands,
    manualRtcNegativeRecipeSnippet,
    manualRecipeSnippet,
    parseManualPayload,
    type ManualActionHistoryEntry,
    type ManualDeliveryMode,
    type ManualWorkbenchAction,
    type ManualWorkbenchTransport,
    type ManualWorkbenchValues,
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
    FLOW_BUILDER_TEMPLATES,
    addFlowBuilderStep,
    buildFlowBuilderRecipe,
    buildFlowBuilderRunnerScenario,
    flowBuilderText,
    parseFlowBuilderDefinition,
    templateFlowBuilderText,
    type FlowBuilderDefinition,
    type FlowBuilderStepKind,
} from './flow-builder.ts';
import {
    buildDistributedRunManifest,
    compareDistributedRuns,
    defaultDistributedRecipeTargetIds,
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveDistributedWorldFleetTargetGate,
    deriveRunVerdictView,
    distributedRecipeCommandPreview,
    distributedRecipePreflight,
    distributedRecipeStateTone,
    distributedRecipeTargetRows,
    filterDistributedRuns,
    type DistributedRecipeCatalogItem,
    type DistributedRecipeRolePattern,
    type DistributedRecipeTargetPolicyMode,
} from './distributed-recipes.ts';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles,
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    distributedRecipeSchemaContextText,
    redactDistributedRecipePromptVariables,
    renderDistributedRecipePromptTemplate,
    renderDistributedRecipeValidationFeedback,
    type DistributedRecipePromptTemplateId,
} from './distributed-recipe-authoring-prompts.ts';
import {
    DISTRIBUTED_RUN_SEEDS,
    createSyntheticDistributedRunSeed,
    distributedRunSeedIdFromValue,
    type DistributedRunSeedId,
    type SyntheticDistributedRunSeed,
} from './distributed-run-seeds.ts';
import {
    validateSchemaAuthoringText,
    validateSchemaAuthoringValue,
} from './schema-authoring.ts';
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
    readEventFilters,
    readManualWorkbenchDraft,
    readRallarServerRestCollectionDraft,
    readRallarServerWorkbenchDraft,
    readStoredAppMode,
    readStoredAppTab,
    readStoredSelectedCommandId,
    writeEventFilters,
    writeManualWorkbenchDraft,
    writeRallarServerRestCollectionDraft,
    writeRallarServerWorkbenchDraft,
    writeStoredAppMode,
    writeStoredAppTab,
    writeStoredSelectedCommandId,
    type ManualWorkbenchDraft,
    type RallarServerRestCollectionDraft,
    type RallarServerWorkbenchDraft,
} from './ui-persistence.ts';
import {
    RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT,
    RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF,
    RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG,
    parseRallarBlackBoxSharedTestArtifactBundle,
    type RallarBlackBoxSharedTestArtifactBundleFiles,
    type RallarBlackBoxSharedTestParsedArtifactBundle,
    type RallarBlackBoxSharedTestRecipeCatalogEntry,
} from './shared-test-handoff-fixtures.ts';
import {
    runnerDisabledReason,
    runnerFriendlyErrorMessage,
    runnerReadinessStatus,
    type RecipeLaunchState,
    type RunnerReadinessCheck,
    type RunnerServiceProbeStatus,
    type RunnerTurnProbeStatus,
} from './runner-readiness.ts';
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
import { FilterSelect } from './legacy/shared/FilterSelect.tsx';
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
import {
    SchemaAuthoringPanel,
} from './legacy/shared/schema/SchemaAuthoringPanel.tsx';
import { CommandExamplePicker } from './legacy/shared/schema/CommandExamplePicker.tsx';
import { recordValue } from './legacy/shared/record-value.ts';
import { safeIdSegment } from './legacy/shared/safe-id-segment.ts';
import { sameStringArray } from './legacy/shared/same-string-array.ts';
import { uniqueValues } from './legacy/shared/unique-values.ts';
import { ControlAgentBoardPanel } from './legacy/runner/agents/ControlAgentBoardPanel.tsx';
import { DistributedRunComparePanel } from './legacy/runner/distributed/DistributedRunComparePanel.tsx';
import { DistributedRunMonitorPanel } from './legacy/runner/distributed/DistributedRunMonitorPanel.tsx';
import { DistributedRunSummary } from './legacy/runner/distributed/DistributedRunSummary.tsx';
import { CausalTrailPanel } from './legacy/runner/evidence/CausalTrailPanel.tsx';
import { RunVerdictPanel } from './legacy/runner/evidence/RunVerdictPanel.tsx';
import { RtcDiagnosticsTimeseriesPanel } from './legacy/runner/evidence/rtc/RtcDiagnosticsTimeseriesPanel.tsx';
import { RtcPerformancePanel } from './legacy/runner/evidence/rtc/RtcPerformancePanel.tsx';
import { DistributedRunAnalysisReportPanel } from './legacy/runner/runs/DistributedRunAnalysisReportPanel.tsx';
import { ImportedDistributedArtifactAnalysisPanel } from './legacy/runner/runs/ImportedDistributedArtifactAnalysisPanel.tsx';
import { RunManagerPanel } from './legacy/runner/run-manager/RunManagerPanel.tsx';
import { DistributedRecipePreflightPanel } from './legacy/runner/distributed-recipes/DistributedRecipePreflightPanel.tsx';
import { DistributedManifestPreviewPanel } from './legacy/runner/distributed-recipes/views/DistributedManifestPreviewPanel.tsx';
import { DistributedRecipeCatalogPanel } from './legacy/runner/distributed-recipes/views/DistributedRecipeCatalogPanel.tsx';
import { DistributedRecipesHeader } from './legacy/runner/distributed-recipes/views/DistributedRecipesHeader.tsx';
import { DistributedRunControlPanel } from './legacy/runner/distributed-recipes/views/DistributedRunControlPanel.tsx';
import { DistributedTargetResolutionPanel } from './legacy/runner/distributed-recipes/views/DistributedTargetResolutionPanel.tsx';
import {
    DistributedRecipeAuthoringPanel,
} from './legacy/runner/distributed-recipes/authoring/DistributedRecipeAuthoringPanel.tsx';
import {
    distributedAuthoringDraftPreflights,
    distributedPromptFeedbackFromValidation,
    type DistributedAuthoringDraftTarget,
} from './legacy/runner/distributed-recipes/authoring/distributed-recipe-authoring.ts';
import {
    DISTRIBUTED_RECIPE_CATALOG,
    configuredDistributedRecipeCatalogItem,
    distributedRecipeMatches,
} from './legacy/runner/distributed-recipes/distributed-recipe-catalog.ts';
import { validateDistributedRecipeManifest } from './legacy/runner/distributed-recipes/distributed-manifest-validation.ts';
import { artifactIssueText } from './legacy/runner/shared/artifact-issue-presentation.ts';
import { RUN_MANAGER_SNAPSHOT_BOUNDS } from './legacy/runner/shared/control-snapshot-bounds.ts';
import {
    DISTRIBUTED_ARTIFACT_REQUIRED_FILES,
    distributedArtifactImportStatus,
    type DistributedArtifactImportStatus,
} from './legacy/runner/runs/distributed-artifact-import.ts';
import {
    readDistributedRunSeedFromUrl,
    writeDistributedRunSeedToUrl,
} from './legacy/runner/runs/distributed-run-seed-url.ts';
import {
    formatFleetDuration,
    formatPercent,
} from './legacy/runner/shared/performance-format.ts';
import { shortRunId } from './legacy/runner/shared/run-id-presentation.ts';

// Recipe Console work belongs under `src/recipe-console/**`; legacy extraction belongs under `src/legacy/**`; no new feature panel belongs in `App.tsx`.

type EventFilter = RallarBlackBoxTestEventKind | 'all';

type EventFilters = Readonly<{
    kind: EventFilter;
    commandId: string;
    connection: string;
    actor: string;
    transport: string;
    group: string;
    peer: string;
    selector: string;
    topic: string;
    severity: string;
}>;

type RallarBrowserStatusSummary = Readonly<{
    signalingLabel: string;
    signalingTone: string;
    signalingDetail: string;
    rtcLabel: string;
    rtcTone: string;
    rtcDetail: string;
    rtcGroup: string;
    rtcConnection: string;
    rtcTransport: string;
    peerSummary: string;
    latestTopic?: string;
    latestAtEpochMs?: number;
    rallarConnected?: boolean;
}>;

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

type CommandCenterActionFeedback = Readonly<{
    state: 'idle' | 'running' | 'success' | 'error';
    label?: string;
    target?: string;
    status?: string | number;
    statusText?: string;
    durationMs?: number;
    message?: string;
    atEpochMs?: number;
}>;

type AppLocalRecipeEntry = Readonly<{
    id: string;
    title: string;
    description: string;
    path: string;
    providerMode: string;
    requirements: readonly string[];
    expectedResult: string;
}>;

type RunnerRecipeSource = 'app-local' | 'shared-test';

type RunnerRecipeCatalogEntry = Readonly<{
    id: string;
    title: string;
    description: string;
    source: RunnerRecipeSource;
    path: string;
    providerMode: string;
    profiles: readonly string[];
    requirements: readonly string[];
    expectedResult: string;
    live: boolean;
    recipe?: RallarBlackBoxTestRecipe;
    distributedItem?: DistributedRecipeCatalogItem;
    copyCommand: string;
    commandCount?: number;
}>;

type RunnerServiceProbe = Readonly<{
    status: RunnerServiceProbeStatus;
    detail: string;
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

const APP_LOCAL_RECIPE_CATALOG: readonly AppLocalRecipeEntry[] = [
    {
        id: 'app-local-group-ws-setup',
        title: 'Group And WebSocket Setup',
        description:
            'Creates or reuses bb-group, joins it, acquires a WebSocket ticket, and opens the API socket.',
        path: 'apps/rallar-black-box/examples/rallar-server-group-ws-setup.recipe.json',
        providerMode: 'browser-rallar',
        requirements: [
            'logged-in browser session',
            'Rallar Server API base URL',
            'auth and group endpoints',
        ],
        expectedResult: 'group joined and WebSocket opened',
    },
    {
        id: 'app-local-rtc-connect-send',
        title: 'RTC Connect And Send',
        description:
            'Uses the logged-in session and group context to connect RTC and send a realtime payload.',
        path: 'apps/rallar-black-box/examples/rallar-server-rtc-connect-send.recipe.json',
        providerMode: 'browser-rallar',
        requirements: [
            'logged-in browser session',
            'group state API can create or reuse bb-group',
            'RTC signaling available',
        ],
        expectedResult: 'RTC connect succeeds and payload is sent',
    },
];

function runnerRecipeCatalog(input: Readonly<{
    group: RallarBlackBoxDistributedGroupRef;
    apiBaseUrl: string;
    rtcRealtimeDurationSeconds: number;
}>): readonly RunnerRecipeCatalogEntry[] {
    const distributedItems = DISTRIBUTED_RECIPE_CATALOG.map((item) =>
        configuredDistributedRecipeCatalogItem(item, input),
    );
    const fixtureEntries = distributedItems.map((item) => {
        const preview = distributedRecipeCommandPreview(item.recipe);
        return {
            id: `fixture:${item.itemId}`,
            title: item.title,
            description: item.description,
            source: 'app-local' as const,
            path: `fixture:${item.itemId}`,
            providerMode: item.providerMode,
            profiles: item.profiles,
            requirements: item.prerequisites,
            expectedResult: preview.label,
            live: item.live,
            recipe: item.recipe,
            distributedItem: item,
            copyCommand: json({
                kind: 'recipe.run',
                recipe: item.recipe,
            }),
            commandCount: item.recipe.commands.length,
        } satisfies RunnerRecipeCatalogEntry;
    });
    const sharedEntries = RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG.entries.map(
        (entry) => ({
            id: `shared:${entry.id}`,
            title: entry.title,
            description: entry.description,
            source: 'shared-test' as const,
            path: entry.recipePath,
            providerMode: entry.providerMode,
            profiles: entry.profiles,
            requirements: catalogRequirements(entry),
            expectedResult: entry.expectedResult,
            live: entry.support.live,
            copyCommand: entry.commands[0]?.command ?? entry.recipePath,
            commandCount: entry.commands.length,
        } satisfies RunnerRecipeCatalogEntry),
    );

    return [...fixtureEntries, ...sharedEntries].sort(
        (left, right) =>
            runnerRecipeDefaultScore(left) - runnerRecipeDefaultScore(right) ||
            (left.commandCount ?? Number.MAX_SAFE_INTEGER) -
                (right.commandCount ?? Number.MAX_SAFE_INTEGER) ||
            left.title.localeCompare(right.title),
    );
}

function runnerRecipeDefaultScore(entry: RunnerRecipeCatalogEntry): number {
    return (
        (entry.recipe ? 0 : 100) +
        (entry.live ? 40 : 0) +
        (entry.source === 'shared-test' ? 20 : 0)
    );
}

function runnerRecipeMatches(
    entry: RunnerRecipeCatalogEntry,
    query: string,
    profile: string,
    source: RunnerRecipeSource | 'all',
): boolean {
    if (source !== 'all' && entry.source !== source) {
        return false;
    }
    if (profile && !entry.profiles.includes(profile)) {
        return false;
    }
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
        return true;
    }
    return [
        entry.id,
        entry.title,
        entry.description,
        entry.path,
        entry.providerMode,
        entry.expectedResult,
        ...entry.profiles,
        ...entry.requirements,
    ]
        .join(' ')
        .toLowerCase()
        .includes(trimmed);
}

function runnerLaunchStateFromRunState(
    runState: RallarBlackBoxTestRuntimeStatus | string,
): RecipeLaunchState {
    if (runState === 'running') {
        return 'running';
    }
    if (runState === 'passed' || runState === 'completed') {
        return 'passed';
    }
    if (runState === 'failed' || runState === 'cancelled') {
        return 'failed';
    }
    return 'idle';
}

function runnerLaunchTone(state: RecipeLaunchState): string {
    if (state === 'passed') {
        return 'good';
    }
    if (state === 'failed') {
        return 'bad';
    }
    if (state === 'preparing' || state === 'running') {
        return 'active';
    }
    return 'muted';
}

function runnerProbeUrl(baseUrl: string, path: string): string {
    try {
        return new URL(path, baseUrl).toString();
    } catch (_error) {
        return path;
    }
}

function runnerApiProbeUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    const normalizedBase = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    try {
        const url = new URL(normalizedBase);
        const apiBasePath = url.pathname.replace(/\/+$/, '');
        return new URL(
            apiBasePath.endsWith('/api') ? 'config' : 'api/config',
            url,
        ).toString();
    } catch (_error) {
        return '/api/config';
    }
}

function runnerApiEndpointUrl(baseUrl: string, path: string): string {
    const normalizedBase = baseUrl.trim().replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
}

function runnerControlWsUrlFromHttpBaseUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === 'http:') {
            url.protocol = 'ws:';
        } else if (url.protocol === 'https:') {
            url.protocol = 'wss:';
        }
        url.pathname = '/control';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (_error) {
        return 'ws://localhost:5180/control';
    }
}

function runnerBrowserOrigin(): string {
    return globalThis.location?.origin ?? 'http://localhost:5176';
}

function runnerReadinessCheckTone(check: RunnerReadinessCheck): string {
    if (check.status === 'ready') {
        return 'good';
    }
    if (check.status === 'warning') {
        return 'warn';
    }
    if (check.status === 'checking') {
        return 'active';
    }
    return 'bad';
}

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

const SHARED_TEST_ARTIFACT_FILE_NAMES = [
    ...RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT.requiredFiles,
    ...RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT.optionalFiles,
] as const;

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

const DEFAULT_EVENT_FILTERS: EventFilters = {
    kind: 'all',
    commandId: '',
    connection: '',
    actor: '',
    transport: '',
    group: '',
    peer: '',
    selector: '',
    topic: '',
    severity: '',
};

const EVENT_KIND_FILTERS: readonly EventFilter[] = [
    'all',
    'diagnostic',
    'event',
    'message',
    'report',
    'result',
    'state',
    'stats',
];

function eventFilterFromValue(value: string): EventFilter {
    return EVENT_KIND_FILTERS.includes(value as EventFilter)
        ? (value as EventFilter)
        : 'all';
}

function idleActionFeedback(message: string): CommandCenterActionFeedback {
    return {
        state: 'idle',
        message,
    };
}

function runningActionFeedback(
    label: string,
    target?: string,
    message = 'Action is running.',
): CommandCenterActionFeedback {
    return {
        state: 'running',
        label,
        target,
        message,
        atEpochMs: Date.now(),
    };
}

function completedActionFeedback(
    input: Readonly<{
        label: string;
        startedAtEpochMs: number;
        target?: string;
        ok: boolean;
        status?: string | number;
        statusText?: string;
        durationMs?: number;
        message?: string;
    }>,
): CommandCenterActionFeedback {
    return {
        state: input.ok ? 'success' : 'error',
        label: input.label,
        target: input.target,
        status: input.status,
        statusText: input.statusText,
        durationMs:
            input.durationMs ??
            Math.max(0, Date.now() - input.startedAtEpochMs),
        message: input.message,
        atEpochMs: Date.now(),
    };
}

function activeDeadlineEpochMs(
    command:
        | (RallarBlackBoxTestCommand & Readonly<{ commandId: string }>)
        | undefined,
    startedAtEpochMs: number | undefined,
): number | undefined {
    if (!command) {
        return undefined;
    }

    return (
        command.deadlineEpochMs ??
        (startedAtEpochMs !== undefined && command.timeoutMs !== undefined
            ? startedAtEpochMs + command.timeoutMs
            : undefined)
    );
}

function eventMatchesFilters(
    event: RallarBlackBoxTestEvent,
    filters: EventFilters,
): boolean {
    if (filters.kind !== 'all' && event.kind !== filters.kind) return false;
    if (filters.commandId && event.commandId !== filters.commandId)
        return false;
    if (filters.connection && event.connection !== filters.connection)
        return false;
    if (filters.actor && event.actor !== filters.actor) return false;
    if (filters.transport && event.transport !== filters.transport)
        return false;
    if (filters.severity && event.severity !== filters.severity) return false;
    if (filters.group && eventGroupValue(event) !== filters.group) return false;
    if (filters.peer && eventPeerValue(event) !== filters.peer) return false;
    if (filters.selector && eventSelectorValue(event) !== filters.selector)
        return false;
    if (
        filters.topic &&
        !event.topic.toLowerCase().includes(filters.topic.toLowerCase())
    ) {
        return false;
    }

    return true;
}

function firstStringValue(values: readonly unknown[]): string | undefined {
    return values.find(
        (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
    );
}

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

function eventGroupValue(event: RallarBlackBoxTestEvent): string | undefined {
    const payload = eventPayloadDetails(event);
    return firstStringValue([
        payload.roomId,
        payload.groupId,
        optionalRecord(payload.roomRef).groupId,
    ]);
}

function eventPeerValue(event: RallarBlackBoxTestEvent): string | undefined {
    const payload = eventPayloadDetails(event);
    return firstStringValue([
        payload.peerId,
        payload.remotePeerId,
        payload.senderId,
        payload.targetClient,
    ]);
}

function eventSelectorValue(
    event: RallarBlackBoxTestEvent,
): string | undefined {
    const payload = eventPayloadDetails(event);
    const typeId = stringValue(payload.typeId);
    const topicId = stringValue(payload.topicId) ?? stringValue(payload.topic);
    if (!typeId && !topicId) {
        return undefined;
    }

    return `${topicId ?? '*'} / ${typeId ?? '-'}`;
}

function catalogEntryMatches(
    entry: RallarBlackBoxSharedTestRecipeCatalogEntry,
    query: string,
    profile: string,
): boolean {
    if (profile && !entry.profiles.includes(profile)) {
        return false;
    }

    if (!query) {
        return true;
    }

    const haystack = [
        entry.id,
        entry.title,
        entry.description,
        entry.recipePath,
        entry.category,
        entry.providerMode,
        entry.liveSupport,
        ...entry.profiles,
        ...entry.uiHints.badges,
    ]
        .join(' ')
        .toLowerCase();

    return haystack.includes(query.toLowerCase());
}

function catalogRequirements(
    entry: RallarBlackBoxSharedTestRecipeCatalogEntry,
): readonly string[] {
    return [
        ...entry.prerequisites.requiredEnvVars.map((env) => `env:${env}`),
        ...entry.prerequisites.httpServices.map(
            (service) => `${service.name}:${service.env}`,
        ),
        ...(entry.prerequisites.requiresPlaywright ? ['Playwright'] : []),
    ];
}

function dateInputStartEpoch(value: string): number | undefined {
    if (!value) {
        return undefined;
    }
    const epochMs = new Date(`${value}T00:00:00`).getTime();
    return Number.isFinite(epochMs) ? epochMs : undefined;
}

function dateInputEndEpoch(value: string): number | undefined {
    if (!value) {
        return undefined;
    }
    const epochMs = new Date(`${value}T23:59:59.999`).getTime();
    return Number.isFinite(epochMs) ? epochMs : undefined;
}

function artifactEventTitle(event: Record<string, unknown>): string {
    return String(event.name ?? event.connection ?? event.kind ?? 'event');
}

function artifactEventDetail(event: Record<string, unknown>): string {
    return (
        [event.status, event.transport, event.action, event.connection]
            .filter(Boolean)
            .join(' - ') || '-'
    );
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

function optionalRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
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

function isRallarBrowserEvent(event: RallarBlackBoxTestEvent): boolean {
    return (
        event.topic === 'rallar.browser.event' ||
        event.topic.startsWith('rallar.browser.') ||
        event.topic.startsWith('rallar.direct.')
    );
}

function isRallarTraceEvent(event: RallarBlackBoxTestEvent): boolean {
    return (
        isRallarBrowserEvent(event) || event.topic.startsWith('rallar.server.')
    );
}

function rallarTraceSource(
    event: RallarBlackBoxTestEvent,
): 'browser' | 'direct' | 'server' {
    if (event.topic.startsWith('rallar.server.')) {
        return 'server';
    }
    if (event.topic.startsWith('rallar.direct.')) {
        return 'direct';
    }
    return 'browser';
}

function eventPayloadDetails(
    event: RallarBlackBoxTestEvent,
): Record<string, unknown> {
    const payload = optionalRecord(event.payload);
    return {
        ...payload,
        ...optionalRecord(payload.data),
    };
}

function eventPayloadText(event: RallarBlackBoxTestEvent): string {
    const payload = eventPayloadDetails(event);
    return (
        [
            stringValue(payload.phase),
            stringValue(payload.status),
            stringValue(optionalRecord(payload.status).readyState),
            stringValue(payload.action),
            stringValue(payload.kind),
            stringValue(payload.connection),
            stringValue(payload.remotePeerId),
            stringValue(payload.error),
            stringValue(optionalRecord(payload.error).message),
        ]
            .filter((value): value is string =>
                Boolean(value && value.length > 0),
            )
            .join(' - ') || '-'
    );
}

function eventFailureText(event: RallarBlackBoxTestEvent): string {
    const payload = eventPayloadDetails(event);
    const error = optionalRecord(payload.error);
    const response = optionalRecord(payload.response);
    return (
        [
            stringValue(payload.message),
            stringValue(payload.reason),
            stringValue(payload.statusText),
            stringValue(error.message),
            stringValue(payload.error),
            stringValue(response.bodyText),
            stringValue(payload.bodyText),
        ]
            .filter((value): value is string =>
                Boolean(value && value.length > 0),
            )
            .join('\n') || eventPayloadText(event)
    );
}

function traceTimingText(
    event: RallarBlackBoxTestEvent,
    previousEvent: RallarBlackBoxTestEvent | undefined,
    now: number,
): string {
    const ageMs = Math.max(0, now - event.atEpochMs);
    const deltaMs = previousEvent
        ? Math.max(0, event.atEpochMs - previousEvent.atEpochMs)
        : undefined;
    return [
        formatTime(event.atEpochMs),
        `${formatRelativeDuration(ageMs)} ago`,
        deltaMs === undefined ? 'first' : `+${formatDuration(deltaMs)}`,
    ].join(' - ');
}

function traceMetaText(event: RallarBlackBoxTestEvent): string {
    return [
        rallarTraceSource(event),
        event.kind,
        event.severity,
        event.transport ?? 'runtime',
        event.connection,
        event.actor,
    ]
        .filter((value): value is string => Boolean(value && value.length > 0))
        .join(' - ');
}

function looksLikeWsStatus(value: Record<string, unknown>): boolean {
    return (
        'readyState' in value ||
        'isOpen' in value ||
        'connectState' in value ||
        'reconnecting' in value
    );
}

function looksLikeRtcStatus(value: Record<string, unknown>): boolean {
    return (
        'knownPeerIds' in value ||
        'activePeerIds' in value ||
        'readyPeerIds' in value ||
        'peerIdsWithNoReconnectableLanes' in value ||
        'peers' in value ||
        'laneId' in value
    );
}

function wsStatusFromDetails(
    details: Record<string, unknown>,
): Record<string, unknown> | undefined {
    const explicit = optionalRecord(details.wsStatus);
    if (looksLikeWsStatus(explicit)) return explicit;
    const nestedStatus = optionalRecord(details.status);
    return looksLikeWsStatus(nestedStatus) ? nestedStatus : undefined;
}

function rtcStatusFromDetails(
    details: Record<string, unknown>,
): Record<string, unknown> | undefined {
    const explicit = optionalRecord(details.rtcStatus);
    if (looksLikeRtcStatus(explicit)) return explicit;
    const nestedStatus = optionalRecord(details.status);
    return looksLikeRtcStatus(nestedStatus) ? nestedStatus : undefined;
}

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function deriveWsStatusLabel(
    status?: Record<string, unknown>,
): Pick<
    RallarBrowserStatusSummary,
    'signalingLabel' | 'signalingTone' | 'signalingDetail'
> {
    if (!status) {
        return {
            signalingLabel: 'not observed',
            signalingTone: 'muted',
            signalingDetail: '-',
        };
    }

    const readyState = stringValue(status.readyState);
    const connectState = stringValue(status.connectState);
    const reconnecting = status.reconnecting === true;
    const reconnectExhausted = status.reconnectExhausted === true;
    const label = reconnectExhausted
        ? 'exhausted'
        : reconnecting
          ? 'reconnecting'
          : status.isOpen === true || readyState === 'open'
            ? 'open'
            : (readyState ?? connectState ?? 'unknown');
    const tone =
        label === 'open'
            ? 'good'
            : label === 'connecting' || label === 'reconnecting'
              ? 'active'
              : label === 'closed' ||
                  label === 'closing' ||
                  label === 'exhausted'
                ? 'warn'
                : 'muted';
    const attempts = optionalNumber(status.reconnectAttempts);
    const maxAttempts = optionalNumber(status.maxReconnectAttempts);

    return {
        signalingLabel: label,
        signalingTone: tone,
        signalingDetail:
            [
                connectState,
                attempts !== undefined
                    ? `${attempts}/${maxAttempts ?? '-'} reconnects`
                    : undefined,
            ]
                .filter((value): value is string =>
                    Boolean(value && value.length > 0),
                )
                .join(' - ') || '-',
    };
}

function deriveRtcStatusLabel(
    status: Record<string, unknown> | undefined,
    latestDetails: Record<string, unknown> | undefined,
    latestTopic?: string,
): Pick<
    RallarBrowserStatusSummary,
    'rtcLabel' | 'rtcTone' | 'peerSummary' | 'rallarConnected'
> {
    const readyPeers = arrayCount(status?.readyPeerIds);
    const activePeers = arrayCount(status?.activePeerIds);
    const knownPeers = arrayCount(status?.knownPeerIds);
    const noReconnectable = arrayCount(status?.peerIdsWithNoReconnectableLanes);
    const rallarConnected =
        latestDetails?.rallarConnected === true ||
        stringValue(latestDetails?.status) === 'connected';
    const closed =
        latestTopic?.includes('closed') === true ||
        latestTopic?.includes('disconnect_completed') === true;
    const label = closed
        ? 'closed'
        : readyPeers > 0
          ? 'ready'
          : activePeers > 0
            ? 'active'
            : knownPeers > 0
              ? 'peers known'
              : rallarConnected
                ? 'connected'
                : status
                  ? 'no peers'
                  : 'not observed';
    const tone =
        label === 'ready' || label === 'active' || label === 'connected'
            ? 'good'
            : label === 'peers known' || label === 'no peers'
              ? 'warn'
              : label === 'closed'
                ? 'muted'
                : 'muted';

    return {
        rtcLabel: label,
        rtcTone: noReconnectable > 0 ? 'warn' : tone,
        peerSummary: `ready ${readyPeers} / active ${activePeers} / known ${knownPeers}`,
        rallarConnected,
    };
}

function deriveRallarBrowserStatus(
    state: RallarBlackBoxTestState,
    globalValues?: CommandCenterGlobalValues,
): RallarBrowserStatusSummary {
    const events =
        selectRallarBlackBoxEvents(state).filter(isRallarBrowserEvent);
    const latestEvent = events.at(-1);
    const latestDetails = latestEvent
        ? eventPayloadDetails(latestEvent)
        : undefined;
    const latestWsStatus = events
        .map((event) => wsStatusFromDetails(eventPayloadDetails(event)))
        .findLast(Boolean);
    const latestRtcEvent = events.findLast((event) => {
        const details = eventPayloadDetails(event);
        return (
            Boolean(rtcStatusFromDetails(details)) ||
            event.topic.includes('connect_completed') ||
            event.topic.includes('closed') ||
            event.topic.includes('rtc.lifecycle')
        );
    });
    const latestRtcDetails = latestRtcEvent
        ? eventPayloadDetails(latestRtcEvent)
        : latestDetails;
    const latestRtcStatus = latestRtcDetails
        ? rtcStatusFromDetails(latestRtcDetails)
        : undefined;
    const ws = deriveWsStatusLabel(latestWsStatus);
    const rtc = deriveRtcStatusLabel(
        latestRtcStatus,
        latestRtcDetails,
        latestRtcEvent?.topic,
    );
    const group =
        stringValue(latestRtcDetails?.roomId) ??
        stringValue(optionalRecord(latestRtcDetails?.roomRef).groupId) ??
        globalValues?.roomId ??
        state.currentConfig?.roomId ??
        '-';

    return {
        ...ws,
        ...rtc,
        rtcDetail:
            stringValue(latestRtcDetails?.laneId) ??
            stringValue(latestRtcDetails?.typeId) ??
            '-',
        rtcGroup: group,
        rtcConnection:
            latestRtcEvent?.connection ??
            String(state.currentConfig?.defaults?.connection ?? 'default'),
        rtcTransport:
            latestRtcEvent?.transport ?? state.currentConfig?.transport ?? '-',
        latestTopic: latestEvent?.topic,
        latestAtEpochMs: latestEvent?.atEpochMs,
    };
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

function createReportSnapshot(state: RallarBlackBoxTestState): unknown {
    const providerMode = rallarBlackBoxProviderModeFromConfig(
        state.currentConfig,
    );
    return {
        reportId: `local-report-${state.currentConfig?.runId ?? 'unconfigured'}`,
        runId: state.currentConfig?.runId,
        agentId: state.currentConfig?.agentId,
        providerMode,
        generatedAtEpochMs: Date.now(),
        status: state.status,
        config: state.currentConfig,
        loadedRecipe: state.loadedRecipe
            ? {
                  recipeId: state.loadedRecipe.recipeId,
                  name: state.loadedRecipe.name,
                  commandCount: state.loadedRecipe.commands.length,
              }
            : undefined,
        summary: {
            providerMode,
            commands: state.commandHistory.length,
            failures: state.failures.length,
            events: state.events.length,
            firstFailureCommandId: state.failures[0]?.commandId,
        },
        stats: state.latestStats,
        results: state.commandHistory.map((result) => ({
            ...result,
            providerMode,
        })),
        events: state.events,
    };
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

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const interval = window.setInterval(
            () => setNow(Date.now()),
            intervalMs,
        );
        return () => window.clearInterval(interval);
    }, [intervalMs]);

    return now;
}

function manualTransportFrom(
    transport: RallarBlackBoxTestTransport | undefined,
): ManualWorkbenchTransport {
    return transport === 'messages.rtc' || transport === 'ws'
        ? transport
        : 'realtime';
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function commandCenterGlobalValuesFromState(
    state: RallarBlackBoxTestState,
    bootstrap: RallarBlackBoxBootstrapConfig,
    authSession?: AuthSession,
): CommandCenterGlobalValues {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const configRallar = recordValue(config?.rallar);
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

function flowBuilderVariablesFromGlobalValues(
    variables: Readonly<Record<string, unknown>>,
    globalValues?: CommandCenterGlobalValues,
): Readonly<Record<string, unknown>> {
    if (!globalValues) {
        return variables;
    }

    return {
        ...variables,
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        groupId: globalValues.roomId,
        actor: globalValues.clientId,
        sessionId: globalValues.sessionId,
        username: globalValues.clientId,
    };
}

function booleanValue(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function jsonTextValue(value: unknown, fallback = ''): string {
    if (typeof value === 'string') {
        return value;
    }

    if (value && typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return fallback;
        }
    }

    return fallback;
}

function numberValue(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
}

function manualValuesFromState(
    state: RallarBlackBoxTestState,
    bootstrap: RallarBlackBoxBootstrapConfig,
    authSession?: AuthSession,
    globalValues?: CommandCenterGlobalValues,
): ManualWorkbenchValues {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const configRallar = recordValue(config?.rallar);
    const clientId =
        globalValues?.clientId ||
        authSession?.clientId ||
        authSession?.username ||
        config?.actor ||
        bootstrap.actor;
    return {
        ...DEFAULT_MANUAL_WORKBENCH_VALUES,
        environment: config?.environment ?? bootstrap.environment,
        apiBaseUrl:
            globalValues?.apiBaseUrl ??
            config?.apiBaseUrl ??
            bootstrap.apiBaseUrl,
        applicationId:
            globalValues?.applicationId ??
            stringValue(
                config?.defaults?.applicationId ?? configRallar.applicationId,
            ) ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId:
            globalValues?.workspaceId ??
            stringValue(
                config?.defaults?.workspaceId ?? configRallar.workspaceId,
            ) ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        actor: clientId,
        sessionId:
            globalValues?.sessionId ??
            authSession?.sessionId ??
            config?.sessionId ??
            bootstrap.sessionId,
        groupId: globalValues?.roomId ?? config?.roomId ?? bootstrap.roomId,
        scopeText: jsonTextValue(
            config?.defaults?.scope ?? configRallar.scope,
            DEFAULT_MANUAL_WORKBENCH_VALUES.scopeText,
        ),
        roomRefText: jsonTextValue(
            config?.defaults?.roomRef ?? configRallar.roomRef,
            DEFAULT_MANUAL_WORKBENCH_VALUES.roomRefText,
        ),
        minSnapshotVersion: numberValue(
            config?.defaults?.minSnapshotVersion ??
                configRallar.minSnapshotVersion,
            DEFAULT_MANUAL_WORKBENCH_VALUES.minSnapshotVersion,
        ),
        connection: String(
            config?.defaults?.connection ??
                DEFAULT_MANUAL_WORKBENCH_VALUES.connection,
        ),
        transport: manualTransportFrom(
            config?.transport ?? bootstrap.transport,
        ),
        providerMode: config
            ? rallarBlackBoxProviderModeFromConfig(config)
            : bootstrap.providerMode,
        rallarUsername:
            bootstrap.rallarUsername ??
            authSession?.username ??
            stringValue(configRallar.username),
        rallarPassword: bootstrap.rallarPassword,
        rallarRegister: Boolean(bootstrap.rallarRegister) ||
            booleanValue(configRallar.register),
        rallarRestoreSession:
            bootstrap.rallarRestoreSession ||
            Boolean(authSession) ||
            booleanValue(configRallar.restoreSession),
        rallarLogoutOnClose:
            bootstrap.rallarLogoutOnClose ||
            booleanValue(configRallar.logoutOnClose),
        rallarLeaveRoomOnClose: booleanValue(
            configRallar.leaveRoomOnClose,
            bootstrap.rallarLeaveRoomOnClose,
        ),
    };
}

function actionLabel(action: ManualWorkbenchAction): string {
    switch (action) {
        case 'configure':
            return 'Configure group';
        case 'join':
            return 'Create and join group';
        case 'connect':
            return 'Connect';
        case 'send':
            return 'Send payload';
        case 'health':
            return 'Health check';
        case 'close':
            return 'Close connections';
        case 'reset':
            return 'Reset runtime';
    }
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

function RallarBrowserTraceBar({
    mode,
    state,
    status,
    onOpenTrace,
    onOpenEvents,
}: {
    mode: AppModeId;
    state: RallarBlackBoxTestState;
    status: RallarBrowserStatusSummary;
    onOpenTrace(): void;
    onOpenEvents(): void;
}) {
    const events = selectRallarBlackBoxEvents(state);
    const rallarEvents = useMemo(
        () => events.filter(isRallarBrowserEvent),
        [events],
    );
    const recentEvents = rallarEvents.slice(-4).reverse();
    const latestEvent = rallarEvents.at(-1);
    const errorCount = rallarEvents.filter(
        (event) => event.severity === 'error',
    ).length;
    const warningCount = rallarEvents.filter(
        (event) => event.severity === 'warning',
    ).length;
    const hasWarningOrError = errorCount > 0 || warningCount > 0;
    const tone =
        latestEvent?.severity === 'error'
            ? 'bad'
            : latestEvent?.severity === 'warning'
              ? 'warn'
              : latestEvent
                ? 'good'
                : 'muted';
    const modeLabel =
        mode === 'black-box-runner' ? 'black-box-runner mode' : 'Rallar mode';
    const eventSource =
        mode === 'black-box-runner'
            ? 'Runner/control events'
            : 'Live Rallar events';
    const now = useNow(1_000);
    const eventIndexById = useMemo(
        () =>
            new Map(rallarEvents.map((event, index) => [event.eventId, index])),
        [rallarEvents],
    );
    const manualToggleRef = useRef(false);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (!manualToggleRef.current) {
            setExpanded(hasWarningOrError);
        }
    }, [hasWarningOrError]);

    return (
        <section
            className={`rallar-browser-trace-bar ${expanded ? 'expanded' : 'collapsed'}`}
            aria-label="Rallar browser trace"
        >
            <div className="rallar-trace-heading">
                <h2>Rallar Browser Trace</h2>
                <span className={`pill ${tone}`}>{modeLabel}</span>
                <span className={`pill ${tone}`}>
                    {latestEvent?.severity ?? (latestEvent ? 'info' : 'idle')}
                </span>
                <span className="trace-compact-summary">
                    {status.signalingLabel} / {status.rtcLabel} /{' '}
                    {rallarEvents.length} events
                </span>
                <button
                    type="button"
                    className="collapsible-toggle"
                    aria-expanded={expanded}
                    aria-controls="rallar-browser-trace-content"
                    aria-label={`${expanded ? 'Hide' : 'Show'} Rallar Browser Trace`}
                    onClick={() => {
                        manualToggleRef.current = true;
                        setExpanded((current) => !current);
                    }}
                >
                    {expanded ? 'Hide' : 'Show'}
                </button>
                <button type="button" onClick={onOpenTrace}>
                    Rallar Trace
                </button>
                <button type="button" onClick={onOpenEvents}>
                    Event Stream
                </button>
            </div>
            <div
                id="rallar-browser-trace-content"
                className="rallar-trace-content"
                hidden={!expanded}
            >
                <div className="rallar-trace-summary">
                    <span>Source: {eventSource}</span>
                    <span>Signal WS: {status.signalingLabel}</span>
                    <span>RTC: {status.rtcLabel}</span>
                    <span>Group: {status.rtcGroup}</span>
                    <span>Peers: {status.peerSummary}</span>
                    <span>{rallarEvents.length} events</span>
                    <span>
                        {errorCount} errors / {warningCount} warnings
                    </span>
                    <span>
                        {latestEvent ? formatTime(latestEvent.atEpochMs) : '-'}
                    </span>
                </div>
                <div className="rallar-trace-events">
                    {recentEvents.length === 0 && (
                        <div className="empty-state">
                            No Rallar browser events
                        </div>
                    )}
                    {recentEvents.map((event) => {
                        const eventIndex =
                            eventIndexById.get(event.eventId) ?? -1;
                        const previousEvent =
                            eventIndex > 0
                                ? rallarEvents[eventIndex - 1]
                                : undefined;
                        return (
                            <article
                                className="rallar-trace-event"
                                key={event.eventId}
                            >
                                <span
                                    className={`status-dot ${
                                        event.severity === 'error'
                                            ? 'failed'
                                            : event.severity === 'warning'
                                              ? 'warning'
                                              : 'completed'
                                    }`}
                                />
                                <strong>{event.topic}</strong>
                                <small>
                                    {traceTimingText(event, previousEvent, now)}
                                </small>
                                <em>{traceMetaText(event)}</em>
                                <small>{eventPayloadText(event)}</small>
                            </article>
                        );
                    })}
                </div>
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

function RunnerReadinessPanel({
    checks,
    message,
    refreshing,
    onRefresh,
    onOpenAgentTabs,
}: {
    checks: readonly RunnerReadinessCheck[];
    message: string;
    refreshing: boolean;
    onRefresh(): void;
    onOpenAgentTabs?(): void;
}) {
    return (
        <section className="runner-readiness-panel" aria-label="Runner Readiness">
            <div className="section-heading">
                <h3>Runner Readiness</h3>
                <button type="button" disabled={refreshing} onClick={onRefresh}>
                    {refreshing ? 'Checking...' : 'Refresh'}
                </button>
            </div>
            <div className="runner-readiness-grid">
                {checks.map((check) => (
                    <article
                        className={`runner-readiness-check ${runnerReadinessCheckTone(check)}`}
                        key={check.id}
                    >
                        <div>
                            <strong>{check.label}</strong>
                            <span className={`pill ${runnerReadinessCheckTone(check)}`}>
                                {check.status}
                            </span>
                        </div>
                        <p>{check.message}</p>
                        {check.action && <small>{check.action}</small>}
                        {check.id === 'agents' && onOpenAgentTabs && (
                            <button
                                type="button"
                                className="runner-readiness-inline-action"
                                onClick={onOpenAgentTabs}
                            >
                                Open agent tabs
                            </button>
                        )}
                    </article>
                ))}
            </div>
            <div className="runner-readiness-summary" role="status">
                {message}
            </div>
        </section>
    );
}

function RunnerAgentSetupPanel({
    runId,
    agentPrefix,
    agentCount,
    restoreSession,
    providerMode,
    authSession,
    controlWsUrl,
    groupId,
    connectedAgents,
    launchUrls,
    launchMessage,
    showConnectedAgents = true,
    onRunIdChange,
    onAgentPrefixChange,
    onAgentCountChange,
    onRestoreSessionChange,
    onOpenAgents,
    onCopyLinks,
}: {
    runId: string;
    agentPrefix: string;
    agentCount: number;
    restoreSession: boolean;
    providerMode: RallarBlackBoxBootstrapConfig['providerMode'];
    authSession?: AuthSession;
    controlWsUrl: string;
    groupId: string;
    connectedAgents: ControlRunSnapshot['agents'];
    launchUrls: readonly string[];
    launchMessage?: string;
    showConnectedAgents?: boolean;
    onRunIdChange(value: string): void;
    onAgentPrefixChange(value: string): void;
    onAgentCountChange(value: number): void;
    onRestoreSessionChange(value: boolean): void;
    onOpenAgents(): void;
    onCopyLinks(): void;
}) {
    const canOpenAgents =
        runId.trim().length > 0 &&
        groupId.trim().length > 0 &&
        agentPrefix.trim().length > 0 &&
        launchUrls.length > 0;
    const activeAgents = connectedAgents.filter((agent) => agent.connected);
    const previewAgentIds = launchUrls.map((url) => {
        try {
            return new URL(url).searchParams.get('agentId') ?? '';
        } catch (_error) {
            return '';
        }
    }).filter((agentId) => agentId.length > 0);

    return (
        <section className="runner-agent-setup" aria-label="Connect Agents">
            <div className="section-heading">
                <div>
                    <h3>Connect Agents</h3>
                    <p>
                        {activeAgents.length > 0
                            ? `${activeAgents.length} connected.`
                            : 'No agents connected.'}
                    </p>
                </div>
                <span className={`pill ${activeAgents.length > 0 ? 'good' : 'bad'}`}>
                    {activeAgents.length}/{connectedAgents.length}
                </span>
            </div>
            <div className="runner-agent-grid">
                <label className="field">
                    <span>Run ID</span>
                    <input
                        value={runId}
                        onChange={(event) => onRunIdChange(event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Agent Prefix</span>
                    <input
                        value={agentPrefix}
                        onChange={(event) =>
                            onAgentPrefixChange(event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Agent Tabs</span>
                    <input
                        min={1}
                        max={6}
                        type="number"
                        value={agentCount}
                        onChange={(event) =>
                            onAgentCountChange(
                                Math.min(
                                    6,
                                    Math.max(1, Number(event.target.value) || 1),
                                ),
                            )
                        }
                    />
                </label>
                <label className="toggle-field runner-agent-restore">
                    <input
                        type="checkbox"
                        checked={restoreSession}
                        onChange={(event) =>
                            onRestoreSessionChange(event.target.checked)
                        }
                    />
                    <span>Mint fresh per-tab sessions from current login</span>
                </label>
            </div>
            <div className="runner-agent-actions">
                <button
                    type="button"
                    disabled={!canOpenAgents}
                    title={
                        canOpenAgents
                            ? undefined
                            : 'Set run ID, group, and agent prefix first.'
                    }
                    onClick={onOpenAgents}
                >
                    Open agent tabs
                </button>
                <button
                    type="button"
                    disabled={!canOpenAgents}
                    onClick={onCopyLinks}
                >
                    Copy agent links
                </button>
            </div>
            <div className="runner-agent-preview" aria-label="Agent IDs">
                <strong>Next agent IDs</strong>
                <span>
                    {previewAgentIds.join(', ')}
                </span>
            </div>
            <dl className="config-list runner-agent-meta">
                <div>
                    <dt>Control WS</dt>
                    <dd>{controlWsUrl}</dd>
                </div>
                <div>
                    <dt>Group</dt>
                    <dd>{groupId || 'missing'}</dd>
                </div>
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>Login</dt>
                    <dd>
                        {authSession
                            ? `${authSession.username} fresh per-tab sessions`
                            : restoreSession
                              ? 'fresh per-tab sessions requested'
                              : 'agent signs in'}
                    </dd>
                </div>
            </dl>
            {showConnectedAgents && activeAgents.length > 0 ? (
                <div className="runner-agent-list" aria-label="Connected agents">
                    {activeAgents.map((agent) => (
                        <article
                            className="runner-agent-row"
                            key={agent.agentId}
                        >
                            <span>
                                <strong>{agent.agentId}</strong>
                                <small>
                                    {agent.identity?.principalId ??
                                        agent.identity?.sessionId ??
                                        'no identity'}
                                </small>
                            </span>
                            <span
                                className={`pill ${agent.connected ? 'good' : 'bad'}`}
                            >
                                {agent.connected ? 'connected' : 'offline'}
                            </span>
                        </article>
                    ))}
                </div>
            ) : showConnectedAgents ? (
                <div className="empty-state">
                    Open an agent tab with a one-time link, then Refresh.
                </div>
            ) : undefined}
            {showConnectedAgents && connectedAgents.length > activeAgents.length && (
                <small className="runner-agent-offline-note">
                    {connectedAgents.length - activeAgents.length} offline agent{connectedAgents.length - activeAgents.length === 1 ? '' : 's'} hidden
                </small>
            )}
            {launchMessage && (
                <div className="command-center-status" role="status">
                    {launchMessage}
                </div>
            )}
        </section>
    );
}

function RunnerRecipesPanel({
    state,
    bootstrap,
    control,
    authSession,
    globalValues,
    busy,
    runState,
    lastError,
    onDistributedRunStarted,
    onOpenTab,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    busy: boolean;
    runState: string;
    lastError?: string;
    onDistributedRunStarted(selection: RunnerDistributedRunSelection): void;
    onOpenTab(tab: AppTabId): void;
}) {
    const [controlBaseUrl, setControlBaseUrl] = useState(() =>
        controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl),
    );
    const [controlToken, setControlToken] = useState(
        bootstrap.controlToken ?? '',
    );
    const [brokeredControlToken, setBrokeredControlToken] =
        useState<BlackBoxControlTokenSession | undefined>();
    const [brokeredControlTokenError, setBrokeredControlTokenError] =
        useState<string | undefined>();
    const [controlRunId, setControlRunId] = useState(
        control.runId ?? bootstrap.runId ?? '',
    );
    const [agentRunId, setAgentRunId] = useState(
        control.runId ?? bootstrap.runId ?? 'manual-demo-run',
    );
    const [agentPrefix, setAgentPrefix] = useState(
        bootstrap.runnerAgentPrefix ??
        `${safeIdSegment(authSession?.username ?? bootstrap.actor ?? 'agent')}-agent`,
    );
    const [agentCount, setAgentCount] = useState(
        Math.min(6, Math.max(1, bootstrap.runnerAgentCount ?? 1)),
    );
    const [agentLaunchSuffix, setAgentLaunchSuffix] = useState(() =>
        runnerNewAgentLaunchSuffix(),
    );
    const [agentRestoreSession, setAgentRestoreSession] = useState(
        bootstrap.providerMode === 'browser-rallar',
    );
    const [agentLaunchMessage, setAgentLaunchMessage] =
        useState<string | undefined>();
    const [apiProbe, setApiProbe] = useState<RunnerServiceProbe>({
        status: 'checking',
        detail: 'Checking API',
    });
    const [controlProbe, setControlProbe] = useState<RunnerServiceProbe>({
        status: 'checking',
        detail: 'Checking control server',
    });
    const [turnProbe, setTurnProbe] = useState<Readonly<{
        status: RunnerTurnProbeStatus;
        detail?: string;
    }> | undefined>();
    const [controlRun, setControlRun] = useState<
        ControlRunSnapshot | undefined
    >();
    const [controlSnapshot, setControlSnapshot] = useState<
        ControlServerSnapshot | undefined
    >();
    const [distributedRun, setDistributedRun] = useState<
        ControlDistributedRunSnapshot | undefined
    >();
    const [artifactBundle, setArtifactBundle] = useState<
        ControlDistributedRunArtifactBundle | undefined
    >();
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const [sourceFilter, setSourceFilter] = useState<
        RunnerRecipeSource | 'all'
    >('all');
    const [selectedRecipeId, setSelectedRecipeId] = useState('');
    const [showEditor, setShowEditor] = useState(false);
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [launchState, setLaunchState] =
        useState<RecipeLaunchState>('idle');
    const [launchMessage, setLaunchMessage] = useState(
        'Choose a recipe and run it from this page.',
    );
    const [launchError, setLaunchError] = useState<string | undefined>();
    const didInitialRefresh = useRef(false);
    const groupRef = useMemo(
        () => ({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId,
        }),
        [
            globalValues.applicationId,
            globalValues.roomId,
            globalValues.workspaceId,
        ],
    );
    const catalog = useMemo(
        () =>
            runnerRecipeCatalog({
                group: groupRef,
                apiBaseUrl: globalValues.apiBaseUrl,
                rtcRealtimeDurationSeconds:
                    RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS,
            }),
        [globalValues.apiBaseUrl, groupRef],
    );
    const profileOptions = useMemo(
        () => uniqueValues(catalog.flatMap((entry) => entry.profiles)),
        [catalog],
    );
    const filteredRecipes = useMemo(
        () =>
            catalog.filter((entry) =>
                runnerRecipeMatches(entry, query, profile, sourceFilter),
            ),
        [catalog, profile, query, sourceFilter],
    );
    const selectedRecipe =
        catalog.find((entry) => entry.id === selectedRecipeId) ??
        filteredRecipes[0] ??
        catalog[0];
    const recipePreflight = useMemo(
        () =>
            selectedRecipe?.recipe
                ? distributedRecipePreflight(selectedRecipe.recipe)
                : undefined,
        [selectedRecipe],
    );
    const targetRows = useMemo(
        () =>
            distributedRecipeTargetRows({
                run: controlRun,
                group: groupRef,
                requiredCommandKinds: recipePreflight?.commandKinds ?? [],
                nowEpochMs: Date.now(),
            }),
        [controlRun, groupRef, recipePreflight],
    );
    const recipeAgentRows = useMemo(
        () =>
            deriveControlAgentBoardRows({
                run: controlRun,
                group: groupRef,
                requiredCommandKinds: recipePreflight?.commandKinds ?? [],
                distributedRuns: [
                    ...(controlSnapshot?.distributedRuns ?? []),
                    ...(distributedRun ? [distributedRun] : []),
                ],
                nowEpochMs: Date.now(),
            }),
        [controlRun, controlSnapshot?.distributedRuns, distributedRun, groupRef, recipePreflight],
    );
    const recipeAgentSummary = useMemo(
        () => summarizeControlAgentBoardRows(recipeAgentRows),
        [recipeAgentRows],
    );
    const targetableRows = targetRows.filter((row) => row.targetable);
    const connectedAgentCount =
        controlRun?.agents.filter((agent) => agent.connected).length ?? 0;
    const recipePrerequisiteIssues = selectedRecipe?.recipe
        ? recipePreflight?.errors ?? []
        : ['Recipe JSON is not bundled for browser execution yet. Use Copy command.'];
    const selectedRecipeNeedsLiveRuntime =
        bootstrap.providerMode === 'browser-rallar';
    const readiness = runnerReadinessStatus({
        apiStatus: apiProbe.status,
        apiRequired: selectedRecipeNeedsLiveRuntime,
        authenticated:
            bootstrap.providerMode !== 'browser-rallar' || Boolean(authSession),
        authRequired: selectedRecipeNeedsLiveRuntime,
        groupId: globalValues.roomId,
        controlStatus: controlProbe.status,
        controlRunId,
        connectedAgentCount,
        targetableAgentCount: targetableRows.length,
        turnStatus: turnProbe?.status,
        turnDetail: turnProbe?.detail,
        recipePrerequisiteIssues,
    });
    const localDisabledReason =
        selectedRecipe?.recipe === undefined
            ? recipePrerequisiteIssues[0]
            : runnerDisabledReason(readiness, 'local-browser');
    const distributedDisabledReason =
        selectedRecipe?.distributedItem === undefined
            ? 'This shared-test catalog entry is CLI-only from the SPA. Use Copy command or Advanced artifact import.'
            : runnerDisabledReason(readiness, 'connected-agents');
    const localRunning =
        busy || launchState === 'preparing' || launchState === 'running';
    const history = selectRallarBlackBoxCommandHistory(state);
    const failures = selectRallarBlackBoxFailures(state);
    const firstFailure =
        selectRallarBlackBoxFirstFailure(state) ?? failures[0];
    const latestResult = history.at(-1);
    const agentControlWsUrl = runnerControlWsUrlFromHttpBaseUrl(controlBaseUrl);
    const agentIds = useMemo(
        () =>
            Array.from({ length: agentCount }, (_, index) =>
                runnerAgentId(
                    agentPrefix,
                    index,
                    agentCount,
                    agentLaunchSuffix,
                ),
            ),
        [agentCount, agentLaunchSuffix, agentPrefix],
    );
    const agentLaunchUrls = useMemo(
        () =>
            agentIds.map((agentId) =>
                createRunnerAgentLaunchUrl({
                    origin: runnerBrowserOrigin(),
                    providerMode: bootstrap.providerMode,
                    controlWsUrl: agentControlWsUrl,
                    runId: agentRunId,
                    agentId,
                    groupId: globalValues.roomId,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    restoreSession: agentRestoreSession,
                    authStorage: agentRestoreSession ? 'session' : undefined,
                    actor: authSession?.username,
                    controlToken,
                }),
            ),
        [
            agentControlWsUrl,
            agentIds,
            agentRestoreSession,
            agentRunId,
            authSession?.username,
            bootstrap.providerMode,
            controlToken,
            globalValues.apiBaseUrl,
            globalValues.applicationId,
            globalValues.roomId,
            globalValues.workspaceId,
        ],
    );

    useEffect(() => {
        if (!selectedRecipeId && catalog[0]) {
            setSelectedRecipeId(catalog[0].id);
        }
    }, [catalog, selectedRecipeId]);

    useEffect(() => {
        if (!authSession || agentPrefix !== 'agent-agent') {
            return;
        }
        setAgentPrefix(`${safeIdSegment(authSession.username)}-agent`);
    }, [agentPrefix, authSession]);

    useEffect(() => {
        setBrokeredControlToken(undefined);
        setBrokeredControlTokenError(undefined);
    }, [authSession?.clientId, authSession?.sessionId]);

    const resolveDistributedControlToken = async (): Promise<string> => {
        try {
            const resolved = await resolveBlackBoxControlToken({
                manualToken: controlToken,
                brokeredToken: brokeredControlToken,
                apiBaseUrl: globalValues.apiBaseUrl,
                authSession,
            });
            if (resolved.source === 'brokered') {
                setBrokeredControlToken(resolved.session);
            }
            setBrokeredControlTokenError(undefined);
            return resolved.token;
        } catch (error) {
            const message = runnerFriendlyErrorMessage(error);
            setBrokeredControlTokenError(message);
            throw error;
        }
    };

    const refreshReadiness = async (): Promise<void> => {
        setBusyAction('refresh-readiness');
        setApiProbe({ status: 'checking', detail: 'Checking API' });
        setControlProbe({
            status: 'checking',
            detail: 'Checking control server',
        });
        const shouldCheckTurn =
            bootstrap.providerMode === 'browser-rallar' &&
            Boolean(authSession?.accessToken);
        if (shouldCheckTurn) {
            setTurnProbe({ status: 'checking' });
        } else {
            setTurnProbe(undefined);
        }
        setLaunchError(undefined);
        const apiPromise = fetch(
            runnerApiProbeUrl(globalValues.apiBaseUrl),
            {
                method: 'GET',
                headers: authSession?.accessToken
                    ? { Authorization: `Bearer ${authSession.accessToken}` }
                    : undefined,
            },
        )
            .then((response) => {
                setApiProbe({
                    status: response.status < 500 ? 'online' : 'offline',
                    detail: `HTTP ${response.status}`,
                });
            })
            .catch((error) => {
                setApiProbe({
                    status: 'offline',
                    detail: runnerFriendlyErrorMessage(error),
                });
            });
        const turnPromise = shouldCheckTurn && authSession
            ? fetch(
                runnerApiEndpointUrl(globalValues.apiBaseUrl, '/api/webrtc/ice'),
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${authSession.accessToken}`,
                        'x-client-id': authSession.clientId,
                    },
                },
            )
                .then(async (response) => {
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const payload = await response.json() as {
                        iceServers?: unknown;
                    };
                    const iceServerCount = Array.isArray(payload.iceServers)
                        ? payload.iceServers.length
                        : 0;
                    setTurnProbe({
                        status: iceServerCount > 0 ? 'ready' : 'empty',
                        detail: iceServerCount > 0
                            ? `${iceServerCount} ICE server${iceServerCount === 1 ? '' : 's'} returned`
                            : undefined,
                    });
                })
                .catch((error) => {
                    setTurnProbe({
                        status: 'error',
                        detail: runnerFriendlyErrorMessage(error),
                    });
                })
            : Promise.resolve();
        const controlPromise = fetchControlServerSnapshot({
            baseUrl: controlBaseUrl,
            token: controlToken,
            bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
        })
            .then(async (serverSnapshot) => {
                setControlSnapshot(serverSnapshot);
                setControlProbe({
                    status: 'online',
                    detail: `${serverSnapshot.runs.length} run(s)`,
                });
                const knownRunIds = new Set(
                    serverSnapshot.runs.map((run) => run.runId),
                );
                const knownPreferredRunId =
                    [
                        controlRunId,
                        agentRunId,
                        control.runId,
                        bootstrap.runId,
                        serverSnapshot.runs[0]?.runId,
                    ].find(
                        (candidate) => candidate && knownRunIds.has(candidate),
                    ) ?? '';
                const nextRunId = knownPreferredRunId || agentRunId;
                setControlRunId(nextRunId);
                if (knownPreferredRunId) {
                    setAgentRunId(knownPreferredRunId);
                    setControlRun(
                        await fetchControlRunSnapshot({
                            baseUrl: controlBaseUrl,
                            token: controlToken,
                            runId: knownPreferredRunId,
                            bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                        }),
                    );
                } else {
                    setControlRun(undefined);
                }
            })
            .catch((error) => {
                setControlSnapshot(undefined);
                setControlRun(undefined);
                setControlProbe({
                    status: 'offline',
                    detail: runnerFriendlyErrorMessage(error),
                });
            });

        await Promise.allSettled([apiPromise, controlPromise, turnPromise]);
        setBusyAction(undefined);
    };

    useEffect(() => {
        if (didInitialRefresh.current) {
            return;
        }
        didInitialRefresh.current = true;
        void refreshReadiness();
        // The initial readiness probe intentionally uses the first rendered form values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const copyText = async (text: string, message: string): Promise<void> => {
        await navigator.clipboard?.writeText(text);
        setLaunchMessage(message);
    };

    const createBrokeredAgentLaunchUrls = async (): Promise<readonly string[]> => {
        if (
            agentRestoreSession &&
            bootstrap.providerMode === 'browser-rallar'
        ) {
            if (!authSession) {
                throw new Error(
                    'Open agent tabs requires a logged-in browser session.',
                );
            }

            configureApiClient({ apiBaseUrl: globalValues.apiBaseUrl });
            const response = await issueAgentSessionTickets(
                { agentIds },
                { authSession },
            );
            const ticketsByAgent = new Map(
                response.tickets.map((ticket) => [ticket.agentId, ticket]),
            );

            return agentIds.map((agentId) => {
                const ticket = ticketsByAgent.get(agentId);
                if (!ticket) {
                    throw new Error(`Missing agent session ticket for ${agentId}.`);
                }

                return createRunnerAgentLaunchUrl({
                    origin: runnerBrowserOrigin(),
                    providerMode: bootstrap.providerMode,
                    controlWsUrl: agentControlWsUrl,
                    runId: agentRunId,
                    agentId,
                    groupId: globalValues.roomId,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    restoreSession: true,
                    authStorage: 'session',
                    actor: authSession.username,
                    sessionId: ticket.sessionId,
                    controlToken,
                    agentSessionTicket: ticket.ticket,
                });
            });
        }

        return agentIds.map((agentId) =>
            createRunnerAgentLaunchUrl({
                origin: runnerBrowserOrigin(),
                providerMode: bootstrap.providerMode,
                controlWsUrl: agentControlWsUrl,
                runId: agentRunId,
                agentId,
                groupId: globalValues.roomId,
                apiBaseUrl: globalValues.apiBaseUrl,
                applicationId: globalValues.applicationId,
                workspaceId: globalValues.workspaceId,
                restoreSession: agentRestoreSession,
                authStorage: agentRestoreSession ? 'session' : undefined,
                actor: authSession?.username,
                sessionId: authSession?.sessionId,
                controlToken,
            }),
        );
    };

    const copyAgentLinks = async (): Promise<void> => {
        setBusyAction('agent-links');
        setAgentLaunchMessage('Minting fresh one-time agent links...');
        try {
            const launchUrls = await createBrokeredAgentLaunchUrls();
            await copyText(
                launchUrls.join('\n'),
                `Copied ${launchUrls.length} one-time agent link${launchUrls.length === 1 ? '' : 's'}.`,
            );
            setAgentLaunchMessage(
                `Copied ${launchUrls.length} one-time, short-lived agent link${launchUrls.length === 1 ? '' : 's'}.`,
            );
            setAgentLaunchSuffix(runnerNewAgentLaunchSuffix());
        } catch (error) {
            setAgentLaunchMessage(runnerFriendlyErrorMessage(error));
        } finally {
            setBusyAction(undefined);
        }
    };

    const openAgentTabs = async (): Promise<void> => {
        const pendingAgentWindows = agentIds.map(() => {
            const popup = globalThis.open?.('about:blank', '_blank');
            try {
                if (popup) {
                    popup.opener = null;
                    popup.document.title = 'Rallar Agent';
                    popup.document.body.textContent =
                        'Preparing fresh Rallar agent session...';
                }
            } catch {
                // Popup access can be unavailable in browser security modes.
            }
            return popup;
        });
        setBusyAction('agent-tabs');
        setAgentLaunchMessage('Minting fresh one-time agent sessions...');
        try {
            const launchUrls = await createBrokeredAgentLaunchUrls();
            setControlRunId(agentRunId);
            launchUrls.forEach((url, index) => {
                const pendingWindow = pendingAgentWindows[index];
                if (pendingWindow && !pendingWindow.closed) {
                    pendingWindow.location.href = url;
                    return;
                }
                globalThis.open?.(url, '_blank', 'noopener,noreferrer');
            });
            setAgentLaunchMessage(
                `Requested ${launchUrls.length} agent tab${launchUrls.length === 1 ? '' : 's'} with fresh one-time sessions. Copy links if your browser blocked popups.`,
            );
            setAgentLaunchSuffix(runnerNewAgentLaunchSuffix());
        } catch (error) {
            const message = runnerFriendlyErrorMessage(error);
            pendingAgentWindows.forEach((pendingWindow) => {
                try {
                    if (pendingWindow && !pendingWindow.closed) {
                        pendingWindow.document.body.textContent = message;
                    }
                } catch {
                    // Ignore inaccessible popup documents.
                }
            });
            setAgentLaunchMessage(message);
        } finally {
            setBusyAction(undefined);
        }
    };

    const runLocalRecipe = async (): Promise<void> => {
        if (!selectedRecipe?.recipe) {
            setLaunchError(recipePrerequisiteIssues[0]);
            return;
        }
        setBusyAction('local-run');
        setLaunchState('preparing');
        setLaunchError(undefined);
        setLaunchMessage(`Loading ${selectedRecipe.title}.`);
        try {
            await rallarBlackBoxRuntimeStore.loadRecipeFromJson(
                json(selectedRecipe.recipe),
                selectedRecipe.id,
            );
            setLaunchState('running');
            setLaunchMessage(`Running ${selectedRecipe.title} in this browser.`);
            await rallarBlackBoxRuntimeStore.runLoadedRecipe();
            const snapshot = rallarBlackBoxRuntimeStore.getSnapshot();
            const nextLaunchState = runnerLaunchStateFromRunState(
                snapshot.runState,
            );
            setLaunchState(nextLaunchState);
            setLaunchMessage(
                snapshot.lastError
                    ? runnerFriendlyErrorMessage(snapshot.lastError)
                    : snapshot.lastAction ??
                          `${selectedRecipe.title} finished.`,
            );
            setLaunchError(
                snapshot.lastError
                    ? runnerFriendlyErrorMessage(snapshot.lastError)
                    : undefined,
            );
        } catch (error) {
            setLaunchState('failed');
            setLaunchError(runnerFriendlyErrorMessage(error));
            setLaunchMessage('Local recipe failed.');
        } finally {
            setBusyAction(undefined);
        }
    };

    const runDistributedRecipe = async (): Promise<void> => {
        if (!selectedRecipe?.distributedItem) {
            setLaunchError(distributedDisabledReason);
            return;
        }
        setBusyAction('distributed-run');
        setLaunchState('preparing');
        setLaunchError(undefined);
        setArtifactBundle(undefined);
        try {
            const [serverSnapshot] = await Promise.all([
                fetchControlServerSnapshot({
                    baseUrl: controlBaseUrl,
                    token: controlToken,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                }),
            ]);
            setControlSnapshot(serverSnapshot);
            const knownRunIds = new Set(
                serverSnapshot.runs.map((run) => run.runId),
            );
            const nextRunId =
                [
                    controlRunId,
                    agentRunId,
                    control.runId,
                    bootstrap.runId,
                    serverSnapshot.runs[0]?.runId,
                ].find(
                    (candidate) => candidate && knownRunIds.has(candidate),
                ) ?? '';
            if (!nextRunId) {
                throw new Error('Control run missing.');
            }
            const latestControlRun = await fetchControlRunSnapshot({
                baseUrl: controlBaseUrl,
                token: controlToken,
                runId: nextRunId,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
            });
            setControlRunId(nextRunId);
            setControlRun(latestControlRun);
            const preflight = distributedRecipePreflight(
                selectedRecipe.distributedItem.recipe,
            );
            if (preflight.errors.length > 0) {
                throw new Error(preflight.errors[0]);
            }
            const resolvedRows = distributedRecipeTargetRows({
                run: latestControlRun,
                group: groupRef,
                requiredCommandKinds: preflight.commandKinds,
            });
            const agentIds = defaultDistributedRecipeTargetIds(resolvedRows);
            if (agentIds.length === 0) {
                throw new Error('No agents connected for this group.');
            }
            const distributedRunId =
                `dist-${safeIdSegment(groupRef.groupId || 'group')}-${Date.now()}`;
            const manifest = buildDistributedRunManifest({
                distributedRunId,
                controlRunId: nextRunId,
                displayName: selectedRecipe.title,
                group: groupRef,
                recipes: [selectedRecipe.distributedItem],
                targetAgentIds: agentIds,
                targetPolicyMode: 'selected-agents',
                rolePattern: 'all-agents',
                ackTimeoutMs: 15_000,
                startMode: 'manual',
                expectedParticipantCount: agentIds.length,
            });
            const manifestError = validateDistributedRecipeManifest(manifest);
            if (manifestError) {
                throw new Error(manifestError);
            }

            const distributedControlToken =
                await resolveDistributedControlToken();
            setLaunchMessage(
                `Creating ${distributedRunId} for ${agentIds.length} agent(s).`,
            );
            const created = await createDistributedRun({
                baseUrl: controlBaseUrl,
                token: distributedControlToken,
                manifest,
            });
            setLaunchMessage(`Staging ${created.distributedRunId}.`);
            const staged = await stageDistributedRun({
                baseUrl: controlBaseUrl,
                token: distributedControlToken,
                distributedRunId: created.distributedRunId,
            });
            setLaunchMessage(`Starting ${staged.distributedRunId}.`);
            const started = await startDistributedRun({
                baseUrl: controlBaseUrl,
                token: distributedControlToken,
                distributedRunId: staged.distributedRunId,
            });
            setDistributedRun(started);
            setLaunchState(
                started.state === 'passed'
                    ? started.rollup.ok
                        ? 'passed'
                        : 'failed'
                    : 'running',
            );
            setLaunchMessage(
                `Started ${started.distributedRunId}. Watch progress in Runs or Event Stream; artifact export is available after agents report.`,
            );
            onDistributedRunStarted({
                distributedRunId: started.distributedRunId,
                controlRunId: nextRunId,
                controlBaseUrl,
                controlToken,
            });
            void fetchDistributedRun({
                baseUrl: controlBaseUrl,
                token: controlToken,
                distributedRunId: started.distributedRunId,
            })
                .then((nextDistributedRun) => {
                    setDistributedRun(nextDistributedRun);
                })
                .catch(() => undefined);
        } catch (error) {
            setLaunchState('failed');
            setLaunchError(runnerFriendlyErrorMessage(error));
            setLaunchMessage('Distributed recipe failed to start.');
        } finally {
            setBusyAction(undefined);
        }
    };

    return (
        <section className="panel runner-recipes-panel">
            <div className="panel-heading">
                <h2>Recipes</h2>
                <span className={`pill ${runnerLaunchTone(launchState)}`}>
                    {busyAction ?? launchState}
                </span>
            </div>
            {selectedRecipe && (
                <div className="runner-quick-launch-strip runner-evidence-first">
                    <div>
                        <span>Selected recipe</span>
                        <strong>{selectedRecipe.title}</strong>
                        <small>{selectedRecipe.expectedResult}</small>
                    </div>
                    <div className="runner-recipe-actions-primary">
                        <button
                            type="button"
                            disabled={
                                Boolean(localDisabledReason) || localRunning
                            }
                            title={localDisabledReason}
                            onClick={() => void runLocalRecipe()}
                        >
                            Run in this browser
                        </button>
                        <button
                            type="button"
                            disabled={
                                Boolean(distributedDisabledReason) ||
                                localRunning
                            }
                            title={distributedDisabledReason}
                            onClick={() => void runDistributedRecipe()}
                        >
                            Run on connected agents
                        </button>
                    </div>
                    {(localDisabledReason || distributedDisabledReason) && (
                        <small className="runner-quick-launch-reason">
                            {localDisabledReason
                                ? `Local: ${localDisabledReason}`
                                : `Distributed: ${distributedDisabledReason}`}
                        </small>
                    )}
                </div>
            )}
            <RunnerReadinessPanel
                checks={readiness.checks}
                message={readiness.primaryMessage}
                refreshing={busyAction === 'refresh-readiness'}
                onRefresh={() => void refreshReadiness()}
                onOpenAgentTabs={openAgentTabs}
            />
            <ControlAgentBoardPanel
                title="Targetable Agents"
                subtitle={
                    selectedRecipe
                        ? `${selectedRecipe.title} against ${groupRef.groupId || 'missing group'}`
                        : 'Select a recipe to resolve connected agents.'
                }
                rows={recipeAgentRows}
                summary={recipeAgentSummary}
                emptyMessage="No control agents in the selected run. Open agent tabs, wait for registration, then refresh."
                compact
            />
            <RunnerAgentSetupPanel
                runId={agentRunId}
                agentPrefix={agentPrefix}
                agentCount={agentCount}
                restoreSession={agentRestoreSession}
                providerMode={bootstrap.providerMode}
                authSession={authSession}
                controlWsUrl={agentControlWsUrl}
                groupId={globalValues.roomId}
                connectedAgents={controlRun?.agents ?? []}
                launchUrls={agentLaunchUrls}
                launchMessage={agentLaunchMessage}
                showConnectedAgents={false}
                onRunIdChange={(value) => {
                    setAgentRunId(value);
                    setControlRunId(value);
                    setControlRun(undefined);
                }}
                onAgentPrefixChange={setAgentPrefix}
                onAgentCountChange={setAgentCount}
                onRestoreSessionChange={setAgentRestoreSession}
                onOpenAgents={openAgentTabs}
                onCopyLinks={() => void copyAgentLinks()}
            />
            <div className="runner-recipes-toolbar">
                <label className="field runner-recipes-search">
                    <span>Search Recipes</span>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="recipe, transport, profile, evidence"
                    />
                </label>
                <label className="field">
                    <span>Profile</span>
                    <select
                        value={profile}
                        onChange={(event) => setProfile(event.target.value)}
                    >
                        <option value="">All profiles</option>
                        {profileOptions.map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>Source</span>
                    <select
                        value={sourceFilter}
                        onChange={(event) =>
                            setSourceFilter(
                                event.target.value as RunnerRecipeSource | 'all',
                            )
                        }
                    >
                        <option value="all">All sources</option>
                        <option value="app-local">App-local</option>
                        <option value="shared-test">Shared-test</option>
                    </select>
                </label>
                <label className="field">
                    <span>Control URL</span>
                    <input
                        value={controlBaseUrl}
                        onChange={(event) =>
                            setControlBaseUrl(event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Control Token</span>
                    <input
                        value={controlToken}
                        type="password"
                        autoComplete="off"
                        onChange={(event) => setControlToken(event.target.value)}
                    />
                    {!controlToken.trim() && authSession && brokeredControlToken && (
                        <small className="runner-control-token-status">
                            Session control token valid until {formatTime(
                                brokeredControlToken.expiresAtEpochMs,
                            )}
                        </small>
                    )}
                    {!controlToken.trim() && authSession && !brokeredControlToken && (
                        <small className="runner-control-token-status">
                            Session control token will be requested when needed.
                        </small>
                    )}
                    {!controlToken.trim() && brokeredControlTokenError && (
                        <small className="runner-control-token-error">
                            {brokeredControlTokenError}
                        </small>
                    )}
                </label>
            </div>
            <div className="runner-recipes-summary-grid">
                <Metric
                    label="Visible"
                    value={String(filteredRecipes.length)}
                    tone="active"
                />
                <Metric
                    label="App-local"
                    value={String(
                        catalog.filter((entry) => entry.source === 'app-local')
                            .length,
                    )}
                />
                <Metric
                    label="Shared-test"
                    value={String(
                        catalog.filter((entry) => entry.source === 'shared-test')
                            .length,
                    )}
                />
                <Metric label="API" value={apiProbe.detail} tone={apiProbe.status === 'online' ? 'good' : apiProbe.status === 'checking' ? 'active' : 'bad'} />
                <Metric label="Control" value={controlProbe.detail} tone={controlProbe.status === 'online' ? 'good' : controlProbe.status === 'checking' ? 'active' : 'bad'} />
                <Metric
                    label="Agents"
                    value={`${targetableRows.length}/${connectedAgentCount}`}
                    tone={targetableRows.length > 0 ? 'good' : 'bad'}
                />
            </div>
            <div className="runner-recipes-layout">
                <section className="runner-recipe-list" aria-label="Recipe catalog">
                    {filteredRecipes.map((entry) => {
                        const selected = selectedRecipe?.id === entry.id;
                        const preview = entry.recipe
                            ? distributedRecipeCommandPreview(entry.recipe)
                            : undefined;
                        return (
                            <article
                                className={`runner-recipe-card ${selected ? 'selected' : ''}`}
                                key={entry.id}
                            >
                                <button
                                    type="button"
                                    className="runner-recipe-select"
                                    onClick={() => setSelectedRecipeId(entry.id)}
                                >
                                    <span>
                                        <strong>{entry.title}</strong>
                                        <small>{entry.path}</small>
                                    </span>
                                    <span
                                        className={`pill ${entry.source === 'app-local' ? 'active' : 'muted'}`}
                                    >
                                        {entry.source}
                                    </span>
                                </button>
                                <p>{entry.description}</p>
                                <div className="badge-list">
                                    <span className="pill muted">
                                        {entry.providerMode}
                                    </span>
                                    <span
                                        className={`pill ${entry.live ? 'warn' : 'good'}`}
                                    >
                                        {entry.live ? 'live' : 'local-safe'}
                                    </span>
                                    <span className="pill active">
                                        {preview?.label ??
                                            `${entry.commandCount ?? 0} command${entry.commandCount === 1 ? '' : 's'}`}
                                    </span>
                                </div>
                                {selected && (
                                    <div className="runner-recipe-card-actions">
                                        <button
                                            type="button"
                                            disabled={
                                                Boolean(localDisabledReason) ||
                                                localRunning
                                            }
                                            title={localDisabledReason}
                                            onClick={() =>
                                                void runLocalRecipe()
                                            }
                                        >
                                            Run in this browser
                                        </button>
                                        <button
                                            type="button"
                                            disabled={
                                                Boolean(
                                                    distributedDisabledReason,
                                                ) || localRunning
                                            }
                                            title={distributedDisabledReason}
                                            onClick={() =>
                                                void runDistributedRecipe()
                                            }
                                        >
                                            Run on connected agents
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setShowEditor((value) => !value)
                                            }
                                        >
                                            Open in editor
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void copyText(
                                                    entry.copyCommand,
                                                    'Copied recipe command.',
                                                )
                                            }
                                        >
                                            Copy command
                                        </button>
                                    </div>
                                )}
                            </article>
                        );
                    })}
                    {filteredRecipes.length === 0 && (
                        <div className="empty-state">
                            No recipes match the filters
                        </div>
                    )}
                </section>
                <section className="runner-recipe-detail">
                    <div className="section-heading">
                        <h3>{selectedRecipe?.title ?? 'No recipe selected'}</h3>
                        <span
                            className={`pill ${runnerLaunchTone(launchState)}`}
                        >
                            {launchState}
                        </span>
                    </div>
                    {selectedRecipe ? (
                        <>
                            <div className="runner-recipe-actions-primary">
                                <button
                                    type="button"
                                    disabled={
                                        Boolean(localDisabledReason) ||
                                        localRunning
                                    }
                                    title={localDisabledReason}
                                    onClick={() => void runLocalRecipe()}
                                >
                                    Run in this browser
                                </button>
                                <button
                                    type="button"
                                    disabled={
                                        Boolean(distributedDisabledReason) ||
                                        localRunning
                                    }
                                    title={distributedDisabledReason}
                                    onClick={() => void runDistributedRecipe()}
                                >
                                    Run on connected agents
                                </button>
                            </div>
                            {(localDisabledReason ||
                                distributedDisabledReason) && (
                                <div className="runner-disabled-reasons">
                                    {localDisabledReason && (
                                        <span>
                                            Local: {localDisabledReason}
                                        </span>
                                    )}
                                    {distributedDisabledReason && (
                                        <span>
                                            Distributed:{' '}
                                            {distributedDisabledReason}
                                        </span>
                                    )}
                                </div>
                            )}
                            <dl className="config-list runner-recipe-meta">
                                <div>
                                    <dt>Expected result</dt>
                                    <dd>{selectedRecipe.expectedResult}</dd>
                                </div>
                                <div>
                                    <dt>Provider</dt>
                                    <dd>{selectedRecipe.providerMode}</dd>
                                </div>
                                <div>
                                    <dt>Control run</dt>
                                    <dd>{controlRunId || 'missing'}</dd>
                                </div>
                                <div>
                                    <dt>Group</dt>
                                    <dd>{globalValues.roomId || 'missing'}</dd>
                                </div>
                            </dl>
                            <div className="runner-requirements">
                                <h3>Prerequisites</h3>
                                {selectedRecipe.requirements.length === 0 ? (
                                    <div className="empty-state">
                                        No additional prerequisites
                                    </div>
                                ) : (
                                    <ul>
                                        {selectedRecipe.requirements.map(
                                            (requirement) => (
                                                <li key={requirement}>
                                                    {requirement}
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                )}
                            </div>
                            {recipePreflight && (
                                <details className="runner-preflight" open>
                                    <summary>Recipe preflight</summary>
                                    <DistributedRecipePreflightPanel
                                        preflight={recipePreflight}
                                        compact
                                    />
                                </details>
                            )}
                            <div
                                className={`runner-launch-result ${runnerLaunchTone(launchState)}`}
                                role="status"
                            >
                                <strong>{launchMessage}</strong>
                                {(launchError || lastError) && (
                                    <span>
                                        {launchError ??
                                            runnerFriendlyErrorMessage(
                                                lastError,
                                            )}
                                    </span>
                                )}
                            </div>
                            <div className="runner-result-grid">
                                <Metric
                                    label="Runtime state"
                                    value={runState}
                                    tone={statusTone(runState)}
                                />
                                <Metric
                                    label="Commands"
                                    value={String(history.length)}
                                />
                                <Metric
                                    label="Failures"
                                    value={String(failures.length)}
                                    tone={failures.length > 0 ? 'bad' : 'good'}
                                />
                                <Metric
                                    label="Last result"
                                    value={
                                        latestResult
                                            ? resultSummary(latestResult)
                                            : '-'
                                    }
                                    tone={
                                        latestResult?.ok === false
                                            ? 'bad'
                                            : latestResult
                                              ? 'good'
                                              : 'muted'
                                    }
                                />
                            </div>
                            {firstFailure && (
                                <div className="runner-failure-focus">
                                    <strong>First failed step</strong>
                                    <span>{resultSummary(firstFailure)}</span>
                                    <small>
                                        Likely cause: {firstFailure.error?.message ?? 'runtime evidence did not match the recipe expectation.'}
                                    </small>
                                    <small>
                                        Next action: fix readiness, inspect Event Stream, then rerun this recipe.
                                    </small>
                                </div>
                            )}
                            {distributedRun && (
                                <div className="distributed-run-summary runner-distributed-summary">
                                    <Metric
                                        label="Distributed run"
                                        value={distributedRun.distributedRunId}
                                    />
                                    <Metric
                                        label="State"
                                        value={distributedRun.state}
                                        tone={distributedRecipeStateTone(
                                            distributedRun.state,
                                        )}
                                    />
                                    <Metric
                                        label="Targets"
                                        value={String(
                                            distributedRun.targetAgentIds.length,
                                        )}
                                    />
                                    <Metric
                                        label="Blocking failures"
                                        value={String(
                                            distributedRun.rollup.summary
                                                .blockingFailures,
                                        )}
                                        tone={
                                            distributedRun.rollup.summary
                                                .blockingFailures > 0
                                                ? 'bad'
                                                : 'good'
                                        }
                                    />
                                </div>
                            )}
                            {artifactBundle && (
                                <div
                                    className="distributed-artifact-summary runner-artifact-summary"
                                    aria-label="Artifact summary"
                                >
                                    <Metric
                                        label="Artifact"
                                        value={`schema ${artifactBundle.artifactSchemaVersion}`}
                                    />
                                    <Metric
                                        label="Files"
                                        value={String(
                                            Object.keys(artifactBundle.files)
                                                .length,
                                        )}
                                        tone="good"
                                    />
                                    <Metric
                                        label="Generated"
                                        value={formatTime(
                                            artifactBundle.generatedAtEpochMs,
                                        )}
                                    />
                                </div>
                            )}
                            {!artifactBundle && history.length > 0 && (
                                <div
                                    className="runner-artifact-summary"
                                    aria-label="Artifact summary"
                                >
                                    <Metric
                                        label="Artifact"
                                        value="local replay"
                                        tone="good"
                                    />
                                    <Metric
                                        label="Commands"
                                        value={String(history.length)}
                                    />
                                    <Metric
                                        label="Events"
                                        value={String(state.events.length)}
                                    />
                                    <Metric
                                        label="Replay"
                                        value={latestResult?.commandId ?? '-'}
                                        tone={latestResult ? 'active' : 'muted'}
                                    />
                                </div>
                            )}
                            {showEditor && (
                                <div className="runner-inline-editor">
                                    <div className="section-heading">
                                        <h3>Recipe JSON</h3>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                selectedRecipe.recipe
                                                    ? void copyText(
                                                          json(
                                                              selectedRecipe.recipe,
                                                          ),
                                                          'Copied recipe JSON.',
                                                      )
                                                    : void copyText(
                                                          selectedRecipe.copyCommand,
                                                          'Copied recipe command.',
                                                      )
                                            }
                                        >
                                            Copy
                                        </button>
                                    </div>
                                    <pre className="json-block">
                                        {selectedRecipe.recipe
                                            ? json(selectedRecipe.recipe)
                                            : selectedRecipe.copyCommand}
                                    </pre>
                                </div>
                            )}
                            <div className="runner-secondary-actions">
                                <button
                                    type="button"
                                    onClick={() => onOpenTab('runs')}
                                >
                                    Open Runs
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onOpenTab('builder')}
                                >
                                    Open Builder
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onOpenTab('advanced')}
                                >
                                    Open Advanced
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="empty-state">No recipe selected</div>
                    )}
                </section>
            </div>
        </section>
    );
}

function RunnerRunsPanel({
    state,
    bootstrap,
    control,
    authSession,
    preferredDistributedRun,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    authSession?: AuthSession;
    preferredDistributedRun?: RunnerDistributedRunSelection;
}) {
    const history = selectRallarBlackBoxCommandHistory(state);
    const failures = selectRallarBlackBoxFailures(state);
    const latestStats = selectRallarBlackBoxLatestStats(state);
    const recentHistory = [...history].reverse().slice(0, 12);
    const initialSyntheticSeed = useMemo<SyntheticDistributedRunSeed | undefined>(
        () => {
            const distributedRunSeed = readDistributedRunSeedFromUrl();
            return distributedRunSeed
                ? createSyntheticDistributedRunSeed(distributedRunSeed)
                : undefined;
        },
        [],
    );
    const [controlBaseUrl, setControlBaseUrl] = useState(() =>
        preferredDistributedRun?.controlBaseUrl ??
            controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl)
    );
    const [controlToken, setControlToken] = useState(
        preferredDistributedRun?.controlToken ?? bootstrap.controlToken ?? '',
    );
    const [controlRunId, setControlRunId] = useState(
        initialSyntheticSeed?.controlRun.runId ??
            preferredDistributedRun?.controlRunId ?? control.runId ??
            bootstrap.runId ?? '',
    );
    const [distributedRuns, setDistributedRuns] = useState<
        readonly ControlDistributedRunSnapshot[]
    >(() => initialSyntheticSeed ? [initialSyntheticSeed.distributedRun] : []);
    const [selectedDistributedRunId, setSelectedDistributedRunId] = useState(
        initialSyntheticSeed?.distributedRun.distributedRunId ??
            preferredDistributedRun?.distributedRunId ?? '',
    );
    const [selectedDistributedRun, setSelectedDistributedRun] = useState<
        ControlDistributedRunSnapshot | undefined
    >(initialSyntheticSeed?.distributedRun);
    const [distributedControlRun, setDistributedControlRun] = useState<
        ControlRunSnapshot | undefined
    >(initialSyntheticSeed?.controlRun);
    const [artifactBundle, setArtifactBundle] = useState<
        ControlDistributedRunArtifactBundle | undefined
    >(initialSyntheticSeed?.artifactBundle);
    const [importedArtifactAnalysis, setImportedArtifactAnalysis] = useState<
        DistributedRunAnalysis | undefined
    >();
    const [importedArtifactStatus, setImportedArtifactStatus] = useState<
        DistributedArtifactImportStatus | undefined
    >();
    const [selectedSyntheticSeedId, setSelectedSyntheticSeedId] = useState<
        DistributedRunSeedId | ''
    >(initialSyntheticSeed?.id ?? '');
    const [activeSyntheticSeed, setActiveSyntheticSeed] = useState<
        SyntheticDistributedRunSeed | undefined
    >(initialSyntheticSeed);
    const [distributedBusy, setDistributedBusy] = useState<string | undefined>();
    const [distributedError, setDistributedError] = useState<string | undefined>();
    const [lastDistributedRefresh, setLastDistributedRefresh] =
        useState<number | undefined>(initialSyntheticSeed?.generatedAtEpochMs);
    const [compareLeftId, setCompareLeftId] = useState(
        initialSyntheticSeed?.distributedRun.distributedRunId ?? '',
    );
    const [compareRightId, setCompareRightId] = useState('');
    const didInitialDistributedRefresh = useRef(false);
    const activeSyntheticSeedRef = useRef<SyntheticDistributedRunSeed | undefined>(
        initialSyntheticSeed,
    );
    const selectedMonitor = useMemo(
        () =>
            selectedDistributedRun
                ? deriveDistributedRunMonitor({
                    distributedRun: selectedDistributedRun,
                    controlRun: distributedControlRun,
                    artifactBundle,
                })
                : undefined,
        [artifactBundle, distributedControlRun, selectedDistributedRun],
    );
    const runParticipantRows = useMemo(
        () =>
            selectedDistributedRun
                ? deriveControlAgentBoardRows({
                    run: distributedControlRun,
                    group: selectedDistributedRun.manifest.group,
                    agentIds: selectedDistributedRun.targetAgentIds,
                    distributedRuns,
                    selectedDistributedRun,
                    monitorAgentProgress: selectedMonitor?.agentProgress ?? [],
                    nowEpochMs: Date.now(),
                })
                : [],
        [
            distributedControlRun,
            distributedRuns,
            selectedDistributedRun,
            selectedMonitor?.agentProgress,
        ],
    );
    const runParticipantSummary = useMemo(
        () => summarizeControlAgentBoardRows(runParticipantRows),
        [runParticipantRows],
    );
    const analysisReport = useMemo(
        () =>
            selectedDistributedRun
                ? deriveDistributedRunAnalysisReport({
                    distributedRun: selectedDistributedRun,
                    controlRun: distributedControlRun,
                    artifactBundle,
                    snapshotBounds: DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS,
                })
                : undefined,
        [artifactBundle, distributedControlRun, selectedDistributedRun],
    );
    const runVerdict = useMemo(
        () =>
            deriveRunVerdictView({
                distributedRun: selectedDistributedRun,
                monitor: selectedMonitor,
                report: analysisReport,
                artifactBundle,
                refreshedAtEpochMs: lastDistributedRefresh,
            }),
        [
            analysisReport,
            artifactBundle,
            lastDistributedRefresh,
            selectedDistributedRun,
            selectedMonitor,
        ],
    );
    const rtcDiagnostics = useMemo(() => deriveRtcDiagnostics(state), [state]);
    const rtcPerformance = useMemo(
        () =>
            deriveRtcPerformanceView({
                diagnostics: rtcDiagnostics,
                state,
                distributedMonitor: selectedMonitor,
            }),
        [rtcDiagnostics, selectedMonitor, state],
    );
    const compareLeftRun = useMemo(
        () =>
            distributedRuns.find(
                (item) => item.distributedRunId === compareLeftId,
            ),
        [compareLeftId, distributedRuns],
    );
    const compareRightRun = useMemo(
        () =>
            distributedRuns.find(
                (item) => item.distributedRunId === compareRightId,
            ),
        [compareRightId, distributedRuns],
    );
    const compareSummary = useMemo(
        () =>
            compareLeftRun && compareRightRun
                ? compareDistributedRuns({
                    left: compareLeftRun,
                    right: compareRightRun,
                    leftControlRun:
                        compareLeftRun.controlRunId === distributedControlRun?.runId
                            ? distributedControlRun
                            : undefined,
                    rightControlRun:
                        compareRightRun.controlRunId === distributedControlRun?.runId
                            ? distributedControlRun
                            : undefined,
                })
                : undefined,
        [compareLeftRun, compareRightRun, distributedControlRun],
    );

    const refreshDistributedAnalysis = async (
        override?: RunnerDistributedRunSelection,
        options: Readonly<{ loadArtifact?: boolean; quiet?: boolean }> = {},
    ): Promise<void> => {
        if (activeSyntheticSeedRef.current && !override) {
            return;
        }
        const baseUrl = override?.controlBaseUrl ?? controlBaseUrl;
        const token = override?.controlToken ?? controlToken;
        const preferredRunId =
            override?.distributedRunId ?? selectedDistributedRunId;
        if (!options.quiet) {
            setDistributedBusy(options.loadArtifact ? 'artifact' : 'refresh');
        }
        setDistributedError(undefined);
        try {
            const fetchedRuns = await fetchDistributedRuns({ baseUrl, token });
            const list = [...fetchedRuns].sort(
                (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
            );
            const selectedFromList = preferredRunId
                ? list.find((item) => item.distributedRunId === preferredRunId)
                : undefined;
            const nextDistributedRun = preferredRunId
                ? await fetchDistributedRun({
                    baseUrl,
                    token,
                    distributedRunId: preferredRunId,
                }).catch(() => selectedFromList)
                : list[0];
            const nextControlRunId =
                nextDistributedRun?.controlRunId ?? override?.controlRunId ??
                    controlRunId;
            const nextControlRun = nextControlRunId
                ? await fetchControlRunSnapshot({
                    baseUrl,
                    token,
                    runId: nextControlRunId,
                    bounds: DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS,
                }).catch(() => undefined)
                : undefined;
            const shouldLoadArtifact = Boolean(
                nextDistributedRun &&
                    (options.loadArtifact ||
                        isDistributedRunTerminalState(nextDistributedRun.state)),
            );
            const nextArtifact = shouldLoadArtifact && nextDistributedRun
                ? await fetchDistributedRunArtifactBundle({
                    baseUrl,
                    token,
                    distributedRunId: nextDistributedRun.distributedRunId,
                }).catch(() => undefined)
                : preferredRunId === selectedDistributedRunId
                ? artifactBundle
                : undefined;

            if (activeSyntheticSeedRef.current && !override) {
                return;
            }
            setControlBaseUrl(baseUrl);
            setControlToken(token ?? '');
            setDistributedRuns(list);
            setSelectedDistributedRun(nextDistributedRun);
            setSelectedDistributedRunId(nextDistributedRun?.distributedRunId ?? '');
            setControlRunId(nextControlRunId ?? '');
            setDistributedControlRun(nextControlRun);
            setArtifactBundle(nextArtifact);
            setImportedArtifactAnalysis(undefined);
            setImportedArtifactStatus(undefined);
            setLastDistributedRefresh(Date.now());
            setCompareLeftId((current) =>
                current || nextDistributedRun?.distributedRunId || '',
            );
            setCompareRightId((current) => {
                if (current) {
                    return current;
                }
                const otherRun = list.find(
                    (item) =>
                        item.distributedRunId !==
                            nextDistributedRun?.distributedRunId,
                );
                return otherRun?.distributedRunId ?? '';
            });
        } catch (error) {
            setDistributedError(runnerFriendlyErrorMessage(error));
        } finally {
            if (!options.quiet) {
                setDistributedBusy(undefined);
            }
        }
    };

    const applySyntheticDistributedRunSeed = (
        seedId: DistributedRunSeedId,
    ): void => {
        const seed = createSyntheticDistributedRunSeed(seedId);
        activeSyntheticSeedRef.current = seed;
        setActiveSyntheticSeed(seed);
        setSelectedSyntheticSeedId(seed.id);
        setDistributedBusy(undefined);
        setDistributedError(undefined);
        setImportedArtifactAnalysis(undefined);
        setImportedArtifactStatus(undefined);
        setDistributedRuns([seed.distributedRun]);
        setSelectedDistributedRun(seed.distributedRun);
        setSelectedDistributedRunId(seed.distributedRun.distributedRunId);
        setControlRunId(seed.controlRun.runId);
        setDistributedControlRun(seed.controlRun);
        setArtifactBundle(seed.artifactBundle);
        setLastDistributedRefresh(seed.generatedAtEpochMs);
        setCompareLeftId(seed.distributedRun.distributedRunId);
        setCompareRightId('');
        writeDistributedRunSeedToUrl(seed.id);
    };

    const clearSyntheticDistributedRunSeed = (): void => {
        activeSyntheticSeedRef.current = undefined;
        setActiveSyntheticSeed(undefined);
        setSelectedSyntheticSeedId('');
        setDistributedRuns([]);
        setSelectedDistributedRun(undefined);
        setSelectedDistributedRunId('');
        setDistributedControlRun(undefined);
        setArtifactBundle(undefined);
        setLastDistributedRefresh(undefined);
        setCompareLeftId('');
        setCompareRightId('');
        setDistributedError(undefined);
        setImportedArtifactAnalysis(undefined);
        setImportedArtifactStatus(undefined);
        writeDistributedRunSeedToUrl(undefined);
    };

    const selectSyntheticDistributedRunSeed = (value: string): void => {
        const seedId = distributedRunSeedIdFromValue(value);
        if (seedId) {
            applySyntheticDistributedRunSeed(seedId);
            return;
        }
        clearSyntheticDistributedRunSeed();
    };

    const loadDistributedArtifact = async (): Promise<void> => {
        if (activeSyntheticSeed) {
            setArtifactBundle(activeSyntheticSeed.artifactBundle);
            return;
        }
        await refreshDistributedAnalysis(undefined, {
            loadArtifact: true,
        });
    };

    const handleDistributedArtifactFiles = async (
        event: ChangeEvent<HTMLInputElement>,
    ): Promise<void> => {
        const selectedFiles = Array.from(event.currentTarget.files ?? []);
        if (selectedFiles.length === 0) {
            return;
        }
        setDistributedBusy('artifact import');
        setDistributedError(undefined);
        try {
            const files: Record<string, string> = {};
            await Promise.all(selectedFiles.map(async (file) => {
                files[file.name] = await file.text();
            }));
            const generatedAtEpochMs = Date.now();
            const artifactFiles: DistributedRunArtifactFiles = files;
            const analysis = analyzeDistributedRunArtifactFiles({
                files: artifactFiles,
                generatedAtEpochMs,
            });
            const snapshots = distributedArtifactSnapshotsFromFiles(
                artifactFiles,
                generatedAtEpochMs,
            );
            const bundle = distributedArtifactBundleFromFiles(
                artifactFiles,
                generatedAtEpochMs,
                analysis.distributedRunId,
            );
            activeSyntheticSeedRef.current = undefined;
            setActiveSyntheticSeed(undefined);
            setSelectedSyntheticSeedId('');
            setImportedArtifactAnalysis(analysis);
            setImportedArtifactStatus(distributedArtifactImportStatus(
                artifactFiles,
                analysis.parseWarnings.length,
            ));
            setDistributedRuns((current) => [
                snapshots.distributedRun,
                ...current.filter((item) =>
                    item.distributedRunId !== snapshots.distributedRun.distributedRunId
                ),
            ]);
            setSelectedDistributedRun(snapshots.distributedRun);
            setSelectedDistributedRunId(snapshots.distributedRun.distributedRunId);
            setControlRunId(snapshots.controlRun.runId);
            setDistributedControlRun(snapshots.controlRun);
            setArtifactBundle(bundle ?? snapshots.artifactBundle);
            setLastDistributedRefresh(generatedAtEpochMs);
            setCompareLeftId(snapshots.distributedRun.distributedRunId);
            setCompareRightId('');
            writeDistributedRunSeedToUrl(undefined);
        } catch (error) {
            setDistributedError(runnerFriendlyErrorMessage(error));
        } finally {
            setDistributedBusy(undefined);
            event.currentTarget.value = '';
        }
    };

    useEffect(() => {
        if (!preferredDistributedRun) {
            return;
        }
        activeSyntheticSeedRef.current = undefined;
        setActiveSyntheticSeed(undefined);
        setSelectedSyntheticSeedId('');
        writeDistributedRunSeedToUrl(undefined);
        setArtifactBundle(undefined);
        setControlBaseUrl(preferredDistributedRun.controlBaseUrl);
        setControlToken(preferredDistributedRun.controlToken ?? '');
        setControlRunId(preferredDistributedRun.controlRunId);
        setSelectedDistributedRunId(preferredDistributedRun.distributedRunId);
        void refreshDistributedAnalysis(preferredDistributedRun);
        // The preferred run object is the handoff from Recipes into Runs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        preferredDistributedRun?.controlBaseUrl,
        preferredDistributedRun?.controlRunId,
        preferredDistributedRun?.controlToken,
        preferredDistributedRun?.distributedRunId,
    ]);

    useEffect(() => {
        if (
            didInitialDistributedRefresh.current ||
            preferredDistributedRun ||
            activeSyntheticSeedRef.current
        ) {
            return;
        }
        didInitialDistributedRefresh.current = true;
        void refreshDistributedAnalysis(undefined, { quiet: true });
        // Initial distributed analysis uses first rendered control values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (
            activeSyntheticSeed ||
            !selectedDistributedRun ||
            isDistributedRunTerminalState(selectedDistributedRun.state)
        ) {
            return;
        }
        const timer = window.setInterval(() => {
            void refreshDistributedAnalysis(undefined, { quiet: true });
        }, RUNNER_DISTRIBUTED_POLL_MS);
        return () => window.clearInterval(timer);
        // Poll the selected run while it is non-terminal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        controlBaseUrl,
        controlToken,
        selectedDistributedRun?.distributedRunId,
        selectedDistributedRun?.state,
    ]);

    useEffect(() => {
        if (
            activeSyntheticSeed ||
            !selectedDistributedRun ||
            !isDistributedRunTerminalState(selectedDistributedRun.state) ||
            artifactBundle
        ) {
            return;
        }
        void refreshDistributedAnalysis(undefined, {
            loadArtifact: true,
            quiet: true,
        });
        // Terminal runs should pull artifacts automatically.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        artifactBundle,
        selectedDistributedRun?.distributedRunId,
        selectedDistributedRun?.state,
    ]);

    const selectDistributedRun = (distributedRunId: string): void => {
        setSelectedDistributedRunId(distributedRunId);
        setArtifactBundle(undefined);
        setImportedArtifactAnalysis(undefined);
        setImportedArtifactStatus(undefined);
        const selected = distributedRuns.find(
            (item) => item.distributedRunId === distributedRunId,
        );
        void refreshDistributedAnalysis({
            distributedRunId,
            controlRunId: selected?.controlRunId ?? controlRunId,
            controlBaseUrl,
            controlToken,
        });
    };

    const copyDistributedArtifact = async (): Promise<void> => {
        if (!artifactBundle) {
            return;
        }
        await navigator.clipboard?.writeText(json(artifactBundle.files));
    };

    return (
        <section className="panel runner-runs-panel">
            <div className="panel-heading">
                <h2>Runs</h2>
                <span>{control.runId ?? bootstrap.runId ?? 'local'}</span>
            </div>
            <RunVerdictPanel view={runVerdict} />
            <CausalTrailPanel items={runVerdict.causalTrail} />
            <RtcPerformancePanel view={rtcPerformance} compact />
            <section className="runner-distributed-analysis">
                <div className="section-heading">
                    <h3>Distributed Analysis</h3>
                    <span
                        className={`pill ${selectedDistributedRun ? distributedRecipeStateTone(selectedDistributedRun.state) : 'muted'}`}
                    >
                        {distributedBusy ??
                            selectedDistributedRun?.state ??
                            'no run'}
                    </span>
                </div>
                {activeSyntheticSeed && (
                    <div className="synthetic-seed-notice" role="status">
                        <span className="pill warn">Synthetic evidence</span>
                        <strong>{activeSyntheticSeed.label}</strong>
                        <span>{activeSyntheticSeed.description}</span>
                    </div>
                )}
                <div className="runner-distributed-toolbar">
                    <label className="field synthetic-seed-control">
                        <span>Synthetic seed</span>
                        <select
                            value={selectedSyntheticSeedId}
                            onChange={(event) =>
                                selectSyntheticDistributedRunSeed(
                                    event.target.value,
                                )}
                        >
                            <option value="">Real control data</option>
                            {DISTRIBUTED_RUN_SEEDS.map((seed) => (
                                <option key={seed.id} value={seed.id}>
                                    {seed.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Control HTTP</span>
                        <input
                            disabled={Boolean(activeSyntheticSeed)}
                            value={controlBaseUrl}
                            onChange={(event) =>
                                setControlBaseUrl(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Token</span>
                        <input
                            type="password"
                            autoComplete="off"
                            disabled={Boolean(activeSyntheticSeed)}
                            value={controlToken}
                            onChange={(event) =>
                                setControlToken(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Distributed Run</span>
                        <select
                            disabled={Boolean(activeSyntheticSeed)}
                            value={selectedDistributedRunId}
                            onChange={(event) =>
                                selectDistributedRun(event.target.value)
                            }
                        >
                            <option value="">Latest run</option>
                            {distributedRuns.map((run) => (
                                <option
                                    key={run.distributedRunId}
                                    value={run.distributedRunId}
                                >
                                    {run.distributedRunId}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        disabled={Boolean(distributedBusy) || Boolean(activeSyntheticSeed)}
                        onClick={() => void refreshDistributedAnalysis()}
                    >
                        Refresh
                    </button>
                    <button
                        type="button"
                        disabled={
                            Boolean(distributedBusy) ||
                            (Boolean(activeSyntheticSeed) && !artifactBundle) ||
                            !selectedDistributedRun
                        }
                        onClick={() => void loadDistributedArtifact()}
                    >
                        Export artifact
                    </button>
                    <button
                        type="button"
                        disabled={!artifactBundle}
                        onClick={() => void copyDistributedArtifact()}
                    >
                        Copy artifact
                    </button>
                    <label className="field distributed-artifact-import-field">
                        <span>Import CI artifact</span>
                        <input
                            type="file"
                            multiple
                            accept=".json,.jsonl,application/json"
                            {...({ webkitdirectory: 'true' } as Record<string, string>)}
                            disabled={Boolean(distributedBusy)}
                            onChange={(event) =>
                                void handleDistributedArtifactFiles(event)}
                        />
                        <small>
                            Select the artifact directory, or select all JSON and JSONL files from it.
                        </small>
                    </label>
                    {activeSyntheticSeed && (
                        <button
                            type="button"
                            onClick={clearSyntheticDistributedRunSeed}
                        >
                            Clear seed
                        </button>
                    )}
                </div>
                <div className="runner-distributed-freshness">
                    <span>
                        {lastDistributedRefresh
                            ? `Fresh ${formatTime(lastDistributedRefresh)}`
                            : 'Not refreshed yet'}
                    </span>
                    <span>{controlRunId || 'no control run'}</span>
                </div>
                {distributedError && (
                    <div className="workbench-error" role="status">
                        {distributedError}
                    </div>
                )}
                {!selectedDistributedRun && !distributedError && (
                    <div className="empty-state">
                        No distributed run selected. Start a recipe on connected
                        agents or refresh the control server.
                    </div>
                )}
                {selectedDistributedRun && (
                    <DistributedRunSummary run={selectedDistributedRun} />
                )}
                {selectedDistributedRun && (
                    <ControlAgentBoardPanel
                        title="Run Participants"
                        subtitle={`${selectedDistributedRun.distributedRunId} participants and live control-agent status`}
                        rows={runParticipantRows}
                        summary={runParticipantSummary}
                        emptyMessage="No target agents recorded for the selected distributed run."
                        compact
                    />
                )}
                {analysisReport && (
                    <DistributedRunAnalysisReportPanel
                        report={analysisReport}
                    />
                )}
                {importedArtifactAnalysis && (
                    <ImportedDistributedArtifactAnalysisPanel
                        analysis={importedArtifactAnalysis}
                        status={importedArtifactStatus}
                    />
                )}
                {selectedMonitor && (
                    <DistributedRunMonitorPanel monitor={selectedMonitor} />
                )}
                {distributedRuns.length > 1 && (
                    <DistributedRunComparePanel
                        runs={distributedRuns}
                        leftId={compareLeftId}
                        rightId={compareRightId}
                        summary={compareSummary}
                        onLeftChange={setCompareLeftId}
                        onRightChange={setCompareRightId}
                    />
                )}
            </section>
            <div className="runner-runs-summary-grid">
                <Metric
                    label="Runtime"
                    value={state.status}
                    tone={statusTone(state.status)}
                />
                <Metric label="Commands" value={String(history.length)} />
                <Metric
                    label="Failures"
                    value={String(failures.length)}
                    tone={failures.length > 0 ? 'bad' : 'good'}
                />
                <Metric
                    label="Events"
                    value={String(state.events.length)}
                    tone="active"
                />
                <Metric
                    label="Stats"
                    value={latestStats ? formatTime(latestStats.atEpochMs) : '-'}
                />
                <Metric
                    label="Control"
                    value={control.state}
                    tone={statusTone(control.state)}
                />
            </div>
            <div className="runner-runs-layout">
                <section className="runner-runs-subpanel">
                    <div className="section-heading">
                        <h3>Recent commands</h3>
                        <span>{recentHistory.length}</span>
                    </div>
                    <div className="run-manager-command-list">
                        {recentHistory.map((result, index) => (
                            <article
                                className="run-manager-command-row"
                                key={`${result.commandId}-${index}`}
                            >
                                <span>
                                    <strong>{result.commandId}</strong>
                                    <small>{result.kind}</small>
                                </span>
                                <span
                                    className={`pill ${result.ok ? 'good' : 'bad'}`}
                                >
                                    {result.ok ? 'ok' : 'failed'}
                                </span>
                            </article>
                        ))}
                        {recentHistory.length === 0 && (
                            <div className="empty-state">No local run yet</div>
                        )}
                    </div>
                </section>
                <section className="runner-runs-subpanel">
                    <FailurePanel state={state} authSession={authSession} />
                </section>
                <section className="runner-runs-subpanel">
                    <ReportPanel state={state} authSession={authSession} />
                </section>
            </div>
        </section>
    );
}

type FleetFilterState = Readonly<{
    region: string;
    provider: string;
    recipeId: string;
    groupId: string;
    state: string;
    window: '1h' | '24h' | '7d' | 'all';
}>;

type FleetAgentHeatmapRow = Readonly<{
    agent: ControlFleetAgentRunOutcome;
    region: string;
    provider: string;
    cells: readonly (ControlFleetAgentRunOutcome | undefined)[];
}>;

type FleetTimingGroup = Readonly<{
    id: string;
    label: string;
    timing: ControlFleetTimingDistribution;
}>;

type FleetLabelOverride = Readonly<{
    region?: string;
    provider?: string;
    datacenter?: string;
    hostId?: string;
    agentPoolId?: string;
    deploymentId?: string;
    browserName?: string;
    browserVersion?: string;
    os?: string;
    tags?: readonly string[];
}>;

const DEFAULT_FLEET_FILTERS: FleetFilterState = {
    region: '',
    provider: '',
    recipeId: '',
    groupId: '',
    state: '',
    window: '24h',
};

function RunnerFleetPanel({
    bootstrap,
    control,
    globalValues,
}: {
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    globalValues: CommandCenterGlobalValues;
}) {
    const [controlBaseUrl, setControlBaseUrl] = useState(() =>
        controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl)
    );
    const [controlToken, setControlToken] = useState(
        bootstrap.controlToken ?? '',
    );
    const [filters, setFilters] = useState<FleetFilterState>(
        readFleetFiltersFromUrl,
    );
    const [mapLayers, setMapLayers] = useState<FleetWorldMapLayerState>(
        readFleetWorldMapLayersFromUrl,
    );
    const [response, setResponse] = useState<
        ControlFleetReportsResponse | undefined
    >();
    const [liveSnapshot, setLiveSnapshot] = useState<
        ControlServerSnapshot | undefined
    >();
    const [liveRunId, setLiveRunId] = useState(
        control.runId ?? bootstrap.runId ?? '',
    );
    const [busy, setBusy] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [lastRefresh, setLastRefresh] = useState<number | undefined>();
    const [selectedAgentId, setSelectedAgentId] = useState('');
    const [selectedFailureId, setSelectedFailureId] = useState('');
    const [selectedReportId, setSelectedReportId] = useState('');
    const [overrideText, setOverrideText] = useState('');
    const [lastExport, setLastExport] = useState<
        ControlFleetReportBundle | undefined
    >();
    const didInitialRefresh = useRef(false);
    const overrides = useMemo(
        () => parseFleetLabelOverrides(overrideText),
        [overrideText],
    );
    const reports = useMemo(
        () =>
            applyFleetLabelOverrides(
                response?.reports ?? [],
                overrides.value,
            ),
        [overrides.value, response?.reports],
    );
    const displaySummary = useMemo(
        () => fleetDisplaySummary(reports, response),
        [reports, response],
    );
    const heatmapRuns = useMemo(() => reports.slice(0, 12), [reports]);
    const heatmapRows = useMemo(
        () => fleetHeatmapRows(reports, heatmapRuns),
        [heatmapRuns, reports],
    );
    const regionRows = useMemo(() => fleetRegionRows(reports), [reports]);
    const failureRows = useMemo(
        () => fleetFailureRows(reports),
        [reports],
    );
    const selectedFailure = failureRows.find(
        (failure) => failure.signatureId === selectedFailureId,
    ) ?? failureRows[0];
    const selectedAgent = selectedAgentId
        ? fleetAgentDetail(selectedAgentId, reports)
        : undefined;
    const regionTiming = useMemo(
        () => fleetTimingGroupsByRegion(reports).slice(0, 8),
        [reports],
    );
    const recipeTiming = useMemo(
        () => fleetTimingGroupsByRecipe(reports).slice(0, 8),
        [reports],
    );
    const missingLabelAgents = useMemo(
        () => fleetMissingLabelAgents(reports),
        [reports],
    );
    const selectedReport = reports.find(
        (report) => report.distributedRunId === selectedReportId,
    ) ?? reports[0];
    const liveGroupRef = useMemo(
        () => ({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId,
        }),
        [
            globalValues.applicationId,
            globalValues.roomId,
            globalValues.workspaceId,
        ],
    );
    const liveRunOptions = useMemo(
        () =>
            [...(liveSnapshot?.runs ?? [])].sort(
                (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
            ),
        [liveSnapshot],
    );
    const liveRun = useMemo(
        () =>
            liveRunOptions.find((run) => run.runId === liveRunId) ??
            liveRunOptions[0],
        [liveRunId, liveRunOptions],
    );
    const liveAgentRows = useMemo(
        () =>
            deriveControlAgentBoardRows({
                run: liveRun,
                group: liveGroupRef,
                distributedRuns: liveSnapshot?.distributedRuns ?? [],
                nowEpochMs: Date.now(),
            }),
        [liveGroupRef, liveRun, liveSnapshot?.distributedRuns],
    );
    const liveAgentSummary = useMemo(
        () => summarizeControlAgentBoardRows(liveAgentRows),
        [liveAgentRows],
    );
    const routeEvidence = useMemo(
        () => routeEvidenceFromControlRun(liveRun),
        [liveRun],
    );
    const worldMapModel = useMemo(
        () =>
            deriveFleetWorldMapModel({
                liveAgents: liveAgentRows,
                reports,
                routeEvidence,
            }),
        [liveAgentRows, reports, routeEvidence],
    );

    const refreshFleet = async (
        options: Readonly<{ rebuild?: boolean; quiet?: boolean }> = {},
    ): Promise<void> => {
        if (!options.quiet) {
            setBusy(options.rebuild ? 'rebuild' : 'refresh');
        }
        setError(undefined);
        try {
            const nextResponse = options.rebuild
                ? await rebuildFleetReports({
                    baseUrl: controlBaseUrl,
                    token: controlToken,
                })
                : await fetchFleetReports({
                    baseUrl: controlBaseUrl,
                    token: controlToken,
                    filter: fleetReportFilterFromUi(filters),
                });
            const nextSnapshot = await fetchControlServerSnapshot({
                baseUrl: controlBaseUrl,
                token: controlToken,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
            });
            setResponse(nextResponse);
            setLiveSnapshot(nextSnapshot);
            setLiveRunId((current) => {
                const knownRunIds = new Set(
                    nextSnapshot.runs.map((run) => run.runId),
                );
                return current && knownRunIds.has(current)
                    ? current
                    : [
                        control.runId,
                        bootstrap.runId,
                        nextSnapshot.runs[0]?.runId,
                    ].find((runId) => runId && knownRunIds.has(runId)) ?? '';
            });
            setLastRefresh(Date.now());
            setSelectedReportId((current) =>
                current ||
                nextResponse.reports[0]?.distributedRunId ||
                '',
            );
        } catch (caught) {
            setError(runnerFriendlyErrorMessage(caught));
        } finally {
            if (!options.quiet) {
                setBusy(undefined);
            }
        }
    };

    useEffect(() => {
        if (didInitialRefresh.current) {
            return;
        }
        didInitialRefresh.current = true;
        void refreshFleet({ quiet: true });
        // Initial fleet refresh uses first rendered control values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        writeFleetFiltersToUrl(filters);
    }, [filters]);

    useEffect(() => {
        writeFleetWorldMapLayersToUrl(mapLayers);
    }, [mapLayers]);

    useEffect(() => {
        if (!selectedReportId && reports[0]) {
            setSelectedReportId(reports[0].distributedRunId);
        }
    }, [reports, selectedReportId]);

    const updateFilter = <K extends keyof FleetFilterState>(
        key: K,
        value: FleetFilterState[K],
    ): void => {
        setFilters((current) => ({ ...current, [key]: value }));
    };

    const updateMapLayer = (
        layerId: FleetWorldMapLayerId,
        enabled: boolean,
    ): void => {
        setMapLayers((current) => ({
            ...current,
            [layerId]: enabled,
        }));
    };

    const selectMapRegion = (region: FleetWorldMapRegion): void => {
        if (region.region && region.region !== 'unlabeled') {
            updateFilter('region', region.region);
        }
        if (region.provider) {
            updateFilter('provider', region.provider);
        }
        if (region.latestRunId) {
            setSelectedReportId(region.latestRunId);
        }
    };

    const copyShareLink = async (): Promise<void> => {
        if (typeof window === 'undefined') {
            return;
        }
        const url = new URL(window.location.href);
        url.searchParams.set('mode', 'black-box-runner');
        url.searchParams.set('tab', 'fleet');
        writeFleetFiltersToSearchParams(url.searchParams, filters);
        writeFleetWorldMapLayersToSearchParams(url.searchParams, mapLayers);
        await navigator.clipboard?.writeText(url.toString());
    };

    const exportSelectedReport = async (): Promise<void> => {
        if (!selectedReport) {
            return;
        }
        setBusy('export');
        setError(undefined);
        try {
            const bundle = await fetchFleetReportBundle({
                baseUrl: controlBaseUrl,
                token: controlToken,
                distributedRunId: selectedReport.distributedRunId,
            });
            setLastExport(bundle);
            await navigator.clipboard?.writeText(json(bundle.files));
        } catch (caught) {
            setError(runnerFriendlyErrorMessage(caught));
        } finally {
            setBusy(undefined);
        }
    };

    return (
        <section className="panel runner-fleet-panel">
            <div className="panel-heading">
                <h2>Fleet</h2>
                <span>distributed reports</span>
            </div>
            <div className="fleet-toolbar">
                <label className="field">
                    <span>Control HTTP</span>
                    <input
                        value={controlBaseUrl}
                        onChange={(event) =>
                            setControlBaseUrl(event.target.value)
                        }
                    />
                </label>
                <label className="field compact-field">
                    <span>Token</span>
                    <input
                        type="password"
                        autoComplete="off"
                        value={controlToken}
                        onChange={(event) => setControlToken(event.target.value)}
                    />
                </label>
                <label className="field compact-field">
                    <span>Window</span>
                    <select
                        value={filters.window}
                        onChange={(event) =>
                            updateFilter(
                                'window',
                                event.target.value as FleetFilterState['window'],
                            )
                        }
                    >
                        <option value="1h">Last hour</option>
                        <option value="24h">Last 24h</option>
                        <option value="7d">Last 7d</option>
                        <option value="all">All</option>
                    </select>
                </label>
                <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void refreshFleet()}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void refreshFleet({ rebuild: true })}
                >
                    Rebuild index
                </button>
                <button type="button" onClick={() => void copyShareLink()}>
                    Copy share link
                </button>
            </div>
            <div className="fleet-filter-row">
                <label className="field">
                    <span>Region</span>
                    <input
                        placeholder="eu-north"
                        value={filters.region}
                        onChange={(event) =>
                            updateFilter('region', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Provider</span>
                    <input
                        placeholder="hetzner"
                        value={filters.provider}
                        onChange={(event) =>
                            updateFilter('provider', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Recipe</span>
                    <input
                        placeholder="recipe id"
                        value={filters.recipeId}
                        onChange={(event) =>
                            updateFilter('recipeId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Group</span>
                    <input
                        placeholder="group id"
                        value={filters.groupId}
                        onChange={(event) =>
                            updateFilter('groupId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>State</span>
                    <select
                        value={filters.state}
                        onChange={(event) =>
                            updateFilter('state', event.target.value)
                        }
                    >
                        <option value="">Any</option>
                        <option value="passed">Passed</option>
                        <option value="failed">Failed</option>
                        <option value="timed-out">Timed out</option>
                        <option value="cancelled">Cancelled</option>
                    </select>
                </label>
            </div>
            <div className="runner-distributed-freshness">
                <span>
                    {lastRefresh
                        ? `Fresh ${formatTime(lastRefresh)}`
                        : 'Not refreshed yet'}
                </span>
                <span>{busy ?? `${reports.length} reports`}</span>
            </div>
            {error && (
                <div className="workbench-error" role="status">
                    {error}
                </div>
            )}
            <section className="fleet-live-panel" aria-label="Live Fleet">
                <div className="section-heading">
                    <div>
                        <h3>Live Fleet</h3>
                        <p>
                            Connected control agents for the selected control
                            run, with targetability for the current global group.
                        </p>
                    </div>
                    <span>{liveSnapshot ? `${liveRunOptions.length} run(s)` : 'not loaded'}</span>
                </div>
                <div className="fleet-live-toolbar">
                    <label className="field">
                        <span>Control Run</span>
                        <select
                            value={liveRun?.runId ?? liveRunId}
                            onChange={(event) =>
                                setLiveRunId(event.target.value)
                            }
                        >
                            <option value="">Select run</option>
                            {liveRunOptions.map((run) => (
                                <option key={run.runId} value={run.runId}>
                                    {run.runId}
                                </option>
                            ))}
                        </select>
                    </label>
                    <span className="runner-distributed-freshness">
                        {liveRun
                            ? `Updated ${formatTime(liveRun.updatedAtEpochMs)}`
                            : 'Refresh to load control runs'}
                    </span>
                </div>
                <ControlAgentBoardPanel
                    title="Live Fleet Agents"
                    subtitle={
                        liveRun
                            ? `${liveRun.runId} scoped to ${liveGroupRef.groupId || 'missing group'}`
                            : 'No control run selected.'
                    }
                    rows={liveAgentRows}
                    summary={liveAgentSummary}
                    emptyMessage="No live control agents loaded. Refresh the control server or open browser agents."
                />
            </section>
            {missingLabelAgents.length > 0 && (
                <details className="fleet-label-warning">
                    <summary>
                        {missingLabelAgents.length} agents need region/provider
                        labels
                    </summary>
                    <p>
                        Add fleet metadata when agents register, or paste
                        temporary analysis overrides below.
                    </p>
                    <pre className="mini-json">
                        {missingLabelAgents.slice(0, 12).join('\n')}
                    </pre>
                    <textarea
                        rows={5}
                        value={overrideText}
                        onChange={(event) =>
                            setOverrideText(event.target.value)
                        }
                        placeholder={json({
                            'agent-01': {
                                region: 'eu-north',
                                provider: 'hetzner',
                            },
                        })}
                    />
                    {overrides.error && (
                        <div className="workbench-error" role="status">
                            {overrides.error}
                        </div>
                    )}
                </details>
            )}
            <div className="fleet-summary-grid">
                <Metric label="Runs" value={String(displaySummary.runs)} />
                <Metric label="Agents" value={String(displaySummary.agents)} />
                <Metric label="Regions" value={String(displaySummary.regions)} />
                <Metric
                    label="Pass rate"
                    value={formatPercent(displaySummary.passRate)}
                    tone={displaySummary.passRate >= 0.95 ? 'good' : 'warn'}
                />
                <Metric
                    label="Failure groups"
                    value={String(displaySummary.failureGroups)}
                    tone={displaySummary.failureGroups > 0 ? 'bad' : 'good'}
                />
                <Metric
                    label="P95 duration"
                    value={formatFleetDuration(displaySummary.p95DurationMs)}
                />
                <Metric
                    label="Stale agents"
                    value={String(displaySummary.stale)}
                    tone={displaySummary.stale > 0 ? 'warn' : 'good'}
                />
            </div>
            <FleetWorldMap
                model={worldMapModel}
                layers={mapLayers}
                selectedAgentId={selectedAgentId}
                onLayerChange={updateMapLayer}
                onSelectAgent={setSelectedAgentId}
                onSelectRegion={selectMapRegion}
            />
            {reports.length === 0 && !error && (
                <div className="empty-state">
                    No terminal distributed run reports found for these filters.
                    Start connected-agent recipes or rebuild the fleet index.
                </div>
            )}
            {reports.length > 0 && (
                <div className="fleet-layout">
                    <section className="fleet-subpanel fleet-heatmap-panel">
                        <div className="section-heading">
                            <h3>Agent x Run Heatmap</h3>
                            <span>{heatmapRows.length} agents</span>
                        </div>
                        <div className="fleet-heatmap" role="table">
                            <div className="fleet-heatmap-header" role="row">
                                <span>Agent</span>
                                {heatmapRuns.map((run) => (
                                    <button
                                        type="button"
                                        key={run.distributedRunId}
                                        className={run.distributedRunId === selectedReport?.distributedRunId ? 'selected' : ''}
                                        title={run.distributedRunId}
                                        onClick={() =>
                                            setSelectedReportId(
                                                run.distributedRunId,
                                            )
                                        }
                                    >
                                        {shortRunId(run.distributedRunId)}
                                    </button>
                                ))}
                            </div>
                            {heatmapRows.map((row) => (
                                <div
                                    className="fleet-heatmap-row"
                                    role="row"
                                    key={row.agent.agentId}
                                >
                                    <button
                                        type="button"
                                        className="fleet-agent-button"
                                        onClick={() =>
                                            setSelectedAgentId(row.agent.agentId)
                                        }
                                    >
                                        <strong>{row.agent.agentId}</strong>
                                        <small>
                                            {row.region} / {row.provider}
                                        </small>
                                    </button>
                                    {row.cells.map((cell, index) => (
                                        <button
                                            type="button"
                                            key={`${row.agent.agentId}-${heatmapRuns[index]?.distributedRunId ?? index}`}
                                            className={`fleet-cell ${fleetAgentStateTone(cell?.state)}`}
                                            title={fleetCellTitle(cell)}
                                            onClick={() => {
                                                if (cell) {
                                                    setSelectedAgentId(
                                                        cell.agentId,
                                                    );
                                                    const firstFailure =
                                                        cell.failureSignatureIds[0];
                                                    if (firstFailure) {
                                                        setSelectedFailureId(
                                                            firstFailure,
                                                        );
                                                    }
                                                }
                                            }}
                                            aria-label={fleetCellTitle(cell)}
                                        />
                                    ))}
                                </div>
                            ))}
                        </div>
                    </section>
                    <section className="fleet-subpanel">
                        <div className="section-heading">
                            <h3>Region Summary</h3>
                            <span>{regionRows.length}</span>
                        </div>
                        <div className="fleet-table-scroll">
                            <table className="fleet-table">
                                <thead>
                                    <tr>
                                        <th>Region</th>
                                        <th>Pass</th>
                                        <th>P95</th>
                                        <th>Failed</th>
                                        <th>Dominant failure</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {regionRows.map((row) => (
                                        <tr key={`${row.region}-${row.provider ?? 'any'}`}>
                                            <td>
                                                <strong>{row.region}</strong>
                                                <small>{row.provider ?? 'any provider'}</small>
                                            </td>
                                            <td>{formatPercent(row.passRate)}</td>
                                            <td>{formatFleetDuration(row.timing.p95Ms)}</td>
                                            <td>{row.failed}</td>
                                            <td>
                                                {shortSignatureId(
                                                    row.dominantFailureSignatureId,
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                    <section className="fleet-subpanel">
                        <div className="section-heading">
                            <h3>Failure Signatures</h3>
                            <span>{failureRows.length}</span>
                        </div>
                        <div className="fleet-failure-list">
                            {failureRows.slice(0, 12).map((failure) => (
                                <button
                                    type="button"
                                    key={failure.signatureId}
                                    className={`fleet-failure-row ${failure.signatureId === selectedFailure?.signatureId ? 'selected' : ''}`}
                                    onClick={() =>
                                        setSelectedFailureId(failure.signatureId)
                                    }
                                >
                                    <span
                                        className={`pill ${fleetFailureTone(failure.category)}`}
                                    >
                                        {failure.category}
                                    </span>
                                    <strong>{failure.title}</strong>
                                    <small>
                                        {failure.count} hits -{' '}
                                        {failure.affectedRegions.join(', ') ||
                                            'unknown region'}
                                    </small>
                                    <small>{failure.nextAction}</small>
                                </button>
                            ))}
                            {failureRows.length === 0 && (
                                <div className="empty-state">
                                    No repeated failure signatures.
                                </div>
                            )}
                        </div>
                    </section>
                    <section className="fleet-subpanel">
                        <div className="section-heading">
                            <h3>Timing Distributions</h3>
                            <span>p50 / p95</span>
                        </div>
                        <div className="fleet-timing-grid">
                            <FleetTimingGroupList
                                title="By region"
                                groups={regionTiming}
                            />
                            <FleetTimingGroupList
                                title="By recipe"
                                groups={recipeTiming}
                            />
                        </div>
                    </section>
                    <section className="fleet-subpanel fleet-report-export">
                        <div className="section-heading">
                            <h3>Shareable Run Report</h3>
                            <span>{selectedReport ? selectedReport.state : 'none'}</span>
                        </div>
                        <div className="fleet-export-row">
                            <label className="field">
                                <span>Run</span>
                                <select
                                    value={selectedReport?.distributedRunId ?? ''}
                                    onChange={(event) =>
                                        setSelectedReportId(event.target.value)
                                    }
                                >
                                    {reports.map((report) => (
                                        <option
                                            key={report.distributedRunId}
                                            value={report.distributedRunId}
                                        >
                                            {report.distributedRunId}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <button
                                type="button"
                                disabled={!selectedReport || Boolean(busy)}
                                onClick={() => void exportSelectedReport()}
                            >
                                Export report
                            </button>
                        </div>
                        {lastExport && (
                            <div className="fleet-export-files">
                                {Object.keys(lastExport.files).map((name) => (
                                    <span className="pill muted" key={name}>
                                        {name}
                                    </span>
                                ))}
                            </div>
                        )}
                    </section>
                    {selectedFailure && (
                        <section className="fleet-subpanel fleet-selected-failure">
                            <div className="section-heading">
                                <h3>Selected Failure</h3>
                                <span>{selectedFailure.count} hits</span>
                            </div>
                            <h4>{selectedFailure.title}</h4>
                            <p>{selectedFailure.likelyCause}</p>
                            <p>{selectedFailure.nextAction}</p>
                            <dl className="fleet-detail-list">
                                <div>
                                    <dt>Agents</dt>
                                    <dd>
                                        {selectedFailure.affectedAgents.join(', ') ||
                                            '-'}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Regions</dt>
                                    <dd>
                                        {selectedFailure.affectedRegions.join(', ') ||
                                            '-'}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Runs</dt>
                                    <dd>
                                        {selectedFailure.affectedRuns
                                            .map(shortRunId)
                                            .join(', ') || '-'}
                                    </dd>
                                </div>
                            </dl>
                        </section>
                    )}
                    {selectedAgent && (
                        <section className="fleet-subpanel fleet-agent-detail">
                            <div className="section-heading">
                                <h3>Agent Detail</h3>
                                <span>{selectedAgent.agent.agentId}</span>
                            </div>
                            <dl className="fleet-detail-list">
                                <div>
                                    <dt>Region</dt>
                                    <dd>
                                        {fleetRegionLabel(
                                            selectedAgent.agent.label,
                                        )}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Heartbeat</dt>
                                    <dd>
                                        {formatTime(
                                            selectedAgent.agent
                                                .lastHeartbeatAtEpochMs,
                                        )}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Reconnects</dt>
                                    <dd>{selectedAgent.reconnectCount}</dd>
                                </div>
                                <div>
                                    <dt>Diagnostics</dt>
                                    <dd>{selectedAgent.diagnosticCount}</dd>
                                </div>
                                <div>
                                    <dt>Trend</dt>
                                    <dd>
                                        {selectedAgent.passed} passed /{' '}
                                        {selectedAgent.failed} failed /{' '}
                                        {selectedAgent.missing} missing
                                    </dd>
                                </div>
                            </dl>
                            <div className="fleet-agent-run-list">
                                {selectedAgent.runs.map((entry) => (
                                    <div
                                        className="runner-analysis-row"
                                        key={`${entry.run.distributedRunId}-${entry.outcome?.agentId ?? selectedAgent.agent.agentId}`}
                                    >
                                        <strong>
                                            {shortRunId(
                                                entry.run.distributedRunId,
                                            )}
                                        </strong>
                                        <span
                                            className={`pill ${fleetAgentStateTone(entry.outcome?.state)}`}
                                        >
                                            {entry.outcome?.state ?? 'missing'}
                                        </span>
                                        <small>
                                            {entry.run.recipeIds.join(', ') ||
                                                'no recipe'}
                                        </small>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            )}
        </section>
    );
}

function FleetTimingGroupList({
    title,
    groups,
}: {
    title: string;
    groups: readonly FleetTimingGroup[];
}) {
    return (
        <section>
            <h4>{title}</h4>
            <div className="fleet-timing-list">
                {groups.map((group) => (
                    <div className="fleet-timing-row" key={group.id}>
                        <span>{group.label}</span>
                        <FleetTimingStrip timing={group.timing} />
                        <small>
                            {formatFleetDuration(group.timing.p50Ms)} /{' '}
                            {formatFleetDuration(group.timing.p95Ms)}
                        </small>
                    </div>
                ))}
                {groups.length === 0 && (
                    <div className="empty-state">No timing samples</div>
                )}
            </div>
        </section>
    );
}

function FleetTimingStrip({
    timing,
}: {
    timing: ControlFleetTimingDistribution;
}) {
    const min = timing.minMs ?? 0;
    const max = timing.maxMs ?? min + 1;
    const spread = Math.max(1, max - min);
    const position = (value: number | undefined): number => {
        if (value === undefined) {
            return 0;
        }
        return Math.max(0, Math.min(100, ((value - min) / spread) * 100));
    };
    const p50 = position(timing.p50Ms);
    const p95 = position(timing.p95Ms);
    return (
        <svg
            className="fleet-timing-strip"
            viewBox="0 0 100 16"
            role="img"
            aria-label={`timing ${timing.count} samples`}
        >
            <line x1="2" y1="8" x2="98" y2="8" />
            <rect x={Math.min(p50, p95)} y="4" width={Math.max(2, Math.abs(p95 - p50))} height="8" />
            <circle cx={p50} cy="8" r="3" />
            <circle cx={p95} cy="8" r="3" />
        </svg>
    );
}

function readFleetFiltersFromUrl(): FleetFilterState {
    if (typeof window === 'undefined') {
        return DEFAULT_FLEET_FILTERS;
    }
    const params = new URL(window.location.href).searchParams;
    return {
        region: params.get('region') ?? '',
        provider: params.get('provider') ?? '',
        recipeId: params.get('recipeId') ?? '',
        groupId: params.get('groupId') ?? '',
        state: params.get('state') ?? '',
        window: parseFleetWindow(
            params.get('window') ?? params.get('timeWindow'),
        ),
    };
}

function writeFleetFiltersToUrl(filters: FleetFilterState): void {
    if (typeof window === 'undefined') {
        return;
    }
    const url = new URL(window.location.href);
    writeFleetFiltersToSearchParams(url.searchParams, filters);
    window.history.replaceState(window.history.state, '', url.toString());
}

function writeFleetFiltersToSearchParams(
    params: URLSearchParams,
    filters: FleetFilterState,
): void {
    const entries: ReadonlyArray<[keyof FleetFilterState, string]> = [
        ['region', filters.region],
        ['provider', filters.provider],
        ['recipeId', filters.recipeId],
        ['groupId', filters.groupId],
        ['state', filters.state],
        ['window', filters.window],
    ];
    entries.forEach(([key, value]) => {
        if (value && value !== DEFAULT_FLEET_FILTERS[key]) {
            params.set(key, value);
        } else {
            params.delete(key);
        }
    });
}

function readFleetWorldMapLayersFromUrl(): FleetWorldMapLayerState {
    if (typeof window === 'undefined') {
        return DEFAULT_FLEET_WORLD_MAP_LAYER_STATE;
    }
    const params = new URL(window.location.href).searchParams;
    return parseFleetWorldMapLayers(params.get('fleetMapLayers'));
}

function writeFleetWorldMapLayersToUrl(layers: FleetWorldMapLayerState): void {
    if (typeof window === 'undefined') {
        return;
    }
    const url = new URL(window.location.href);
    writeFleetWorldMapLayersToSearchParams(url.searchParams, layers);
    window.history.replaceState(window.history.state, '', url.toString());
}

function writeFleetWorldMapLayersToSearchParams(
    params: URLSearchParams,
    layers: FleetWorldMapLayerState,
): void {
    if (fleetWorldMapLayersEqual(layers, DEFAULT_FLEET_WORLD_MAP_LAYER_STATE)) {
        params.delete('fleetMapLayers');
        return;
    }
    const enabled = FLEET_WORLD_MAP_LAYER_IDS.filter((layerId) => layers[layerId]);
    if (enabled.length === 0) {
        params.set('fleetMapLayers', 'none');
    } else {
        params.set('fleetMapLayers', enabled.join(','));
    }
}

function parseFleetWorldMapLayers(
    value: string | null,
): FleetWorldMapLayerState {
    if (!value) {
        return DEFAULT_FLEET_WORLD_MAP_LAYER_STATE;
    }
    const enabled = new Set(
        value.split(',')
            .map((entry) => entry.trim())
            .filter((entry): entry is FleetWorldMapLayerId =>
                FLEET_WORLD_MAP_LAYER_IDS.includes(entry as FleetWorldMapLayerId)
            ),
    );
    return {
        'live-agents': enabled.has('live-agents'),
        'historical-regions': enabled.has('historical-regions'),
        failures: enabled.has('failures'),
        'observed-routes': enabled.has('observed-routes'),
    };
}

function fleetWorldMapLayersEqual(
    left: FleetWorldMapLayerState,
    right: FleetWorldMapLayerState,
): boolean {
    return FLEET_WORLD_MAP_LAYER_IDS.every((layerId) => left[layerId] === right[layerId]);
}

function parseFleetWindow(
    value: string | null | undefined,
): FleetFilterState['window'] {
    return value === '1h' || value === '24h' || value === '7d' ||
            value === 'all'
        ? value
        : DEFAULT_FLEET_FILTERS.window;
}

function fleetReportFilterFromUi(
    filters: FleetFilterState,
): ControlFleetReportFilter {
    const filter: {
        region?: string;
        provider?: string;
        recipeId?: string;
        groupId?: string;
        state?: string;
        fromEpochMs?: number;
        toEpochMs?: number;
    } = {
        region: filters.region.trim() || undefined,
        provider: filters.provider.trim() || undefined,
        recipeId: filters.recipeId.trim() || undefined,
        groupId: filters.groupId.trim() || undefined,
        state: filters.state.trim() || undefined,
    };
    const now = Date.now();
    if (filters.window === '1h') {
        filter.fromEpochMs = now - 60 * 60 * 1000;
    } else if (filters.window === '24h') {
        filter.fromEpochMs = now - 24 * 60 * 60 * 1000;
    } else if (filters.window === '7d') {
        filter.fromEpochMs = now - 7 * 24 * 60 * 60 * 1000;
    }
    return filter;
}

function parseFleetLabelOverrides(text: string): Readonly<{
    value: Readonly<Record<string, FleetLabelOverride>>;
    error?: string;
}> {
    const trimmed = text.trim();
    if (!trimmed) {
        return { value: {} };
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isFleetRecord(parsed)) {
            return {
                value: {},
                error: 'Overrides must be an object keyed by agent id.',
            };
        }
        const overrides: Record<string, FleetLabelOverride> = {};
        Object.entries(parsed).forEach(([agentId, value]) => {
            if (!isFleetRecord(value)) {
                return;
            }
            const label: Record<string, string | readonly string[] | undefined> =
                {};
            [
                'region',
                'provider',
                'datacenter',
                'hostId',
                'agentPoolId',
                'deploymentId',
                'browserName',
                'browserVersion',
                'os',
            ].forEach((key) => {
                const raw = value[key];
                if (typeof raw === 'string' && raw.trim().length > 0) {
                    label[key] = raw.trim();
                }
            });
            if (Array.isArray(value.tags)) {
                label.tags = value.tags
                    .filter((tag): tag is string => typeof tag === 'string')
                    .map((tag) => tag.trim())
                    .filter(Boolean);
            }
            if (Object.keys(label).length > 0) {
                overrides[agentId] = label;
            }
        });
        return { value: overrides };
    } catch (caught) {
        return {
            value: {},
            error: caught instanceof Error ? caught.message : String(caught),
        };
    }
}

function isFleetRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyFleetLabelOverrides(
    reports: readonly ControlFleetRunReport[],
    overrides: Readonly<Record<string, FleetLabelOverride>>,
): readonly ControlFleetRunReport[] {
    if (Object.keys(overrides).length === 0) {
        return reports;
    }
    return reports.map((report) => ({
        ...report,
        agents: report.agents.map((agent) => {
            const override = overrides[agent.agentId];
            return override
                ? {
                    ...agent,
                    label: {
                        ...agent.label,
                        ...override,
                        tags: override.tags ?? agent.label.tags,
                    },
                }
                : agent;
        }),
    }));
}

function fleetDisplaySummary(
    reports: readonly ControlFleetRunReport[],
    response: ControlFleetReportsResponse | undefined,
): Readonly<{
    runs: number;
    agents: number;
    regions: number;
    passRate: number;
    failureGroups: number;
    p95DurationMs?: number;
    stale: number;
}> {
    if (reports.length === 0) {
        return {
            runs: response?.aggregate.runCount ?? 0,
            agents: response?.aggregate.agentCount ?? 0,
            regions: response?.aggregate.regionCount ?? 0,
            passRate: response?.aggregate.passRate ?? 0,
            failureGroups: response?.aggregate.failureGroupCount ?? 0,
            p95DurationMs: response?.aggregate.timing.runs.p95Ms,
            stale: response?.aggregate.staleAgentCount ?? 0,
        };
    }
    const agents = new Set<string>();
    const regions = new Set<string>();
    const staleAgents = new Set<string>();
    let passed = 0;
    let outcomes = 0;
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            agents.add(agent.agentId);
            regions.add(fleetRegionKey(agent.label));
            if (agent.stale) {
                staleAgents.add(agent.agentId);
            }
            outcomes += 1;
            if (agent.ok) {
                passed += 1;
            }
        });
    });
    return {
        runs: reports.length,
        agents: agents.size,
        regions: regions.size,
        passRate: outcomes > 0 ? passed / outcomes : 0,
        failureGroups: fleetFailureRows(reports).length,
        p95DurationMs: fleetTimingDistribution(
            reports
                .map((report) => report.runDurationMs)
                .filter((value): value is number => value !== undefined),
        ).p95Ms,
        stale: staleAgents.size,
    };
}

function fleetHeatmapRows(
    reports: readonly ControlFleetRunReport[],
    runs: readonly ControlFleetRunReport[],
): readonly FleetAgentHeatmapRow[] {
    const latestByAgent = new Map<string, ControlFleetAgentRunOutcome>();
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            if (!latestByAgent.has(agent.agentId)) {
                latestByAgent.set(agent.agentId, agent);
            }
        });
    });
    return [...latestByAgent.values()]
        .map((agent) => ({
            agent,
            region: agent.label.region ?? 'unlabeled',
            provider: agent.label.provider ?? 'unknown',
            cells: runs.map((run) =>
                run.agents.find((candidate) =>
                    candidate.agentId === agent.agentId
                )
            ),
        }))
        .sort((left, right) =>
            `${left.region}/${left.provider}/${left.agent.agentId}`
                .localeCompare(
                    `${right.region}/${right.provider}/${right.agent.agentId}`,
                )
        );
}

function fleetRegionRows(reports: readonly ControlFleetRunReport[]) {
    type MutableRegion = {
        region: string;
        provider?: string;
        agentIds: Set<string>;
        passed: number;
        failed: number;
        missing: number;
        flaky: number;
        stale: number;
        durations: number[];
        failureCounts: Map<string, number>;
    };
    const regions = new Map<string, MutableRegion>();
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            const key = fleetRegionKey(agent.label);
            const row = regions.get(key) ?? {
                region: agent.label.region ?? 'unlabeled',
                provider: agent.label.provider,
                agentIds: new Set<string>(),
                passed: 0,
                failed: 0,
                missing: 0,
                flaky: 0,
                stale: 0,
                durations: [],
                failureCounts: new Map<string, number>(),
            };
            row.agentIds.add(agent.agentId);
            if (agent.state === 'passed') {
                row.passed += 1;
            } else if (agent.state === 'failed') {
                row.failed += 1;
            } else if (agent.missing) {
                row.missing += 1;
            }
            if (agent.flaky) {
                row.flaky += 1;
            }
            if (agent.stale) {
                row.stale += 1;
            }
            if (agent.durationMs !== undefined) {
                row.durations.push(agent.durationMs);
            }
            agent.failureSignatureIds.forEach((signatureId) => {
                row.failureCounts.set(
                    signatureId,
                    (row.failureCounts.get(signatureId) ?? 0) + 1,
                );
            });
            regions.set(key, row);
        });
    });
    return [...regions.values()]
        .map((row) => {
            const total = row.passed + row.failed + row.missing;
            return {
                region: row.region,
                provider: row.provider,
                agentCount: row.agentIds.size,
                passed: row.passed,
                failed: row.failed,
                missing: row.missing,
                flaky: row.flaky,
                stale: row.stale,
                passRate: total > 0 ? row.passed / total : 0,
                timing: fleetTimingDistribution(row.durations),
                dominantFailureSignatureId: [...row.failureCounts.entries()]
                    .sort((left, right) => right[1] - left[1])[0]?.[0],
            };
        })
        .sort((left, right) =>
            right.failed - left.failed ||
            left.region.localeCompare(right.region)
        );
}

function fleetFailureRows(
    reports: readonly ControlFleetRunReport[],
): readonly ControlFleetFailureSignature[] {
    type MutableFailure = {
        -readonly [K in keyof Omit<
            ControlFleetFailureSignature,
            'affectedAgents' | 'affectedRegions' | 'affectedRuns'
        >]: ControlFleetFailureSignature[K];
    } & {
        affectedAgents: Set<string>;
        affectedRegions: Set<string>;
        affectedRuns: Set<string>;
    };
    const signatures = new Map<string, MutableFailure>();
    reports.forEach((report) => {
        report.failureSignatures.forEach((signature) => {
            const current = signatures.get(signature.signatureId) ?? {
                ...signature,
                count: 0,
                firstSeenAtEpochMs: signature.firstSeenAtEpochMs,
                lastSeenAtEpochMs: signature.lastSeenAtEpochMs,
                affectedAgents: new Set<string>(),
                affectedRegions: new Set<string>(),
                affectedRuns: new Set<string>(),
            };
            current.count += signature.count;
            current.firstSeenAtEpochMs = minDefined(
                current.firstSeenAtEpochMs,
                signature.firstSeenAtEpochMs,
            );
            current.lastSeenAtEpochMs = maxDefined(
                current.lastSeenAtEpochMs,
                signature.lastSeenAtEpochMs,
            );
            signature.affectedAgents.forEach((agentId) =>
                current.affectedAgents.add(agentId)
            );
            signature.affectedRegions.forEach((region) =>
                current.affectedRegions.add(region)
            );
            signature.affectedRuns.forEach((runId) =>
                current.affectedRuns.add(runId)
            );
            current.affectedRuns.add(report.distributedRunId);
            signatures.set(signature.signatureId, current);
        });
    });
    return [...signatures.values()]
        .map((signature) => ({
            ...signature,
            affectedAgents: [...signature.affectedAgents].sort(),
            affectedRegions: [...signature.affectedRegions].sort(),
            affectedRuns: [...signature.affectedRuns].sort(),
        }))
        .sort((left, right) =>
            right.count - left.count ||
            (right.lastSeenAtEpochMs ?? 0) - (left.lastSeenAtEpochMs ?? 0)
        );
}

function fleetTimingGroupsByRegion(
    reports: readonly ControlFleetRunReport[],
): readonly FleetTimingGroup[] {
    const durations = new Map<string, number[]>();
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            if (agent.durationMs === undefined) {
                return;
            }
            const key = fleetRegionKey(agent.label);
            const list = durations.get(key) ?? [];
            list.push(agent.durationMs);
            durations.set(key, list);
        });
    });
    return [...durations.entries()]
        .map(([id, values]) => ({
            id,
            label: id,
            timing: fleetTimingDistribution(values),
        }))
        .sort((left, right) =>
            (right.timing.p95Ms ?? 0) - (left.timing.p95Ms ?? 0)
        );
}

function fleetTimingGroupsByRecipe(
    reports: readonly ControlFleetRunReport[],
): readonly FleetTimingGroup[] {
    const durations = new Map<string, number[]>();
    reports.forEach((report) => {
        if (report.runDurationMs === undefined) {
            return;
        }
        report.recipeIds.forEach((recipeId) => {
            const list = durations.get(recipeId) ?? [];
            list.push(report.runDurationMs as number);
            durations.set(recipeId, list);
        });
    });
    return [...durations.entries()]
        .map(([id, values]) => ({
            id,
            label: id,
            timing: fleetTimingDistribution(values),
        }))
        .sort((left, right) =>
            (right.timing.p95Ms ?? 0) - (left.timing.p95Ms ?? 0)
        );
}

function fleetTimingDistribution(
    values: readonly number[],
): ControlFleetTimingDistribution {
    const sorted = values
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
    if (sorted.length === 0) {
        return { count: 0 };
    }
    return {
        count: sorted.length,
        minMs: sorted[0],
        p50Ms: percentile(sorted, 0.5),
        p90Ms: percentile(sorted, 0.9),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted[sorted.length - 1],
    };
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
    const index = Math.max(
        0,
        Math.min(
            sortedValues.length - 1,
            Math.ceil(sortedValues.length * percentileValue) - 1,
        ),
    );
    return sortedValues[index];
}

function fleetMissingLabelAgents(
    reports: readonly ControlFleetRunReport[],
): readonly string[] {
    const missing = new Set<string>();
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            if (!agent.label.region || !agent.label.provider) {
                missing.add(agent.agentId);
            }
        });
    });
    return [...missing].sort();
}

function fleetAgentDetail(
    agentId: string,
    reports: readonly ControlFleetRunReport[],
) {
    const entries = reports
        .map((run) => ({
            run,
            outcome: run.agents.find((agent) => agent.agentId === agentId),
        }))
        .filter((entry) => entry.outcome !== undefined);
    const agent = entries[0]?.outcome;
    if (!agent) {
        return undefined;
    }
    return {
        agent,
        runs: entries.slice(0, 12),
        passed: entries.filter((entry) => entry.outcome?.state === 'passed')
            .length,
        failed: entries.filter((entry) => entry.outcome?.state === 'failed')
            .length,
        missing: entries.filter((entry) => entry.outcome?.missing).length,
        reconnectCount: Math.max(
            0,
            ...entries.map((entry) => entry.outcome?.reconnectCount ?? 0),
        ),
        diagnosticCount: entries.reduce(
            (sum, entry) => sum + (entry.outcome?.diagnosticCount ?? 0),
            0,
        ),
    };
}

function fleetRegionKey(
    label: ControlFleetAgentRunOutcome['label'],
): string {
    return `${label.region ?? 'unlabeled'} / ${label.provider ?? 'unknown'}`;
}

function fleetRegionLabel(
    label: ControlFleetAgentRunOutcome['label'],
): string {
    const region = label.region ?? 'unlabeled';
    const provider = label.provider ?? 'unknown provider';
    return `${region} / ${provider}`;
}

function fleetAgentStateTone(
    state: ControlFleetAgentRunOutcome['state'] | undefined,
): string {
    if (state === 'passed') {
        return 'good';
    }
    if (state === 'failed') {
        return 'bad';
    }
    if (state === 'missing' || state === 'timed-out') {
        return 'warn';
    }
    if (state === 'running') {
        return 'active';
    }
    return 'muted';
}

function fleetFailureTone(
    category: ControlFleetFailureSignature['category'],
): string {
    if (category === 'command' || category === 'runtime') {
        return 'bad';
    }
    if (category === 'diagnostic' || category === 'barrier') {
        return 'warn';
    }
    if (category === 'readiness' || category === 'targeting') {
        return 'active';
    }
    return 'muted';
}

function fleetCellTitle(
    cell: ControlFleetAgentRunOutcome | undefined,
): string {
    if (!cell) {
        return 'No result for this agent and run';
    }
    return `${cell.agentId}: ${cell.state}, ${cell.failedCommandCount} failed commands`;
}

function shortSignatureId(value: string | undefined): string {
    if (!value) {
        return '-';
    }
    return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function minDefined(
    left: number | undefined,
    right: number | undefined,
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.min(left, right);
}

function maxDefined(
    left: number | undefined,
    right: number | undefined,
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.max(left, right);
}

function RunnerAdvancedPanel({
    state,
    bootstrap,
    control,
    authSession,
    globalValues,
    globalValuesEdited,
    busy,
    runState,
    loadedFixtureId,
    lastError,
    selectedCommandId,
    queueRows,
    initialSurface = 'workbench',
    onSelectCommand,
    onGlobalValueChange,
    onSurfaceChange,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    globalValuesEdited: boolean;
    busy: boolean;
    runState: string;
    loadedFixtureId?: string;
    lastError?: string;
    selectedCommandId?: string;
    queueRows: readonly CommandQueueRow[];
    initialSurface?: RunnerAdvancedSurfaceId;
    onSelectCommand(commandId: string | undefined): void;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
    onSurfaceChange(surface: RunnerAdvancedSurfaceId): void;
}) {
    const [surface, setSurface] = useState<RunnerAdvancedSurfaceId>(initialSurface);

    useEffect(() => {
        setSurface(initialSurface);
    }, [initialSurface]);

    const selectSurface = (nextSurface: RunnerAdvancedSurfaceId): void => {
        setSurface(nextSurface);
        onSurfaceChange(nextSurface);
    };

    return (
        <section className="panel runner-advanced-panel">
            <div className="panel-heading">
                <h2>Advanced</h2>
                <span>raw controls</span>
            </div>
            <div className="runner-advanced-switch">
                {[
                    ['workbench', 'Local Workbench'],
                    ['distributed', 'Distributed Recipes'],
                    ['run-manager', 'Run Manager'],
                    ['manual', 'Manual Rallar'],
                    ['shared-test', 'Shared Test'],
                ].map(([id, label]) => (
                    <button
                        type="button"
                        key={id}
                        className={surface === id ? 'selected' : ''}
                        onClick={() => selectSurface(id as RunnerAdvancedSurfaceId)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="runner-advanced-content">
                <div
                    id="panel-local-workbench"
                    className="workspace-grid tab-workspace workbench-tab-grid"
                    hidden={surface !== 'workbench'}
                >
                    <WorkbenchPanel
                        busy={busy}
                        runState={runState}
                        loadedFixtureId={loadedFixtureId}
                        lastError={lastError}
                    />
                    <ControlPanel state={state} control={control} />
                    <BootstrapPanel bootstrap={bootstrap} />
                    <ConfigurationPanel state={state} />
                    <CommandQueuePanel
                        rows={queueRows}
                        selectedCommandId={selectedCommandId}
                        onSelect={onSelectCommand}
                    />
                    <ReportPanel
                        state={state}
                        authSession={authSession}
                    />
                </div>
                {surface === 'distributed' && (
                    <div
                        id="panel-distributed-recipes"
                        className="workspace-grid tab-workspace distributed-recipes-tab-grid"
                    >
                        <DistributedRecipesPanel
                            state={state}
                            bootstrap={bootstrap}
                            control={control}
                            globalValues={globalValues}
                        />
                    </div>
                )}
                {surface === 'run-manager' && (
                    <div
                        id="panel-run-manager"
                        className="workspace-grid tab-workspace run-manager-tab-grid"
                    >
                        <RunManagerPanel
                            state={state}
                            bootstrap={bootstrap}
                            control={control}
                        />
                    </div>
                )}
                <div
                    id="panel-manual-rallar"
                    className="workspace-grid tab-workspace manual-tab-grid"
                    hidden={surface !== 'manual'}
                >
                    <ManualRallarWorkbenchPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        globalValuesEdited={globalValuesEdited}
                        busy={busy}
                        onSelectCommand={onSelectCommand}
                        onGlobalValueChange={onGlobalValueChange}
                    />
                    <ReceivedDataInboxPanel
                        state={state}
                        onSelectCommand={onSelectCommand}
                    />
                    <CommandHistoryPanel
                        history={selectRallarBlackBoxCommandHistory(state)}
                        selectedCommandId={selectedCommandId}
                        onSelect={onSelectCommand}
                    />
                </div>
                {surface === 'shared-test' && (
                    <div
                        id="panel-shared-test"
                        className="workspace-grid tab-workspace shared-test-tab-grid"
                    >
                        <SharedTestPanel />
                    </div>
                )}
            </div>
        </section>
    );
}

function WorkbenchPanel({
    busy,
    runState,
    loadedFixtureId,
    lastError,
}: {
    busy: boolean;
    runState: string;
    loadedFixtureId?: string;
    lastError?: string;
}) {
    const [fixtureId, setFixtureId] = useState(
        loadedFixtureId ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0].fixtureId,
    );
    const [recipeText, setRecipeText] = useState(() =>
        recipeFixtureText(fixtureId),
    );
    const [commandText, setCommandText] = useState(() =>
        JSON.stringify(RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE, null, 2),
    );
    const [localError, setLocalError] = useState<string | undefined>();
    const recipeValidation = useMemo(
        () => validateSchemaAuthoringText('recipe', recipeText),
        [recipeText],
    );
    const commandValidation = useMemo(
        () => validateSchemaAuthoringText('command', commandText),
        [commandText],
    );

    const runAction = async (action: () => Promise<void>): Promise<void> => {
        setLocalError(undefined);
        try {
            await action();
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const selectFixture = (nextFixtureId: string): void => {
        setFixtureId(nextFixtureId);
        setRecipeText(recipeFixtureText(nextFixtureId));
        setLocalError(undefined);
    };

    const fixture =
        RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(
            (entry) => entry.fixtureId === fixtureId,
        ) ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0];

    return (
        <section className="panel workbench-panel">
            <div className="panel-heading">
                <h2>Local Workbench</h2>
                <span className={`pill ${statusTone(runState)}`}>
                    {runState}
                </span>
            </div>
            <CollapsiblePanelSection
                title="Workbench Inputs"
                meta={fixture.label}
            >
                <div className="workbench-controls">
                    <label className="field">
                        <span>Fixture</span>
                        <select
                            value={fixtureId}
                            onChange={(event) =>
                                selectFixture(event.target.value)
                            }
                            disabled={busy}
                        >
                            {RALLAR_BLACK_BOX_RECIPE_FIXTURES.map((entry) => (
                                <option
                                    key={entry.fixtureId}
                                    value={entry.fixtureId}
                                >
                                    {entry.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className="fixture-description">{fixture.description}</p>
                    <div className="workbench-actions">
                        <button
                            type="button"
                            onClick={() =>
                                runAction(() =>
                                    rallarBlackBoxRuntimeStore.loadRecipeFromJson(
                                        recipeText,
                                        fixtureId,
                                    ),
                                )
                            }
                            disabled={busy || !recipeValidation.ok}
                        >
                            Load
                        </button>
                        <button
                            type="button"
                            onClick={() =>
                                runAction(() =>
                                    rallarBlackBoxRuntimeStore.runLoadedRecipe(),
                                )
                            }
                            disabled={busy}
                        >
                            Run
                        </button>
                        <button
                            type="button"
                            onClick={() =>
                                runAction(() =>
                                    rallarBlackBoxRuntimeStore.cancelRecipe(),
                                )
                            }
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() =>
                                runAction(() =>
                                    rallarBlackBoxRuntimeStore.resetWorkbench(),
                                )
                            }
                            disabled={busy}
                        >
                            Reset
                        </button>
                    </div>
                </div>
                <label className="json-editor">
                    <span>Recipe JSON</span>
                    <textarea
                        value={recipeText}
                        onChange={(event) => setRecipeText(event.target.value)}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
                <SchemaAuthoringPanel validation={recipeValidation} />
                <div className="manual-command">
                    <label className="json-editor">
                        <span>Manual Command JSON</span>
                        <textarea
                            value={commandText}
                            onChange={(event) =>
                                setCommandText(event.target.value)
                            }
                            spellCheck={false}
                            disabled={busy}
                        />
                    </label>
                    <SchemaAuthoringPanel validation={commandValidation} />
                    <CommandExamplePicker
                        onInsert={setCommandText}
                        onCopy={(text) =>
                            void navigator.clipboard?.writeText(text)
                        }
                    />
                    <button
                        type="button"
                        onClick={() =>
                            runAction(() =>
                                rallarBlackBoxRuntimeStore.executeCommandFromJson(
                                    commandText,
                                ),
                            )
                        }
                        disabled={busy || !commandValidation.ok}
                    >
                        Execute Command
                    </button>
                </div>
            </CollapsiblePanelSection>
            {(localError || lastError) && (
                <div className="workbench-error" role="status">
                    {localError ?? lastError}
                </div>
            )}
        </section>
    );
}

function ManualRallarWorkbenchPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    globalValuesEdited,
    busy,
    onSelectCommand,
    onGlobalValueChange,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    globalValuesEdited?: boolean;
    busy: boolean;
    onSelectCommand(commandId: string): void;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
}) {
    const defaultValues = useMemo(
        () =>
            manualValuesFromState(state, bootstrap, authSession, globalValues),
        [
            authSession,
            bootstrap,
            globalValues?.apiBaseUrl,
            globalValues?.applicationId,
            globalValues?.clientId,
            globalValues?.roomId,
            globalValues?.sessionId,
            globalValues?.workspaceId,
            state.currentConfig,
        ],
    );
    const defaultDraft = useMemo<ManualWorkbenchDraft>(
        () => ({
            values: defaultValues,
            payloadPresetId: MANUAL_PAYLOAD_PRESETS[0].presetId,
            payloadText: JSON.stringify(
                MANUAL_PAYLOAD_PRESETS[0].payload,
                null,
                2,
            ),
        }),
        [defaultValues],
    );
    const [initialDraft] = useState(() => {
        const stored = readManualWorkbenchDraft(
            browserUiStorage(),
            defaultDraft,
        );
        return {
            draft: stored ?? defaultDraft,
            restored: Boolean(stored),
        };
    });
    const [values, setValues] = useState<ManualWorkbenchValues>(
        () => initialDraft.draft.values,
    );
    const [valuesEdited, setValuesEdited] = useState(initialDraft.restored);
    const [payloadPresetId, setPayloadPresetId] = useState(
        initialDraft.draft.payloadPresetId,
    );
    const [payloadText, setPayloadText] = useState(
        () => initialDraft.draft.payloadText,
    );
    const [sequence, setSequence] = useState(1);
    const [history, setHistory] = useState<readonly ManualActionHistoryEntry[]>(
        [],
    );
    const [localError, setLocalError] = useState<string | undefined>();
    const [recipeVisible, setRecipeVisible] = useState(false);
    const events = selectRallarBlackBoxEvents(state);
    const payloadResult = useMemo(
        () => parseManualPayload(payloadText),
        [payloadText],
    );
    const previewCommands = useMemo(
        () =>
            payloadResult.ok
                ? buildManualWorkbenchCommands(
                      'send',
                      values,
                      payloadResult.value,
                      sequence,
                  )
                : [],
        [payloadResult, sequence, values],
    );
    const recipeText = useMemo(() => manualRecipeSnippet(history), [history]);
    const negativeRecipeText = useMemo(
        () =>
            payloadResult.ok
                ? manualRtcNegativeRecipeSnippet(values, payloadResult.value)
                : payloadResult.error,
        [payloadResult, values],
    );
    const previewRecipeValidation = useMemo(
        () =>
            payloadResult.ok
                ? validateSchemaAuthoringValue('recipe', {
                      recipeId: 'manual-rallar-command-preview',
                      commands: previewCommands,
                  })
                : undefined,
        [payloadResult.ok, previewCommands],
    );
    const manualRecipeValidation = useMemo(
        () =>
            recipeText.trim().length > 0
                ? validateSchemaAuthoringText('recipe', recipeText)
                : undefined,
        [recipeText],
    );
    const negativeRecipeValidation = useMemo(
        () =>
            payloadResult.ok
                ? validateSchemaAuthoringText('recipe', negativeRecipeText)
                : undefined,
        [negativeRecipeText, payloadResult.ok],
    );

    useEffect(() => {
        if (!valuesEdited) {
            setValues(defaultValues);
        }
    }, [defaultValues, valuesEdited]);

    useEffect(() => {
        if (!authSession) {
            return;
        }

        setValues((current) => {
            const clientId =
                globalValues?.clientId ||
                authSession.clientId ||
                authSession.username;
            const sessionId = globalValues?.sessionId || authSession.sessionId;
            const nextValues = {
                ...current,
                actor: clientId,
                sessionId,
                rallarUsername: authSession.username,
                rallarRestoreSession: true,
            };

            return current.actor === nextValues.actor &&
                current.sessionId === nextValues.sessionId &&
                current.rallarUsername === nextValues.rallarUsername &&
                current.rallarRestoreSession === nextValues.rallarRestoreSession
                ? current
                : nextValues;
        });
    }, [
        authSession?.clientId,
        authSession?.sessionId,
        authSession?.username,
        globalValues?.clientId,
        globalValues?.sessionId,
    ]);

    useEffect(() => {
        if (!globalValues || !globalValuesEdited) {
            return;
        }

        setValues((current) => {
            const nextValues = {
                ...current,
                apiBaseUrl: globalValues.apiBaseUrl,
                applicationId: globalValues.applicationId,
                workspaceId: globalValues.workspaceId,
                actor: globalValues.clientId,
                sessionId: globalValues.sessionId,
                groupId: globalValues.roomId,
            };

            return current.apiBaseUrl === nextValues.apiBaseUrl &&
                current.applicationId === nextValues.applicationId &&
                current.workspaceId === nextValues.workspaceId &&
                current.actor === nextValues.actor &&
                current.sessionId === nextValues.sessionId &&
                current.groupId === nextValues.groupId
                ? current
                : nextValues;
        });
    }, [
        globalValues?.apiBaseUrl,
        globalValues?.applicationId,
        globalValues?.clientId,
        globalValues?.roomId,
        globalValues?.sessionId,
        globalValues?.workspaceId,
        globalValuesEdited,
    ]);

    useEffect(() => {
        writeManualWorkbenchDraft(
            browserUiStorage(),
            {
                values,
                payloadPresetId,
                payloadText,
            },
            uiSecretValues(state, authSession, [values.rallarPassword]),
        );
    }, [
        authSession?.accessToken,
        payloadPresetId,
        payloadText,
        state.currentConfig?.redaction,
        values,
    ]);

    const updateValue = <K extends keyof ManualWorkbenchValues>(
        key: K,
        value: ManualWorkbenchValues[K],
    ): void => {
        setValuesEdited(true);
        setValues((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const selectPreset = (presetId: string): void => {
        setPayloadPresetId(presetId);
        const preset = MANUAL_PAYLOAD_PRESETS.find(
            (entry) => entry.presetId === presetId,
        );
        if (preset) {
            setPayloadText(JSON.stringify(preset.payload, null, 2));
        }
    };

    const runManualCommandSet = async (
        label: string,
        commands: readonly RallarBlackBoxTestCommand[],
        startSequence: number,
    ): Promise<void> => {
        const entry: ManualActionHistoryEntry = {
            actionId: `manual-action-${startSequence}`,
            label,
            commandIds: commands.map(
                (command) => command.commandId ?? command.kind,
            ),
            commands: redactRallarBlackBoxValue(
                commands,
                uiRedactionOptions(state, authSession, [values.rallarPassword]),
            ),
            atEpochMs: Date.now(),
        };

        setSequence((current) => current + commands.length + 1);
        setHistory((current) => [...current, entry].slice(-12));
        onSelectCommand(entry.commandIds.at(-1) ?? entry.commandIds[0]);

        try {
            await rallarBlackBoxRuntimeStore.executeManualCommands(
                commands,
                label,
            );
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const runManualAction = async (
        action: ManualWorkbenchAction,
    ): Promise<void> => {
        setLocalError(undefined);
        if (action === 'send' && !payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }
        const selectedGroupId = values.groupId.trim();
        if (
            selectedGroupId &&
            onGlobalValueChange &&
            ['configure', 'join', 'connect', 'send'].includes(action) &&
            globalValues?.roomId !== selectedGroupId
        ) {
            onGlobalValueChange('roomId', selectedGroupId);
        }

        const label = actionLabel(action);
        const startSequence = sequence;
        const commands = buildManualWorkbenchCommands(
            action,
            values,
            payloadResult.ok ? payloadResult.value : null,
            startSequence,
        );
        await runManualCommandSet(label, commands, startSequence);
    };

    const runRtcMatrix = async (
        transport: Extract<
            ManualWorkbenchTransport,
            'realtime' | 'messages.rtc'
        >,
    ): Promise<void> => {
        setLocalError(undefined);
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }

        const label = `RTC ${transport} delivery matrix`;
        const startSequence = sequence;
        const commands = manualRtcDeliveryMatrixCommands(
            values,
            payloadResult.value,
            startSequence,
            transport,
        );
        await runManualCommandSet(label, commands, startSequence);
    };

    const runRtcNackProbe = async (): Promise<void> => {
        setLocalError(undefined);
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }

        const startSequence = sequence;
        await runManualCommandSet(
            'RTC not-yet-in-sync probe',
            manualRtcNackProbeCommands(
                values,
                payloadResult.value,
                startSequence,
            ),
            startSequence,
        );
    };

    const copyRecipeSnippet = (): void => {
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(recipeText);
        }
    };

    const copyRtcMatrixRecipe = (): void => {
        if (!payloadResult.ok || !navigator.clipboard) {
            return;
        }

        const realtime = manualRtcDeliveryMatrixCommands(
            values,
            payloadResult.value,
            1,
            'realtime',
        );
        const messages = manualRtcDeliveryMatrixCommands(
            values,
            payloadResult.value,
            realtime.length + 2,
            'messages.rtc',
        );
        void navigator.clipboard.writeText(
            JSON.stringify(
                {
                    recipeId: 'manual-rtc-delivery-matrix',
                    name: 'Manual RTC delivery matrix',
                    description:
                        'Direct, multicast, and broadcast delivery over realtime and messages.rtc.',
                    continueOnFailure: false,
                    commands: [...realtime, ...messages],
                },
                null,
                2,
            ),
        );
    };

    const copyNegativeRecipe = (): void => {
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(negativeRecipeText);
        }
    };

    return (
        <section className="panel manual-rallar-panel">
            <div className="panel-heading">
                <h2>Manual Rallar</h2>
                <span className={`pill ${payloadResult.ok ? 'good' : 'bad'}`}>
                    {payloadResult.ok ? 'json valid' : 'json invalid'}
                </span>
            </div>
            <CollapsiblePanelSection
                title="Manual Rallar Inputs"
                meta={`${values.groupId || '-'} / ${values.transport}`}
            >
                <div className="manual-rallar-grid">
                    <label className="field">
                        <span>Environment</span>
                        <input
                            value={values.environment}
                            onChange={(event) =>
                                updateValue('environment', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={values.apiBaseUrl}
                            onChange={(event) =>
                                updateValue('apiBaseUrl', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Application</span>
                        <input
                            value={values.applicationId}
                            onChange={(event) =>
                                updateValue('applicationId', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Workspace</span>
                        <input
                            value={values.workspaceId}
                            onChange={(event) =>
                                updateValue('workspaceId', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Actor</span>
                        <input
                            value={values.actor}
                            onChange={(event) =>
                                updateValue('actor', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Session</span>
                        <input
                            value={values.sessionId}
                            onChange={(event) =>
                                updateValue('sessionId', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Group</span>
                        <input
                            value={values.groupId}
                            onChange={(event) =>
                                updateValue('groupId', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Scope JSON</span>
                        <input
                            value={values.scopeText}
                            onChange={(event) =>
                                updateValue('scopeText', event.target.value)
                            }
                            disabled={busy}
                            placeholder='{"workspaceId":"default"}'
                        />
                    </label>
                    <label className="field">
                        <span>Room Ref JSON</span>
                        <input
                            value={values.roomRefText}
                            onChange={(event) =>
                                updateValue('roomRefText', event.target.value)
                            }
                            disabled={busy}
                            placeholder='{"groupId":"bb-group"}'
                        />
                    </label>
                    <label className="field">
                        <span>Min Snapshot</span>
                        <input
                            type="number"
                            min={0}
                            value={values.minSnapshotVersion}
                            onChange={(event) =>
                                updateValue(
                                    'minSnapshotVersion',
                                    Number(event.target.value),
                                )
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Connection</span>
                        <input
                            value={values.connection}
                            onChange={(event) =>
                                updateValue('connection', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Transport</span>
                        <select
                            value={values.transport}
                            onChange={(event) =>
                                updateValue(
                                    'transport',
                                    event.target
                                        .value as ManualWorkbenchTransport,
                                )
                            }
                            disabled={busy}
                        >
                            <option value="realtime">RTC realtime</option>
                            <option value="messages.rtc">RTC messages</option>
                            <option value="ws">WebSocket</option>
                        </select>
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
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Target Client</span>
                        <input
                            value={values.targetClient}
                            onChange={(event) =>
                                updateValue('targetClient', event.target.value)
                            }
                            disabled={busy || values.deliveryMode !== 'direct'}
                        />
                    </label>
                    <label className="field">
                        <span>Multicast Clients</span>
                        <input
                            value={values.multicastClients}
                            onChange={(event) =>
                                updateValue(
                                    'multicastClients',
                                    event.target.value,
                                )
                            }
                            disabled={
                                busy || values.deliveryMode !== 'multicast'
                            }
                        />
                    </label>
                    <label className="field">
                        <span>WS URL</span>
                        <input
                            value={values.wsUrl}
                            onChange={(event) =>
                                updateValue('wsUrl', event.target.value)
                            }
                            disabled={busy || values.transport !== 'ws'}
                        />
                    </label>
                    <label className="field">
                        <span>Topic</span>
                        <input
                            value={values.topic}
                            onChange={(event) =>
                                updateValue('topic', event.target.value)
                            }
                            disabled={busy}
                        />
                    </label>
                    <label className="field">
                        <span>Type ID</span>
                        <input
                            value={values.typeId}
                            onChange={(event) =>
                                updateValue('typeId', event.target.value)
                            }
                            disabled={
                                busy || values.transport !== 'messages.rtc'
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
                            disabled={
                                busy || values.transport !== 'messages.rtc'
                            }
                        />
                    </label>
                </div>
                <div
                    className="segmented delivery-toggle"
                    role="group"
                    aria-label="Delivery mode"
                >
                    {(['direct', 'multicast', 'broadcast'] as const).map(
                        (mode) => (
                            <button
                                key={mode}
                                type="button"
                                className={
                                    values.deliveryMode === mode
                                        ? 'selected'
                                        : ''
                                }
                                onClick={() =>
                                    updateValue(
                                        'deliveryMode',
                                        mode as ManualDeliveryMode,
                                    )
                                }
                                disabled={busy}
                            >
                                {mode}
                            </button>
                        ),
                    )}
                </div>
            </CollapsiblePanelSection>
            <CollapsiblePanelSection
                title="Manual Payload"
                meta={payloadResult.ok ? 'json valid' : 'json invalid'}
            >
                <div className="payload-toolbar">
                    <label className="field compact-field">
                        <span>Payload Preset</span>
                        <select
                            value={payloadPresetId}
                            onChange={(event) =>
                                selectPreset(event.target.value)
                            }
                            disabled={busy}
                        >
                            <option value="custom">Custom</option>
                            {MANUAL_PAYLOAD_PRESETS.map((preset) => (
                                <option
                                    key={preset.presetId}
                                    value={preset.presetId}
                                >
                                    {preset.label}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                <label className="json-editor manual-payload-editor">
                    <span>Payload JSON</span>
                    <textarea
                        value={payloadText}
                        onChange={(event) => {
                            setPayloadPresetId('custom');
                            setPayloadText(event.target.value);
                        }}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
            </CollapsiblePanelSection>
            <div className="manual-preview">
                <div className="section-heading">
                    <h3>Command Preview</h3>
                    <span>{previewCommands.length} command</span>
                </div>
                <pre className="json-block">
                    {payloadResult.ok
                        ? redactedJson(
                              previewCommands.length === 1
                                  ? previewCommands[0]
                                  : previewCommands,
                              state,
                              authSession,
                              [values.rallarPassword],
                          )
                        : payloadResult.error}
                </pre>
                {previewRecipeValidation && (
                    <SchemaAuthoringPanel
                        validation={previewRecipeValidation}
                        compact
                    />
                )}
            </div>
            <div className="manual-action-grid">
                {(
                    [
                        'configure',
                        'join',
                        'connect',
                        'send',
                        'health',
                        'close',
                        'reset',
                    ] as const
                ).map((action) => (
                    <button
                        key={action}
                        type="button"
                        disabled={
                            busy || (action === 'send' && !payloadResult.ok)
                        }
                        onClick={() => void runManualAction(action)}
                    >
                        {actionLabel(action)}
                    </button>
                ))}
            </div>
            <div className="manual-matrix-card">
                <div className="section-heading">
                    <h3>RTC Delivery Matrix</h3>
                    <span>direct, multicast, broadcast</span>
                </div>
                <div className="manual-action-grid">
                    <button
                        type="button"
                        disabled={busy || !payloadResult.ok}
                        onClick={() => void runRtcMatrix('realtime')}
                    >
                        Run Realtime Matrix
                    </button>
                    <button
                        type="button"
                        disabled={busy || !payloadResult.ok}
                        onClick={() => void runRtcMatrix('messages.rtc')}
                    >
                        Run Messages Matrix
                    </button>
                    <button
                        type="button"
                        disabled={busy || !payloadResult.ok}
                        onClick={() => void runRtcNackProbe()}
                    >
                        NACK Probe
                    </button>
                    <button
                        type="button"
                        onClick={copyRtcMatrixRecipe}
                        disabled={!payloadResult.ok}
                    >
                        Copy Matrix Recipe
                    </button>
                    <button
                        type="button"
                        onClick={copyNegativeRecipe}
                        disabled={!payloadResult.ok}
                    >
                        Copy Negative Recipe
                    </button>
                </div>
                {negativeRecipeValidation && (
                    <SchemaAuthoringPanel
                        validation={negativeRecipeValidation}
                        compact
                    />
                )}
            </div>
            <div className="manual-history">
                <div className="section-heading">
                    <h3>Manual Actions</h3>
                    <div className="heading-actions">
                        <button
                            type="button"
                            onClick={() =>
                                setRecipeVisible((current) => !current)
                            }
                        >
                            {recipeVisible ? 'Hide Recipe' : 'Show Recipe'}
                        </button>
                        <button
                            type="button"
                            onClick={copyRecipeSnippet}
                            disabled={history.length === 0}
                        >
                            Copy Recipe
                        </button>
                    </div>
                </div>
                <div className="manual-action-list">
                    {history.length === 0 && (
                        <div className="empty-state">No manual actions</div>
                    )}
                    {history
                        .slice()
                        .reverse()
                        .map((entry) => {
                            const relatedEvents = events.filter(
                                (event) =>
                                    event.commandId &&
                                    entry.commandIds.includes(event.commandId),
                            ).length;
                            return (
                                <article
                                    className="manual-action-row"
                                    key={entry.actionId}
                                >
                                    <div>
                                        <strong>{entry.label}</strong>
                                        <small>
                                            {formatTime(entry.atEpochMs)} -{' '}
                                            {relatedEvents} events
                                        </small>
                                    </div>
                                    <div className="manual-command-links">
                                        {entry.commandIds.map((commandId) => (
                                            <button
                                                type="button"
                                                key={commandId}
                                                onClick={() =>
                                                    onSelectCommand(commandId)
                                                }
                                            >
                                                {commandId}
                                            </button>
                                        ))}
                                    </div>
                                </article>
                            );
                        })}
                </div>
                {recipeVisible && (
                    <>
                        <textarea
                            className="report-output manual-recipe-output"
                            value={recipeText}
                            readOnly
                            spellCheck={false}
                        />
                        {manualRecipeValidation && (
                            <SchemaAuthoringPanel
                                validation={manualRecipeValidation}
                                compact
                            />
                        )}
                    </>
                )}
            </div>
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession, [
                            values.rallarPassword,
                        ]),
                    )}
                </div>
            )}
        </section>
    );
}

function ReceivedDataInboxPanel({
    state,
    onSelectCommand,
}: {
    state: RallarBlackBoxTestState;
    onSelectCommand(commandId: string): void;
}) {
    const received = useMemo(
        () => deriveManualReceivedMessages(selectRallarBlackBoxEvents(state)),
        [state],
    );

    return (
        <section className="panel received-inbox-panel">
            <div className="panel-heading">
                <h2>Received Data</h2>
                <span>{received.length} messages</span>
            </div>
            <div className="received-list">
                {received.length === 0 && (
                    <div className="empty-state">No received data</div>
                )}
                {received
                    .slice(-24)
                    .reverse()
                    .map((message) => (
                        <article className="received-row" key={message.eventId}>
                            <div className="received-topline">
                                <strong>{message.topic}</strong>
                                <time>{formatTime(message.atEpochMs)}</time>
                            </div>
                            <div className="event-meta">
                                <span>{message.connection}</span>
                                <span>{message.transport}</span>
                                <span>{message.sender}</span>
                                {message.commandId && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            onSelectCommand(message.commandId!)
                                        }
                                    >
                                        {message.commandId}
                                    </button>
                                )}
                            </div>
                            <pre className="mini-json">
                                {redactedJson(message.payload, state)}
                            </pre>
                        </article>
                    ))}
            </div>
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

function ControlPanel({
    state,
    control,
}: {
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const [url, setUrl] = useState(control.url ?? '');
    const [runId, setRunId] = useState(control.runId ?? config?.runId ?? '');
    const [agentId, setAgentId] = useState(
        control.agentId ?? config?.agentId ?? '',
    );
    const connected = control.state === 'registered';
    const connecting =
        control.state === 'connecting' || control.state === 'reconnecting';

    useEffect(() => {
        if (!runId && config?.runId) setRunId(config.runId);
        if (!agentId && config?.agentId) setAgentId(config.agentId);
    }, [agentId, config?.agentId, config?.runId, runId]);

    useEffect(() => {
        if (control.url && url.length === 0) {
            setUrl(control.url);
        }
    }, [control.url, url.length]);

    return (
        <section className="panel control-panel">
            <div className="panel-heading">
                <h2>Control Client</h2>
                <span className={`pill ${statusTone(control.state)}`}>
                    {control.state}
                </span>
            </div>
            <div className="control-grid">
                <label className="field">
                    <span>WebSocket URL</span>
                    <input
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
                <label className="field">
                    <span>Run ID</span>
                    <input
                        value={runId}
                        onChange={(event) => setRunId(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
                <label className="field">
                    <span>Agent ID</span>
                    <input
                        value={agentId}
                        onChange={(event) => setAgentId(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
            </div>
            <div className="control-actions">
                <button
                    type="button"
                    disabled={!url || connected || connecting}
                    onClick={() =>
                        rallarBlackBoxRuntimeStore.connectControl(
                            url,
                            runId,
                            agentId,
                        )
                    }
                >
                    Connect
                </button>
                <button
                    type="button"
                    disabled={
                        control.state === 'idle' ||
                        control.state === 'disconnected'
                    }
                    onClick={() =>
                        rallarBlackBoxRuntimeStore.disconnectControl()
                    }
                >
                    Disconnect
                </button>
            </div>
            <dl className="control-stats">
                <div>
                    <dt>Sent</dt>
                    <dd>{control.sentCount}</dd>
                </div>
                <div>
                    <dt>Received</dt>
                    <dd>{control.receivedCount}</dd>
                </div>
                <div>
                    <dt>Reconnects</dt>
                    <dd>{control.reconnectAttempt}</dd>
                </div>
                <div>
                    <dt>Heartbeat</dt>
                    <dd>{formatTime(control.lastHeartbeatAtEpochMs)}</dd>
                </div>
            </dl>
            {control.lastError && (
                <div className="workbench-error" role="status">
                    {control.lastError}
                </div>
            )}
        </section>
    );
}

const DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS = {
    commands: 500,
    results: 500,
    events: 1_000,
    stats: 200,
    reports: 120,
    heartbeats: 240,
} as const;

const RUNNER_DISTRIBUTED_POLL_MS = 1_000;

function DistributedRecipesPanel({
    state,
    bootstrap,
    control,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    globalValues: CommandCenterGlobalValues;
}) {
    const [baseUrl, setBaseUrl] = useState(() =>
        controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl),
    );
    const [token, setToken] = useState('');
    const [selectedRunId, setSelectedRunId] = useState(
        control.runId ?? bootstrap.runId ?? '',
    );
    const [distributedRunId, setDistributedRunId] = useState(
        () =>
            `dist-${safeIdSegment(globalValues.roomId || 'group')}-${Date.now()}`,
    );
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const [selectedRecipeIds, setSelectedRecipeIds] = useState<
        readonly string[]
    >(() => DISTRIBUTED_RECIPE_CATALOG.slice(0, 1).map((item) => item.itemId));
    const [rtcRealtimeDurationSeconds, setRtcRealtimeDurationSeconds] =
        useState(RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS);
    const [targetPolicyMode, setTargetPolicyMode] =
        useState<DistributedRecipeTargetPolicyMode>('selected-agents');
    const [rolePattern, setRolePattern] =
        useState<DistributedRecipeRolePattern>('all-agents');
    const [expectedParticipantCount, setExpectedParticipantCount] = useState(50);
    const [ackTimeoutMs, setAckTimeoutMs] = useState(15_000);
    const [barrierEnabled, setBarrierEnabled] = useState(false);
    const [barrierTimeoutMs, setBarrierTimeoutMs] = useState(15_000);
    const [startMode, setStartMode] =
        useState<RallarBlackBoxDistributedRunManifest['startMode']>('manual');
    const [startDelayMs, setStartDelayMs] = useState(3_000);
    const [selectedAgentIds, setSelectedAgentIds] = useState<readonly string[]>(
        [],
    );
    const [snapshot, setSnapshot] = useState<
        ControlServerSnapshot | undefined
    >();
    const [run, setRun] = useState<ControlRunSnapshot | undefined>();
    const [distributedRuns, setDistributedRuns] = useState<
        readonly ControlDistributedRunSnapshot[]
    >([]);
    const [selectedDistributedRun, setSelectedDistributedRun] = useState<
        ControlDistributedRunSnapshot | undefined
    >();
    const [targetResolutionPreview, setTargetResolutionPreview] = useState<
        RallarBlackBoxDistributedTargetResolution | undefined
    >();
    const [artifactBundle, setArtifactBundle] = useState<
        ControlDistributedRunArtifactBundle | undefined
    >();
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [lastAction, setLastAction] = useState<string | undefined>();
    const [historyQuery, setHistoryQuery] = useState('');
    const [historyStatus, setHistoryStatus] = useState('');
    const [historyGroup, setHistoryGroup] = useState('');
    const [historyRecipe, setHistoryRecipe] = useState('');
    const [historyProfile, setHistoryProfile] = useState('');
    const [historyUser, setHistoryUser] = useState('');
    const [historyFailureType, setHistoryFailureType] = useState('');
    const [historyFromDate, setHistoryFromDate] = useState('');
    const [historyToDate, setHistoryToDate] = useState('');
    const [compareLeftId, setCompareLeftId] = useState('');
    const [compareRightId, setCompareRightId] = useState('');
    const [authoringTemplateId, setAuthoringTemplateId] =
        useState<DistributedRecipePromptTemplateId>('live-group-ack');
    const [authoringDraftTarget, setAuthoringDraftTarget] =
        useState<DistributedAuthoringDraftTarget>('distributed-run-manifest');
    const [authoringDraftText, setAuthoringDraftText] = useState('');
    const didInitialRefresh = useRef(false);
    const groupRef = useMemo(
        () => ({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId,
        }),
        [
            globalValues.applicationId,
            globalValues.roomId,
            globalValues.workspaceId,
        ],
    );
    const recipeCatalog = useMemo(
        () =>
            DISTRIBUTED_RECIPE_CATALOG.map((item) =>
                configuredDistributedRecipeCatalogItem(item, {
                    group: groupRef,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    rtcRealtimeDurationSeconds,
                }),
            ),
        [globalValues.apiBaseUrl, groupRef, rtcRealtimeDurationSeconds],
    );
    const runOptions = useMemo(
        () =>
            [...(snapshot?.runs ?? [])].sort(
                (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
            ),
        [snapshot],
    );
    const profileOptions = useMemo(
        () => uniqueValues(recipeCatalog.flatMap((item) => item.profiles)),
        [recipeCatalog],
    );
    const filteredRecipes = useMemo(
        () =>
            recipeCatalog.filter((item) =>
                distributedRecipeMatches(item, query, profile),
            ),
        [profile, query, recipeCatalog],
    );
    const selectedRecipes = useMemo(
        () =>
            recipeCatalog.filter((item) =>
                selectedRecipeIds.includes(item.itemId),
            ),
        [recipeCatalog, selectedRecipeIds],
    );
    const selectedRecipePreflights = useMemo(
        () =>
            selectedRecipes.map((item) => ({
                item,
                preflight: distributedRecipePreflight(item.recipe),
            })),
        [selectedRecipes],
    );
    const selectedPreflightEffectiveOperations =
        selectedRecipePreflights.reduce(
            (sum, entry) => sum + entry.preflight.effectiveCommandCount,
            0,
        );
    const selectedPreflightWarnings = selectedRecipePreflights.reduce(
        (sum, entry) => sum + entry.preflight.warnings.length,
        0,
    );
    const selectedPreflightErrors = selectedRecipePreflights.reduce(
        (sum, entry) => sum + entry.preflight.errors.length,
        0,
    );
    const selectedPreflightCommandKinds = useMemo(
        () =>
            Array.from(new Set(selectedRecipePreflights.flatMap(
                (entry) => entry.preflight.commandKinds,
            ))),
        [selectedRecipePreflights],
    );
    const targetRows = useMemo(
        () =>
            distributedRecipeTargetRows({
                run,
                group: groupRef,
                requiredCommandKinds: selectedPreflightCommandKinds,
                nowEpochMs: Date.now(),
            }),
        [groupRef, run, selectedPreflightCommandKinds],
    );
    const selectedAgentSet = useMemo(
        () => new Set(selectedAgentIds),
        [selectedAgentIds],
    );
    const targetableRows = targetRows.filter((row) => row.targetable);
    const usesWorldFleetTargets = targetPolicyMode === 'all-online-group-members';
    const manifest = useMemo(() => {
        if (
            !selectedRunId ||
            selectedRecipes.length === 0 ||
            !groupRef.groupId
        ) {
            return undefined;
        }
        return buildDistributedRunManifest({
            distributedRunId,
            controlRunId: selectedRunId,
            displayName: `Distributed ${selectedRecipes.map((item) => item.title).join(', ')}`,
            group: groupRef,
            recipes: selectedRecipes,
            targetAgentIds: usesWorldFleetTargets ? [] : selectedAgentIds,
            targetPolicyMode,
            rolePattern,
            ackTimeoutMs,
            barrier: barrierEnabled
                ? {
                      enabled: true,
                      timeoutMs: barrierTimeoutMs,
                  }
                : undefined,
            startMode: startMode ?? 'manual',
            startDeadlineEpochMs:
                startMode === 'scheduled'
                    ? Date.now() + Math.max(1, startDelayMs)
                    : undefined,
            expectedParticipantCount:
                usesWorldFleetTargets
                    ? expectedParticipantCount
                    : selectedAgentIds.length > 0
                    ? selectedAgentIds.length
                    : undefined,
        });
    }, [
        ackTimeoutMs,
        barrierEnabled,
        barrierTimeoutMs,
        distributedRunId,
        groupRef,
        expectedParticipantCount,
        rolePattern,
        selectedAgentIds,
        selectedRecipes,
        selectedRunId,
        startDelayMs,
        startMode,
        targetPolicyMode,
        usesWorldFleetTargets,
    ]);
    const manifestValidation = useMemo(
        () =>
            manifest
                ? validateDistributedRecipeManifest(manifest)
                : 'Select a run, group, and at least one recipe.',
        [manifest],
    );
    const worldFleetTargetGate = deriveDistributedWorldFleetTargetGate({
        usesWorldFleetTargets,
        expectedParticipantCount,
        targetResolutionPreview,
        selectedDistributedRun,
        distributedRunId,
    });
    const activeTargetResolution = worldFleetTargetGate.targetResolution;
    const worldFleetPreviewSelected = worldFleetTargetGate.previewSelected;
    const worldFleetStageStartBlocked = worldFleetTargetGate.blocked;
    const worldFleetBlockReason = worldFleetTargetGate.blockReason;
    const manifestAuthoringValidation = useMemo(
        () =>
            manifest
                ? validateSchemaAuthoringValue(
                      'distributed-run-manifest',
                      manifest,
                  )
                : undefined,
        [manifest],
    );
    const authoringSchemaContextText = useMemo(
        () => distributedRecipeSchemaContextText(),
        [],
    );
    const authoringDraftValidation = useMemo(
        () =>
            authoringDraftText.trim().length > 0
                ? validateSchemaAuthoringText(
                      authoringDraftTarget,
                      authoringDraftText,
                  )
                : undefined,
        [authoringDraftTarget, authoringDraftText],
    );
    const authoringDraftPreflights = useMemo(
        () => distributedAuthoringDraftPreflights(authoringDraftValidation),
        [authoringDraftValidation],
    );
    const authoringValidationFeedback = useMemo(
        () =>
            authoringDraftValidation
                ? distributedPromptFeedbackFromValidation(
                      authoringDraftValidation,
                      authoringDraftPreflights,
                  )
                : undefined,
        [authoringDraftPreflights, authoringDraftValidation],
    );
    const authoringValidationFeedbackText = useMemo(
        () =>
            authoringValidationFeedback
                ? renderDistributedRecipeValidationFeedback(
                      authoringValidationFeedback,
                  )
                : 'Paste generated JSON to get schema validation and distributed recipe preflight feedback.',
        [authoringValidationFeedback],
    );
    const authoringPromptVariables = useMemo(
        () => ({
            apiBaseUrl: globalValues.apiBaseUrl,
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId,
            clientId: globalValues.clientId,
            sessionId: globalValues.sessionId,
            controlHttpBaseUrl: baseUrl,
            controlRunId: selectedRunId,
            distributedRunId,
            targetPolicyMode,
            rolePattern,
            ackTimeoutMs,
            barrier: barrierEnabled
                ? { enabled: true, timeoutMs: barrierTimeoutMs }
                : undefined,
            startMode,
            selectedAgentIds,
            selectedRecipes: selectedRecipes.map((item) => ({
                itemId: item.itemId,
                recipeId: item.recipe.recipeId,
                title: item.title,
                live: item.live,
                profiles: item.profiles,
            })),
            controlToken: token,
        }),
        [
            ackTimeoutMs,
            barrierEnabled,
            barrierTimeoutMs,
            baseUrl,
            distributedRunId,
            globalValues.apiBaseUrl,
            globalValues.applicationId,
            globalValues.clientId,
            globalValues.roomId,
            globalValues.sessionId,
            globalValues.workspaceId,
            rolePattern,
            selectedAgentIds,
            selectedRecipes,
            selectedRunId,
            startMode,
            targetPolicyMode,
            token,
        ],
    );
    const redactedAuthoringPromptVariables = useMemo(
        () => redactDistributedRecipePromptVariables(authoringPromptVariables),
        [authoringPromptVariables],
    );
    const authoringPromptText = useMemo(
        () =>
            renderDistributedRecipePromptTemplate(authoringTemplateId, {
                variables: authoringPromptVariables,
                validationFeedback: authoringValidationFeedback,
            }),
        [
            authoringPromptVariables,
            authoringTemplateId,
            authoringValidationFeedback,
        ],
    );
    const currentDistributedRuns = useMemo(
        () =>
            distributedRuns
                .filter((item) => item.controlRunId === selectedRunId)
                .sort(
                    (left, right) =>
                        right.updatedAtEpochMs - left.updatedAtEpochMs,
                ),
        [distributedRuns, selectedRunId],
    );
    const historyStatusOptions = useMemo(
        () => uniqueValues(distributedRuns.map((item) => item.state)),
        [distributedRuns],
    );
    const historyRecipeOptions = useMemo(
        () =>
            uniqueValues(
                distributedRuns.flatMap((item) =>
                    item.manifest.recipes.map(
                        (selection, index) =>
                            selection.recipeId ??
                            selection.recipe?.recipeId ??
                            `recipe-${index + 1}`,
                    ),
                ),
            ),
        [distributedRuns],
    );
    const historyGroupOptions = useMemo(
        () =>
            uniqueValues(
                distributedRuns.map((item) => item.manifest.group.groupId),
            ),
        [distributedRuns],
    );
    const historyProfileOptions = useMemo(
        () =>
            uniqueValues(
                distributedRuns.flatMap((item) =>
                    item.manifest.recipes
                        .map((selection) => selection.profile)
                        .filter((value): value is string => Boolean(value)),
                ),
            ),
        [distributedRuns],
    );
    const historyRows = useMemo(
        () =>
            filterDistributedRuns(distributedRuns, {
                query: historyQuery,
                groupId: historyGroup,
                recipeId: historyRecipe,
                profile: historyProfile,
                user: historyUser,
                status: historyStatus,
                failureType: historyFailureType,
                fromEpochMs: dateInputStartEpoch(historyFromDate),
                toEpochMs: dateInputEndEpoch(historyToDate),
            }),
        [
            distributedRuns,
            historyFailureType,
            historyFromDate,
            historyGroup,
            historyProfile,
            historyQuery,
            historyRecipe,
            historyStatus,
            historyToDate,
            historyUser,
        ],
    );
    const selectedMonitor = useMemo(
        () =>
            selectedDistributedRun
                ? deriveDistributedRunMonitor({
                      distributedRun: selectedDistributedRun,
                      controlRun: run,
                      artifactBundle,
                  })
                : undefined,
        [artifactBundle, run, selectedDistributedRun],
    );
    const distributedTargetAgentRows = useMemo(
        () =>
            deriveControlAgentBoardRows({
                run,
                group: groupRef,
                requiredCommandKinds: selectedPreflightCommandKinds,
                distributedRuns,
                selectedDistributedRun,
                monitorAgentProgress: selectedMonitor?.agentProgress ?? [],
                nowEpochMs: Date.now(),
            }),
        [
            distributedRuns,
            groupRef,
            run,
            selectedDistributedRun,
            selectedMonitor?.agentProgress,
            selectedPreflightCommandKinds,
        ],
    );
    const distributedTargetAgentSummary = useMemo(
        () => summarizeControlAgentBoardRows(distributedTargetAgentRows),
        [distributedTargetAgentRows],
    );
    const compareLeftRun = useMemo(
        () =>
            distributedRuns.find(
                (item) => item.distributedRunId === compareLeftId,
            ),
        [compareLeftId, distributedRuns],
    );
    const compareRightRun = useMemo(
        () =>
            distributedRuns.find(
                (item) => item.distributedRunId === compareRightId,
            ),
        [compareRightId, distributedRuns],
    );
    const compareSummary = useMemo(
        () =>
            compareLeftRun && compareRightRun
                ? compareDistributedRuns({
                      left: compareLeftRun,
                      right: compareRightRun,
                      leftControlRun:
                          compareLeftRun.controlRunId === run?.runId
                              ? run
                              : undefined,
                      rightControlRun:
                          compareRightRun.controlRunId === run?.runId
                              ? run
                              : undefined,
                  })
                : undefined,
        [compareLeftRun, compareRightRun, run],
    );
    const liveSelectedRecipeCount = selectedRecipes.filter(
        (item) => item.live,
    ).length;
    const rtcRealtimeSelected = selectedRecipeIds.includes(
        RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    );
    const rtcRealtimeFrameCount =
        rtcRealtimeDurationSeconds * RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ;

    const refresh = async (
        preferredRunId = selectedRunId,
        preferredDistributedRunId = distributedRunId,
    ): Promise<void> => {
        setBusyAction('refresh');
        setError(undefined);
        try {
            const [serverSnapshot, distributedList] = await Promise.all([
                fetchControlServerSnapshot({
                    baseUrl,
                    token,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                }),
                fetchDistributedRuns({
                    baseUrl,
                    token,
                }),
            ]);
            setSnapshot(serverSnapshot);
            setDistributedRuns(distributedList);
            const knownRunIds = new Set(
                serverSnapshot.runs.map((option) => option.runId),
            );
            const nextRunId =
                [
                    preferredRunId,
                    control.runId,
                    bootstrap.runId,
                    serverSnapshot.runs[0]?.runId,
                ].find(
                    (candidate) => candidate && knownRunIds.has(candidate),
                ) ?? '';
            setSelectedRunId(nextRunId);
            if (nextRunId) {
                setRun(
                    await fetchControlRunSnapshot({
                        baseUrl,
                        token,
                        runId: nextRunId,
                        bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                    }),
                );
            } else {
                setRun(undefined);
            }
            const nextDistributedRun = distributedList.find(
                (item) => item.distributedRunId === preferredDistributedRunId,
            );
            setSelectedDistributedRun(nextDistributedRun);
            setArtifactBundle(undefined);
            setLastAction(
                `Refreshed ${serverSnapshot.runs.length} run(s), ${distributedList.length} distributed run(s).`,
            );
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    useEffect(() => {
        if (didInitialRefresh.current) {
            return;
        }
        didInitialRefresh.current = true;
        void refresh();
        // The initial refresh intentionally uses the first rendered form values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        setTargetResolutionPreview(undefined);
    }, [
        distributedRunId,
        expectedParticipantCount,
        groupRef.applicationId,
        groupRef.groupId,
        groupRef.workspaceId,
        rolePattern,
        selectedRunId,
        targetPolicyMode,
    ]);

    useEffect(() => {
        const defaults = defaultDistributedRecipeTargetIds(targetRows);
        setSelectedAgentIds((previous) => {
            const kept = previous.filter((agentId) =>
                targetRows.some((row) => row.agentId === agentId),
            );
            const next = kept.length > 0 ? kept : defaults;
            return sameStringArray(previous, next) ? previous : next;
        });
    }, [targetRows]);

    const loadRun = async (runId: string): Promise<void> => {
        setSelectedRunId(runId);
        setArtifactBundle(undefined);
        setError(undefined);
        if (!runId) {
            setRun(undefined);
            return;
        }
        setBusyAction('load-run');
        try {
            setRun(
                await fetchControlRunSnapshot({
                    baseUrl,
                    token,
                    runId,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                }),
            );
            setLastAction(`Loaded ${runId}.`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const resolveTargets = async (): Promise<void> => {
        setBusyAction('resolve-targets');
        setError(undefined);
        try {
            await loadRun(selectedRunId);
            if (usesWorldFleetTargets && manifest) {
                const resolution = await resolveDistributedTargets({
                    baseUrl,
                    token,
                    manifest,
                });
                setTargetResolutionPreview(resolution);
                setSelectedAgentIds(resolution.targetAgentIds);
                setLastAction(
                    `Server resolved ${resolution.summary.selected}/${resolution.summary.expectedParticipantCount ?? expectedParticipantCount} world-fleet target(s).`,
                );
                return;
            }
            const defaults = defaultDistributedRecipeTargetIds(targetRows);
            setTargetResolutionPreview(undefined);
            setSelectedAgentIds(defaults);
            setLastAction(`Resolved ${defaults.length} target agent(s).`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const ensureCreatedDistributedRun =
        async (): Promise<ControlDistributedRunSnapshot> => {
            if (!manifest) {
                throw new Error(
                    'Build a valid distributed run manifest before creating the run.',
                );
            }
            if (manifestValidation) {
                throw new Error(manifestValidation);
            }
            const existing =
                selectedDistributedRun?.distributedRunId ===
                manifest.distributedRunId
                    ? selectedDistributedRun
                    : distributedRuns.find(
                          (item) =>
                              item.distributedRunId ===
                              manifest.distributedRunId,
                      );
            if (existing) {
                return existing;
            }
            const created = await createDistributedRun({
                baseUrl,
                token,
                manifest,
            });
            setSelectedDistributedRun(created);
            setDistributedRuns((current) => [created, ...current]);
            return created;
        };

    const createRun = async (): Promise<void> => {
        setBusyAction('create');
        setError(undefined);
        try {
            const created = await ensureCreatedDistributedRun();
            setLastAction(`Created ${created.distributedRunId}.`);
            await refresh(created.controlRunId, created.distributedRunId);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const stageRun = async (): Promise<void> => {
        setBusyAction('stage');
        setError(undefined);
        try {
            if (worldFleetBlockReason) {
                throw new Error(worldFleetBlockReason);
            }
            const created = await ensureCreatedDistributedRun();
            const staged = await stageDistributedRun({
                baseUrl,
                token,
                distributedRunId: created.distributedRunId,
            });
            setSelectedDistributedRun(staged);
            setLastAction(`Staged ${staged.distributedRunId}.`);
            await refresh(staged.controlRunId, staged.distributedRunId);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const startRun = async (): Promise<void> => {
        if (worldFleetBlockReason) {
            setError(worldFleetBlockReason);
            return;
        }
        const target =
            selectedDistributedRun ??
            distributedRuns.find(
                (item) => item.distributedRunId === distributedRunId,
            );
        if (!target) {
            setError('Create or stage a distributed run before starting it.');
            return;
        }
        setBusyAction('start');
        setError(undefined);
        try {
            const started = await startDistributedRun({
                baseUrl,
                token,
                distributedRunId: target.distributedRunId,
            });
            setSelectedDistributedRun(started);
            setLastAction(`Started ${started.distributedRunId}.`);
            await refresh(started.controlRunId, started.distributedRunId);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const cancelRun = async (): Promise<void> => {
        const target =
            selectedDistributedRun ??
            distributedRuns.find(
                (item) => item.distributedRunId === distributedRunId,
            );
        if (!target) {
            setError('Select a distributed run before cancelling it.');
            return;
        }
        setBusyAction('cancel');
        setError(undefined);
        try {
            const cancelled = await cancelDistributedRun({
                baseUrl,
                token,
                distributedRunId: target.distributedRunId,
                reason: 'Cancelled from Rallar Kit Distributed Recipes UI.',
            });
            setSelectedDistributedRun(cancelled);
            setLastAction(`Cancelled ${cancelled.distributedRunId}.`);
            await refresh(cancelled.controlRunId, cancelled.distributedRunId);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const loadArtifact = async (): Promise<void> => {
        const target =
            selectedDistributedRun ??
            distributedRuns.find(
                (item) => item.distributedRunId === distributedRunId,
            );
        if (!target) {
            setError('Select a distributed run before exporting artifacts.');
            return;
        }
        setBusyAction('artifact');
        setError(undefined);
        try {
            const bundle = await fetchDistributedRunArtifactBundle({
                baseUrl,
                token,
                distributedRunId: target.distributedRunId,
            });
            setArtifactBundle(bundle);
            setLastAction(
                `Loaded distributed artifact for ${target.distributedRunId}.`,
            );
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const copyArtifact = async (): Promise<void> => {
        const bundle = artifactBundle;
        if (!bundle) {
            return;
        }
        await navigator.clipboard?.writeText(json(bundle.files));
        setLastAction('Copied distributed artifact files.');
    };

    const copyAuthoringText = async (
        text: string,
        label: string,
    ): Promise<void> => {
        if (!navigator.clipboard) {
            setLastAction('Clipboard is unavailable in this browser context.');
            return;
        }
        await navigator.clipboard.writeText(text);
        setLastAction(label);
    };

    const useManifestPreviewForAuthoring = (): void => {
        if (!manifest) {
            return;
        }
        setAuthoringDraftTarget('distributed-run-manifest');
        setAuthoringDraftText(json(manifest));
        setLastAction('Loaded manifest preview into Generate With AI draft.');
    };

    const loadDistributedRun = async (id: string): Promise<void> => {
        setDistributedRunId(id);
        setBusyAction('load-distributed-run');
        setError(undefined);
        try {
            const loaded = await fetchDistributedRun({
                baseUrl,
                token,
                distributedRunId: id,
            });
            setSelectedDistributedRun(loaded);
            setSelectedRunId(loaded.controlRunId);
            await loadRun(loaded.controlRunId);
            setLastAction(`Loaded ${id}.`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const toggleRecipe = (itemId: string): void => {
        setSelectedRecipeIds((previous) =>
            previous.includes(itemId)
                ? previous.filter((value) => value !== itemId)
                : [...previous, itemId],
        );
    };

    const toggleAgent = (agentId: string): void => {
        setSelectedAgentIds((previous) =>
            previous.includes(agentId)
                ? previous.filter((value) => value !== agentId)
                : [...previous, agentId],
        );
    };

    const selectRolePattern = (value: DistributedRecipeRolePattern): void => {
        setRolePattern(value);
        if (
            value !== 'all-agents' &&
            targetPolicyMode !== 'all-online-group-members'
        ) {
            setTargetPolicyMode('role-map');
        } else if (targetPolicyMode === 'role-map') {
            setTargetPolicyMode('selected-agents');
        }
    };

    const generateNewRunId = (): void => {
        setDistributedRunId(
            `dist-${safeIdSegment(globalValues.roomId || 'group')}-${Date.now()}`,
        );
        setSelectedDistributedRun(undefined);
        setArtifactBundle(undefined);
    };
    const redactedError = error
        ? String(
              redactRallarBlackBoxValue(
                  error,
                  uiRedactionOptions(state, undefined, [token]),
              ),
          )
        : undefined;

    return (
        <section className="panel distributed-recipes-panel">
            <DistributedRecipesHeader
                status={busyAction ?? lastAction ?? 'idle'}
                busy={Boolean(busyAction)}
                baseUrl={baseUrl}
                token={token}
                selectedRunId={selectedRunId}
                runOptions={runOptions}
                group={groupRef}
                selectedRecipeCount={selectedRecipes.length}
                liveSelectedRecipeCount={liveSelectedRecipeCount}
                usesWorldFleetTargets={usesWorldFleetTargets}
                worldFleetPreviewSelected={worldFleetPreviewSelected}
                worldFleetStageStartBlocked={worldFleetStageStartBlocked}
                expectedParticipantCount={expectedParticipantCount}
                selectedAgentCount={selectedAgentIds.length}
                targetableAgentCount={targetableRows.length}
                distributedRunCount={distributedRuns.length}
                redactedError={redactedError}
                manifestValidation={manifestValidation}
                onBaseUrlChange={setBaseUrl}
                onTokenChange={setToken}
                onRunChange={loadRun}
                onRefresh={refresh}
                onResolveTargets={resolveTargets}
            />
            <DistributedRecipeAuthoringPanel
                selectedTemplateId={authoringTemplateId}
                promptText={authoringPromptText}
                schemaContextText={authoringSchemaContextText}
                promptVariables={redactedAuthoringPromptVariables}
                draftTarget={authoringDraftTarget}
                draftText={authoringDraftText}
                draftValidation={authoringDraftValidation}
                draftPreflights={authoringDraftPreflights}
                validationFeedbackText={authoringValidationFeedbackText}
                canUseManifestPreview={Boolean(manifest)}
                onTemplateChange={setAuthoringTemplateId}
                onDraftTargetChange={setAuthoringDraftTarget}
                onDraftTextChange={setAuthoringDraftText}
                onCopyPrompt={() =>
                    void copyAuthoringText(
                        authoringPromptText,
                        'Copied distributed recipe prompt.',
                    )
                }
                onCopySchemaContext={() =>
                    void copyAuthoringText(
                        authoringSchemaContextText,
                        'Copied distributed recipe schema context.',
                    )
                }
                onCopyValidationFeedback={() =>
                    void copyAuthoringText(
                        authoringValidationFeedbackText,
                        'Copied distributed recipe validation feedback.',
                    )
                }
                onUseManifestPreview={useManifestPreviewForAuthoring}
            />
            <div className="distributed-layout">
                <DistributedRecipeCatalogPanel
                    query={query}
                    profile={profile}
                    profileOptions={profileOptions}
                    rtcRealtimeSelected={rtcRealtimeSelected}
                    rtcRealtimeDurationSeconds={rtcRealtimeDurationSeconds}
                    rtcRealtimeFrameCount={rtcRealtimeFrameCount}
                    filteredRecipes={filteredRecipes}
                    selectedRecipeIds={selectedRecipeIds}
                    onQueryChange={setQuery}
                    onProfileChange={setProfile}
                    onRtcRealtimeDurationChange={setRtcRealtimeDurationSeconds}
                    onToggleRecipe={toggleRecipe}
                />
                <DistributedTargetResolutionPanel
                    targetRowCount={targetRows.length}
                    targetPolicyMode={targetPolicyMode}
                    rolePattern={rolePattern}
                    usesWorldFleetTargets={usesWorldFleetTargets}
                    expectedParticipantCount={expectedParticipantCount}
                    ackTimeoutMs={ackTimeoutMs}
                    barrierEnabled={barrierEnabled}
                    barrierTimeoutMs={barrierTimeoutMs}
                    startMode={startMode}
                    startDelayMs={startDelayMs}
                    activeTargetResolution={activeTargetResolution}
                    selectedAgentCount={selectedAgentIds.length}
                    targetableAgentCount={targetableRows.length}
                    groupId={groupRef.groupId}
                    agentRows={distributedTargetAgentRows}
                    agentSummary={distributedTargetAgentSummary}
                    selectedAgentIds={selectedAgentSet}
                    onTargetPolicyModeChange={setTargetPolicyMode}
                    onRolePatternChange={selectRolePattern}
                    onExpectedParticipantCountChange={setExpectedParticipantCount}
                    onAckTimeoutMsChange={setAckTimeoutMs}
                    onBarrierEnabledChange={setBarrierEnabled}
                    onBarrierTimeoutMsChange={setBarrierTimeoutMs}
                    onStartModeChange={setStartMode}
                    onStartDelayMsChange={setStartDelayMs}
                    onToggleAgent={toggleAgent}
                />
                <DistributedRunControlPanel
                    busy={Boolean(busyAction)}
                    manifestValidation={manifestValidation}
                    worldFleetBlockReason={worldFleetBlockReason}
                    distributedRunId={distributedRunId}
                    selectedDistributedRun={selectedDistributedRun}
                    currentDistributedRuns={currentDistributedRuns}
                    artifactBundle={artifactBundle}
                    onDistributedRunIdChange={(value) => {
                        setDistributedRunId(value);
                        setSelectedDistributedRun(undefined);
                        setArtifactBundle(undefined);
                    }}
                    onGenerateNewRunId={generateNewRunId}
                    onCreateRun={createRun}
                    onStageRun={stageRun}
                    onStartRun={startRun}
                    onCancelRun={cancelRun}
                    onLoadArtifact={loadArtifact}
                    onCopyArtifact={copyArtifact}
                    onLoadDistributedRun={loadDistributedRun}
                />
                <DistributedManifestPreviewPanel
                    manifestValidation={manifestValidation}
                    selectedRecipePreflights={selectedRecipePreflights}
                    selectedPreflightEffectiveOperations={
                        selectedPreflightEffectiveOperations
                    }
                    selectedPreflightWarnings={selectedPreflightWarnings}
                    selectedPreflightErrors={selectedPreflightErrors}
                    manifest={manifest}
                    manifestAuthoringValidation={manifestAuthoringValidation}
                />
                <DistributedRunMonitorPanel monitor={selectedMonitor} />
                <section className="distributed-subpanel distributed-history-panel">
                    <div className="section-heading">
                        <h3>Historical Runs</h3>
                        <span>
                            {historyRows.length}/{distributedRuns.length}
                        </span>
                    </div>
                    <div className="distributed-history-filters">
                        <label className="field">
                            <span>Search</span>
                            <input
                                value={historyQuery}
                                onChange={(event) =>
                                    setHistoryQuery(event.target.value)
                                }
                                placeholder="run, group, recipe, failure"
                            />
                        </label>
                        <label className="field">
                            <span>Status</span>
                            <select
                                value={historyStatus}
                                onChange={(event) =>
                                    setHistoryStatus(event.target.value)
                                }
                            >
                                <option value="">Any</option>
                                {historyStatusOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="field">
                            <span>Group</span>
                            <select
                                value={historyGroup}
                                onChange={(event) =>
                                    setHistoryGroup(event.target.value)
                                }
                            >
                                <option value="">Any</option>
                                {historyGroupOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="field">
                            <span>Recipe</span>
                            <select
                                value={historyRecipe}
                                onChange={(event) =>
                                    setHistoryRecipe(event.target.value)
                                }
                            >
                                <option value="">Any</option>
                                {historyRecipeOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="field">
                            <span>Profile</span>
                            <select
                                value={historyProfile}
                                onChange={(event) =>
                                    setHistoryProfile(event.target.value)
                                }
                            >
                                <option value="">Any</option>
                                {historyProfileOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="field">
                            <span>User</span>
                            <input
                                value={historyUser}
                                onChange={(event) =>
                                    setHistoryUser(event.target.value)
                                }
                            />
                        </label>
                        <label className="field">
                            <span>Failure</span>
                            <select
                                value={historyFailureType}
                                onChange={(event) =>
                                    setHistoryFailureType(event.target.value)
                                }
                            >
                                <option value="">Any</option>
                                <option value="any">Any failure</option>
                                <option value="run">Run</option>
                                <option value="participant">Participant</option>
                                <option value="recipe">Recipe</option>
                                <option value="timed-out">Timed out</option>
                            </select>
                        </label>
                        <label className="field">
                            <span>From</span>
                            <input
                                type="date"
                                value={historyFromDate}
                                onChange={(event) =>
                                    setHistoryFromDate(event.target.value)
                                }
                            />
                        </label>
                        <label className="field">
                            <span>To</span>
                            <input
                                type="date"
                                value={historyToDate}
                                onChange={(event) =>
                                    setHistoryToDate(event.target.value)
                                }
                            />
                        </label>
                    </div>
                    <div className="distributed-run-list distributed-history-list">
                        {historyRows.map((item) => (
                            <button
                                type="button"
                                key={item.distributedRunId}
                                className={`distributed-run-row ${item.distributedRunId === selectedDistributedRun?.distributedRunId ? 'selected' : ''}`}
                                onClick={() =>
                                    void loadDistributedRun(
                                        item.distributedRunId,
                                    )
                                }
                            >
                                <span>
                                    <strong>{item.distributedRunId}</strong>
                                    <small>
                                        {item.manifest.group.groupId} -{' '}
                                        {item.manifest.recipes
                                            .map(
                                                (selection, index) =>
                                                    selection.recipeId ??
                                                    selection.recipe
                                                        ?.recipeId ??
                                                    `recipe-${index + 1}`,
                                            )
                                            .join(', ')}
                                    </small>
                                </span>
                                <span
                                    className={`pill ${distributedRecipeStateTone(item.state)}`}
                                >
                                    {item.state}
                                </span>
                                <small>
                                    {formatTime(item.updatedAtEpochMs)}
                                </small>
                            </button>
                        ))}
                        {historyRows.length === 0 && (
                            <div className="empty-state">
                                No distributed runs match the filters
                            </div>
                        )}
                    </div>
                </section>
                <DistributedRunComparePanel
                    runs={distributedRuns}
                    leftId={compareLeftId}
                    rightId={compareRightId}
                    summary={compareSummary}
                    onLeftChange={setCompareLeftId}
                    onRightChange={setCompareRightId}
                />
            </div>
        </section>
    );
}

function BootstrapPanel({
    bootstrap,
}: {
    bootstrap: RallarBlackBoxBootstrapConfig;
}) {
    return (
        <section className="panel bootstrap-panel">
            <div className="panel-heading">
                <h2>Bootstrap</h2>
                <span
                    className={`pill ${bootstrap.mode === 'control-agent' ? 'active' : 'muted'}`}
                >
                    {bootstrap.mode}
                </span>
            </div>
            <dl className="config-grid">
                <div>
                    <dt>Source</dt>
                    <dd>{bootstrap.source}</dd>
                </div>
                <div>
                    <dt>Provider</dt>
                    <dd>{bootstrap.providerMode}</dd>
                </div>
                <div>
                    <dt>Auto Connect</dt>
                    <dd>{bootstrap.autoConnect ? 'enabled' : 'disabled'}</dd>
                </div>
                <div>
                    <dt>Control URL</dt>
                    <dd>{bootstrap.controlUrl}</dd>
                </div>
                <div>
                    <dt>Run</dt>
                    <dd>{bootstrap.runId ?? 'generated'}</dd>
                </div>
                <div>
                    <dt>Agent</dt>
                    <dd>{bootstrap.agentId}</dd>
                </div>
            </dl>
        </section>
    );
}

function ConfigurationPanel({ state }: { state: RallarBlackBoxTestState }) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);

    return (
        <section className="panel config-panel">
            <div className="panel-heading">
                <h2>Configuration</h2>
                <span className="pill muted">redacted</span>
            </div>
            <dl className="config-list">
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>API base</dt>
                    <dd>{config?.apiBaseUrl ?? 'not configured'}</dd>
                </div>
                <div>
                    <dt>Transport</dt>
                    <dd>{config?.transport ?? 'not selected'}</dd>
                </div>
                <div>
                    <dt>Room</dt>
                    <dd>{config?.roomId ?? 'not joined'}</dd>
                </div>
                <div>
                    <dt>Control mode</dt>
                    <dd>{String(config?.control?.mode ?? 'local')}</dd>
                </div>
            </dl>
            <pre className="json-block">{redactedJson(config, state)}</pre>
        </section>
    );
}

function CommandQueuePanel({
    rows,
    selectedCommandId,
    onSelect,
}: {
    rows: readonly CommandQueueRow[];
    selectedCommandId?: string;
    onSelect(commandId: string): void;
}) {
    return (
        <section className="panel queue-panel">
            <div className="panel-heading">
                <h2>Command Queue</h2>
                <span>{rows.length} commands</span>
            </div>
            <div className="queue-list">
                {rows.map((row) => (
                    <button
                        type="button"
                        key={row.id}
                        className={`queue-row ${selectedCommandId === row.id ? 'selected' : ''}`}
                        onClick={() => onSelect(row.id)}
                    >
                        <span className={`status-dot ${row.status}`} />
                        <span className="queue-main">
                            <strong>{row.label}</strong>
                            <small>{row.id}</small>
                        </span>
                        <span className={`pill ${statusTone(row.status)}`}>
                            {row.status}
                        </span>
                        <span className="queue-time">
                            {row.timeoutMs ? `${row.timeoutMs} ms` : '-'}
                        </span>
                    </button>
                ))}
            </div>
        </section>
    );
}

function ExecutionFocusPanel({
    result,
    activeCommand,
    startedAtEpochMs,
    now,
    redactionOptions,
}: {
    result?: RallarBlackBoxTestResult;
    activeCommand?: RallarBlackBoxTestCommand & Readonly<{ commandId: string }>;
    startedAtEpochMs?: number;
    now: number;
    redactionOptions: RallarBlackBoxTestRedactionOptions;
}) {
    const deadlineEpochMs = activeDeadlineEpochMs(
        activeCommand,
        startedAtEpochMs,
    );
    const elapsedMs =
        activeCommand && startedAtEpochMs !== undefined
            ? Math.max(0, now - startedAtEpochMs)
            : undefined;
    const remainingMs =
        deadlineEpochMs !== undefined
            ? Math.max(0, deadlineEpochMs - now)
            : undefined;
    const retryState =
        activeCommand?.metadata?.retry ??
        activeCommand?.metadata?.retries ??
        'none';

    return (
        <section className="panel focus-panel">
            <div className="panel-heading">
                <h2>Current Focus</h2>
                <span
                    className={`pill ${result ? statusTone(result.status) : activeCommand ? 'active' : 'muted'}`}
                >
                    {result?.status ?? (activeCommand ? 'running' : 'none')}
                </span>
            </div>
            {activeCommand && (
                <div className="active-command">
                    <span>Executing</span>
                    <strong>{activeCommand.commandId}</strong>
                    <small>{activeCommand.kind}</small>
                </div>
            )}
            <dl className="result-summary">
                <div>
                    <dt>Command</dt>
                    <dd>
                        {result?.commandId ?? activeCommand?.commandId ?? '-'}
                    </dd>
                </div>
                <div>
                    <dt>Kind</dt>
                    <dd>{result?.kind ?? activeCommand?.kind ?? '-'}</dd>
                </div>
                <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(result?.durationMs ?? elapsedMs)}</dd>
                </div>
                <div>
                    <dt>Deadline</dt>
                    <dd>
                        {deadlineEpochMs ? formatTime(deadlineEpochMs) : '-'}
                    </dd>
                </div>
                <div>
                    <dt>Remaining</dt>
                    <dd>{formatDuration(remainingMs)}</dd>
                </div>
                <div>
                    <dt>Retry</dt>
                    <dd>{String(retryState)}</dd>
                </div>
                <div>
                    <dt>Ended</dt>
                    <dd>{formatTime(result?.endedAtEpochMs)}</dd>
                </div>
            </dl>
            <pre className="json-block">
                {json(
                    redactRallarBlackBoxValue(
                        result ?? activeCommand,
                        redactionOptions,
                    ),
                )}
            </pre>
        </section>
    );
}

function CommandHistoryPanel({
    history,
    selectedCommandId,
    onSelect,
}: {
    history: readonly RallarBlackBoxTestResult[];
    selectedCommandId?: string;
    onSelect(commandId: string): void;
}) {
    return (
        <section className="panel history-panel">
            <div className="panel-heading">
                <h2>Completed Commands</h2>
                <span>{history.length} results</span>
            </div>
            <div className="history-list">
                {history
                    .slice(-30)
                    .reverse()
                    .map((result, index) => (
                        <button
                            type="button"
                            key={`${result.commandId}-${index}`}
                            className={`history-row ${selectedCommandId === result.commandId ? 'selected' : ''}`}
                            onClick={() => onSelect(result.commandId)}
                        >
                            <span
                                className={`status-dot ${result.ok ? 'completed' : 'failed'}`}
                            />
                            <span className="history-main">
                                <strong>{result.commandId}</strong>
                                <small>{result.kind}</small>
                            </span>
                            <span>{formatDuration(result.durationMs)}</span>
                            <span
                                className={`pill ${statusTone(result.status)}`}
                            >
                                {result.status}
                            </span>
                            <small className="history-summary">
                                {resultSummary(result)}
                            </small>
                        </button>
                    ))}
            </div>
        </section>
    );
}

function EventStreamPanel({ state }: { state: RallarBlackBoxTestState }) {
    const events = selectRallarBlackBoxEvents(state);
    const [eventLimit, setEventLimit] = useState(40);
    const [filters, setFilters] = useState<EventFilters>(() => {
        const stored = readEventFilters(
            browserUiStorage(),
            DEFAULT_EVENT_FILTERS,
        );
        return {
            ...stored,
            kind: eventFilterFromValue(stored.kind),
        };
    });
    const filtered = useMemo(
        () => events.filter((event) => eventMatchesFilters(event, filters)),
        [events, filters],
    );
    const visibleEvents = useMemo(
        () => filtered.slice(-eventLimit).reverse(),
        [eventLimit, filtered],
    );
    const hiddenCount = Math.max(0, filtered.length - visibleEvents.length);
    const kindFilters = EVENT_KIND_FILTERS;
    const commandIds = uniqueValues(events.map((event) => event.commandId));
    const connections = uniqueValues(events.map((event) => event.connection));
    const actors = uniqueValues(events.map((event) => event.actor));
    const transports = uniqueValues(
        events.map(
            (event) =>
                event.transport as RallarBlackBoxTestTransport | undefined,
        ),
    );
    const groups = uniqueValues(events.map(eventGroupValue));
    const peers = uniqueValues(events.map(eventPeerValue));
    const selectors = uniqueValues(events.map(eventSelectorValue));
    const severities = uniqueValues(
        events.map(
            (event) => event.severity as RallarBlackBoxTestSeverity | undefined,
        ),
    );

    useEffect(() => {
        writeEventFilters(browserUiStorage(), filters);
    }, [filters]);

    return (
        <section className="panel event-panel">
            <div className="panel-heading">
                <h2>Event Stream</h2>
                <span>
                    {visibleEvents.length} of {filtered.length} visible
                </span>
            </div>
            <div
                className="segmented"
                role="group"
                aria-label="Event kind filter"
            >
                {kindFilters.map((kind) => (
                    <button
                        type="button"
                        key={kind}
                        className={filters.kind === kind ? 'selected' : ''}
                        onClick={() =>
                            setFilters((current) => ({ ...current, kind }))
                        }
                    >
                        {kind}
                    </button>
                ))}
            </div>
            <div className="event-filter-grid">
                <FilterSelect
                    label="Command"
                    value={filters.commandId}
                    values={commandIds}
                    onChange={(commandId) =>
                        setFilters((current) => ({ ...current, commandId }))
                    }
                />
                <FilterSelect
                    label="Connection"
                    value={filters.connection}
                    values={connections}
                    onChange={(connection) =>
                        setFilters((current) => ({ ...current, connection }))
                    }
                />
                <FilterSelect
                    label="Actor"
                    value={filters.actor}
                    values={actors}
                    onChange={(actor) =>
                        setFilters((current) => ({ ...current, actor }))
                    }
                />
                <FilterSelect
                    label="Transport"
                    value={filters.transport}
                    values={transports}
                    onChange={(transport) =>
                        setFilters((current) => ({ ...current, transport }))
                    }
                />
                <FilterSelect
                    label="Group"
                    value={filters.group}
                    values={groups}
                    onChange={(group) =>
                        setFilters((current) => ({ ...current, group }))
                    }
                />
                <FilterSelect
                    label="Peer"
                    value={filters.peer}
                    values={peers}
                    onChange={(peer) =>
                        setFilters((current) => ({ ...current, peer }))
                    }
                />
                <FilterSelect
                    label="Selector"
                    value={filters.selector}
                    values={selectors}
                    onChange={(selector) =>
                        setFilters((current) => ({ ...current, selector }))
                    }
                />
                <FilterSelect
                    label="Severity"
                    value={filters.severity}
                    values={severities}
                    onChange={(severity) =>
                        setFilters((current) => ({ ...current, severity }))
                    }
                />
                <label className="field compact-field">
                    <span>Topic</span>
                    <input
                        value={filters.topic}
                        onChange={(event) =>
                            setFilters((current) => ({
                                ...current,
                                topic: event.target.value,
                            }))
                        }
                    />
                </label>
                <label className="field compact-field">
                    <span>Window</span>
                    <select
                        value={eventLimit}
                        onChange={(event) =>
                            setEventLimit(Number(event.target.value))
                        }
                    >
                        {[40, 100, 250, 500].map((limit) => (
                            <option key={limit} value={limit}>
                                {limit}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {hiddenCount > 0 && (
                <div className="event-window-status" role="status">
                    Showing the newest {visibleEvents.length} matching events.{' '}
                    {hiddenCount} older matching events are hidden by the
                    current window.
                </div>
            )}
            <div className="event-list">
                {visibleEvents.map((event) => (
                    <article className="event-row" key={event.eventId}>
                        <div className="event-topline">
                            <span
                                className={`pill ${event.severity === 'error' ? 'bad' : event.severity === 'warning' ? 'warn' : 'muted'}`}
                            >
                                {event.kind}
                            </span>
                            <strong>{event.topic}</strong>
                            <time>{formatTime(event.atEpochMs)}</time>
                        </div>
                        <div className="event-meta">
                            <span>{event.commandId ?? 'no command'}</span>
                            <span>{event.connection ?? 'no connection'}</span>
                            <span>{event.transport ?? 'runtime'}</span>
                        </div>
                    </article>
                ))}
            </div>
        </section>
    );
}

function RallarTracePanel({
    state,
    authSession,
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const now = useNow(1_000);
    const [sourceFilter, setSourceFilter] = useState<
        'all' | 'browser' | 'direct' | 'server'
    >('all');
    const [severityFilter, setSeverityFilter] = useState<
        'all' | RallarBlackBoxTestSeverity
    >('all');
    const [eventLimit, setEventLimit] = useState(100);
    const traceEvents = useMemo(
        () => selectRallarBlackBoxEvents(state).filter(isRallarTraceEvent),
        [state],
    );
    const filteredEvents = useMemo(
        () =>
            traceEvents.filter(
                (event) =>
                    (sourceFilter === 'all' ||
                        rallarTraceSource(event) === sourceFilter) &&
                    (severityFilter === 'all' ||
                        event.severity === severityFilter),
            ),
        [severityFilter, sourceFilter, traceEvents],
    );
    const visibleEvents = useMemo(
        () => filteredEvents.slice(-eventLimit).reverse(),
        [eventLimit, filteredEvents],
    );
    const eventIndexById = useMemo(
        () =>
            new Map(traceEvents.map((event, index) => [event.eventId, index])),
        [traceEvents],
    );
    const errorCount = traceEvents.filter(
        (event) => event.severity === 'error',
    ).length;
    const warningCount = traceEvents.filter(
        (event) => event.severity === 'warning',
    ).length;
    const hiddenCount = Math.max(
        0,
        filteredEvents.length - visibleEvents.length,
    );

    return (
        <section className="panel rallar-trace-panel">
            <div className="panel-heading">
                <h2>Rallar Trace</h2>
                <span>
                    {visibleEvents.length} of {filteredEvents.length} visible
                </span>
            </div>
            <div className="rallar-trace-toolbar">
                <Metric label="Events" value={String(traceEvents.length)} />
                <Metric
                    label="Errors"
                    value={String(errorCount)}
                    tone={errorCount > 0 ? 'bad' : 'good'}
                />
                <Metric
                    label="Warnings"
                    value={String(warningCount)}
                    tone={warningCount > 0 ? 'warn' : 'good'}
                />
                <label className="field compact-field">
                    <span>Source</span>
                    <select
                        value={sourceFilter}
                        onChange={(event) =>
                            setSourceFilter(
                                event.target.value as typeof sourceFilter,
                            )
                        }
                    >
                        {(['all', 'browser', 'direct', 'server'] as const).map(
                            (value) => (
                                <option key={value} value={value}>
                                    {value}
                                </option>
                            ),
                        )}
                    </select>
                </label>
                <label className="field compact-field">
                    <span>Severity</span>
                    <select
                        value={severityFilter}
                        onChange={(event) =>
                            setSeverityFilter(
                                event.target.value as typeof severityFilter,
                            )
                        }
                    >
                        {(
                            [
                                'all',
                                'debug',
                                'info',
                                'warning',
                                'error',
                            ] as const
                        ).map((value) => (
                            <option key={value} value={value}>
                                {value}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field compact-field">
                    <span>Window</span>
                    <select
                        value={eventLimit}
                        onChange={(event) =>
                            setEventLimit(Number(event.target.value))
                        }
                    >
                        {[50, 100, 250, 500].map((limit) => (
                            <option key={limit} value={limit}>
                                {limit}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {hiddenCount > 0 && (
                <div className="event-window-status" role="status">
                    Showing the newest {visibleEvents.length} matching trace
                    events. {hiddenCount} older matching events are hidden by
                    the current window.
                </div>
            )}
            <div className="rallar-trace-list">
                {visibleEvents.length === 0 && (
                    <div className="empty-state">No Rallar trace events</div>
                )}
                {visibleEvents.map((event) => {
                    const source = rallarTraceSource(event);
                    const eventIndex = eventIndexById.get(event.eventId) ?? -1;
                    const previousEvent =
                        eventIndex > 0
                            ? traceEvents[eventIndex - 1]
                            : undefined;
                    const tone =
                        event.severity === 'error'
                            ? 'bad'
                            : event.severity === 'warning'
                              ? 'warn'
                              : 'muted';
                    const detail =
                        event.severity === 'error' ||
                        event.severity === 'warning'
                            ? eventFailureText(event)
                            : eventPayloadText(event);
                    return (
                        <article
                            className="rallar-trace-row"
                            key={event.eventId}
                        >
                            <div className="event-topline">
                                <span className={`pill ${tone}`}>
                                    {event.severity ?? 'info'}
                                </span>
                                <strong>{event.topic}</strong>
                                <time>{formatTime(event.atEpochMs)}</time>
                            </div>
                            <div className="event-meta">
                                <span>source {source}</span>
                                <span>{event.kind}</span>
                                <span>{event.actor ?? 'no actor'}</span>
                                <span>
                                    {event.connection ?? 'no connection'}
                                </span>
                                <span>{event.transport ?? 'runtime'}</span>
                                <span>
                                    {traceTimingText(event, previousEvent, now)}
                                </span>
                                <span>{event.commandId ?? 'no command'}</span>
                                <span>{event.eventId}</span>
                            </div>
                            <pre className="rallar-trace-message">{detail}</pre>
                            <pre className="json-block rallar-trace-payload">
                                {redactedJson(
                                    event.payload ?? {},
                                    state,
                                    authSession,
                                )}
                            </pre>
                        </article>
                    );
                })}
            </div>
        </section>
    );
}

function StatsPanel({ state }: { state: RallarBlackBoxTestState }) {
    const stats = selectRallarBlackBoxLatestStats(state);
    const failures = selectRallarBlackBoxFailures(state);
    const latency = stats?.commandLatency;

    return (
        <section className="panel stats-panel">
            <div className="panel-heading">
                <h2>Stats</h2>
                <span>{formatTime(stats?.atEpochMs)}</span>
            </div>
            <div className="stats-grid">
                <Metric
                    label="Commands"
                    value={String(stats?.counters.commands ?? 0)}
                />
                <Metric
                    label="Events"
                    value={String(stats?.counters.events ?? 0)}
                />
                <Metric
                    label="Messages"
                    value={String(stats?.counters.messages ?? 0)}
                />
                <Metric
                    label="Diagnostics"
                    value={String(stats?.counters.diagnostics ?? 0)}
                />
                <Metric
                    label="Failures"
                    value={String(failures.length)}
                    tone={failures.length ? 'bad' : 'good'}
                />
                <Metric
                    label="Reconnects"
                    value={String(stats?.counters.reconnects ?? 0)}
                />
                <Metric
                    label="Last command"
                    value={stats?.lastCommandId ?? '-'}
                />
                <Metric
                    label="Peer count"
                    value={String(stats?.rallar?.peerCount ?? 0)}
                />
                <Metric
                    label="Lane health"
                    value={String(stats?.rallar?.laneHealth ?? 'unknown')}
                />
                <Metric
                    label="Avg latency"
                    value={formatDuration(latency?.averageMs)}
                />
                <Metric
                    label="Max latency"
                    value={formatDuration(latency?.maxMs)}
                />
            </div>
        </section>
    );
}

function FailurePanel({
    state,
    authSession,
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const firstFailure = selectRallarBlackBoxFirstFailure(state);

    return (
        <section className="panel failure-panel">
            <div className="panel-heading">
                <h2>Failure Focus</h2>
                <span className={`pill ${firstFailure ? 'bad' : 'good'}`}>
                    {firstFailure ? 'failed' : 'clear'}
                </span>
            </div>
            <div
                className={`failure-focus ${firstFailure ? 'has-failure' : ''}`}
            >
                <span>First failure</span>
                <strong>{firstFailure?.commandId ?? 'none'}</strong>
                <small>
                    {firstFailure?.error?.message ??
                        'No failed command recorded'}
                </small>
            </div>
            <pre className="json-block">
                {redactedJson(firstFailure ?? { ok: true }, state, authSession)}
            </pre>
        </section>
    );
}

function ReportPanel({
    state,
    authSession,
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const [visible, setVisible] = useState(false);
    const reportText = useMemo(
        () => redactedJson(createReportSnapshot(state), state, authSession),
        [authSession, state],
    );

    return (
        <section className="panel report-panel">
            <div className="panel-heading">
                <h2>Report Snapshot</h2>
                <button
                    type="button"
                    onClick={() => setVisible((current) => !current)}
                >
                    {visible ? 'Hide' : 'Show'}
                </button>
            </div>
            {visible && (
                <textarea
                    className="report-output"
                    value={reportText}
                    readOnly
                    spellCheck={false}
                />
            )}
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

function SharedTestCatalogPanel() {
    const catalog = RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG;
    const profileOptions = useMemo(
        () => uniqueValues(catalog.entries.flatMap((entry) => entry.profiles)),
        [catalog.entries],
    );
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const [selectedEntryId, setSelectedEntryId] = useState(
        catalog.entries[0]?.id ?? '',
    );
    const filteredEntries = useMemo(
        () =>
            catalog.entries.filter((entry) =>
                catalogEntryMatches(entry, query.trim(), profile),
            ),
        [catalog.entries, profile, query],
    );
    const selectedEntry =
        catalog.entries.find((entry) => entry.id === selectedEntryId) ??
        filteredEntries[0] ??
        catalog.entries[0];
    const liveCount = catalog.entries.filter(
        (entry) => entry.support.live,
    ).length;
    const replayCount = catalog.entries.filter(
        (entry) => entry.support.replayArtifacts,
    ).length;

    const copyText = (value: string): void => {
        void navigator.clipboard?.writeText(value);
    };

    return (
        <section className="panel shared-test-catalog-panel">
            <div className="panel-heading">
                <h2>Recipe Catalog</h2>
                <span>{filteredEntries.length} visible</span>
            </div>
            <div className="shared-test-summary-grid">
                <Metric label="Catalog" value={catalog.generatedFrom} />
                <Metric
                    label="Recipes"
                    value={String(catalog.entries.length)}
                />
                <Metric
                    label="Live gated"
                    value={String(liveCount)}
                    tone={liveCount > 0 ? 'active' : 'muted'}
                />
                <Metric
                    label="Replay"
                    value={String(replayCount)}
                    tone={replayCount > 0 ? 'good' : 'muted'}
                />
            </div>
            <div className="shared-test-filter-grid">
                <label className="field">
                    <span>Search</span>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="recipe, provider, profile"
                    />
                </label>
                <label className="field">
                    <span>Profile</span>
                    <select
                        value={profile}
                        onChange={(event) => setProfile(event.target.value)}
                    >
                        <option value="">All profiles</option>
                        {profileOptions.map((entry) => (
                            <option key={entry} value={entry}>
                                {entry}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <div className="shared-test-catalog-grid">
                <section className="shared-test-subpanel">
                    <div className="section-heading">
                        <h3>App-local Recipes</h3>
                        <span>{APP_LOCAL_RECIPE_CATALOG.length} recipes</span>
                    </div>
                    <div className="shared-test-card-list">
                        {APP_LOCAL_RECIPE_CATALOG.map((entry) => (
                            <article
                                className="shared-test-recipe-row"
                                key={entry.id}
                            >
                                <div>
                                    <strong>{entry.title}</strong>
                                    <small>{entry.path}</small>
                                </div>
                                <p>{entry.description}</p>
                                <div className="badge-list">
                                    <span className="pill active">
                                        {entry.providerMode}
                                    </span>
                                    <span className="pill good">
                                        {entry.expectedResult}
                                    </span>
                                </div>
                                <details>
                                    <summary>Requirements</summary>
                                    <ul>
                                        {entry.requirements.map(
                                            (requirement) => (
                                                <li key={requirement}>
                                                    {requirement}
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                </details>
                                <button
                                    type="button"
                                    onClick={() => copyText(entry.path)}
                                >
                                    Copy Path
                                </button>
                            </article>
                        ))}
                    </div>
                </section>
                <section className="shared-test-subpanel">
                    <div className="section-heading">
                        <h3>Shared-test Recipes</h3>
                        <span>{filteredEntries.length} entries</span>
                    </div>
                    <div className="shared-test-card-list">
                        {filteredEntries.length === 0 && (
                            <div className="empty-state">
                                No shared-test recipes match the filters
                            </div>
                        )}
                        {filteredEntries.map((entry) => (
                            <button
                                type="button"
                                key={entry.id}
                                className={`shared-test-catalog-row ${selectedEntry?.id === entry.id ? 'selected' : ''}`}
                                onClick={() => setSelectedEntryId(entry.id)}
                            >
                                <span>
                                    <strong>{entry.title}</strong>
                                    <small>{entry.recipePath}</small>
                                </span>
                                <span className="badge-list">
                                    {entry.category === 'rallar-crdt' && (
                                        <span className="pill good">CRDT</span>
                                    )}
                                    <span className="pill active">
                                        {entry.providerMode}
                                    </span>
                                    {entry.profiles.includes('live-crdt') && (
                                        <span className="pill warn">
                                            live-crdt
                                        </span>
                                    )}
                                    <span
                                        className={`pill ${entry.liveSupport === 'gated-live' ? 'warn' : 'good'}`}
                                    >
                                        {entry.liveSupport}
                                    </span>
                                </span>
                            </button>
                        ))}
                    </div>
                </section>
                <section className="shared-test-subpanel shared-test-detail-panel">
                    <div className="section-heading">
                        <h3>Selected Recipe</h3>
                        <span>{selectedEntry?.expectedResult ?? '-'}</span>
                    </div>
                    {selectedEntry ? (
                        <>
                            <dl className="config-list shared-test-detail-list">
                                <div>
                                    <dt>ID</dt>
                                    <dd>{selectedEntry.id}</dd>
                                </div>
                                <div>
                                    <dt>Provider</dt>
                                    <dd>{selectedEntry.providerMode}</dd>
                                </div>
                                <div>
                                    <dt>Category</dt>
                                    <dd>{selectedEntry.category}</dd>
                                </div>
                                <div>
                                    <dt>Mode</dt>
                                    <dd>{selectedEntry.executionMode}</dd>
                                </div>
                                <div>
                                    <dt>Artifact</dt>
                                    <dd>{selectedEntry.artifactName}</dd>
                                </div>
                                <div>
                                    <dt>Surface</dt>
                                    <dd>
                                        {
                                            selectedEntry.uiHints
                                                .recommendedSurface
                                        }
                                    </dd>
                                </div>
                            </dl>
                            <p className="shared-test-description">
                                {selectedEntry.description}
                            </p>
                            <div className="badge-list shared-test-badges">
                                {selectedEntry.uiHints.badges.map((badge) => (
                                    <span className="pill muted" key={badge}>
                                        {badge}
                                    </span>
                                ))}
                            </div>
                            <div className="shared-test-requirements">
                                <h3>Prerequisites</h3>
                                {catalogRequirements(selectedEntry).length ===
                                0 ? (
                                    <div className="empty-state">
                                        No live prerequisites
                                    </div>
                                ) : (
                                    <ul>
                                        {catalogRequirements(selectedEntry).map(
                                            (requirement) => (
                                                <li key={requirement}>
                                                    {requirement}
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                )}
                            </div>
                            <div className="shared-test-command-list">
                                <h3>Commands</h3>
                                {selectedEntry.commands.map((command) => (
                                    <article
                                        className="shared-test-command-row"
                                        key={command.label}
                                    >
                                        <div>
                                            <strong>{command.label}</strong>
                                            <small>{command.description}</small>
                                        </div>
                                        <pre className="mini-json">
                                            {command.command}
                                        </pre>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                copyText(command.command)
                                            }
                                        >
                                            Copy Command
                                        </button>
                                    </article>
                                ))}
                            </div>
                        </>
                    ) : (
                        <div className="empty-state">No recipe selected</div>
                    )}
                </section>
            </div>
        </section>
    );
}

function SharedTestArtifactImportPanel() {
    const [files, setFiles] =
        useState<RallarBlackBoxSharedTestArtifactBundleFiles>({});
    const [parseResult, setParseResult] = useState<
        | ReturnType<typeof parseRallarBlackBoxSharedTestArtifactBundle>
        | undefined
    >();
    const [readError, setReadError] = useState<string | undefined>();
    const parsed = parseResult?.value;
    const acceptedFileNames = new Set<string>(SHARED_TEST_ARTIFACT_FILE_NAMES);

    const parseFiles = (
        nextFiles: RallarBlackBoxSharedTestArtifactBundleFiles,
    ): void => {
        setFiles(nextFiles);
        setParseResult(parseRallarBlackBoxSharedTestArtifactBundle(nextFiles));
    };

    const handleFiles = async (
        event: ChangeEvent<HTMLInputElement>,
    ): Promise<void> => {
        setReadError(undefined);
        const selectedFiles = Array.from(event.target.files ?? []);
        const nextFiles: RallarBlackBoxSharedTestArtifactBundleFiles = {};

        try {
            for (const file of selectedFiles) {
                if (!acceptedFileNames.has(file.name)) {
                    continue;
                }
                nextFiles[
                    file.name as keyof RallarBlackBoxSharedTestArtifactBundleFiles
                ] = await file.text();
            }
            parseFiles(nextFiles);
        } catch (error) {
            setReadError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const copyReplayRecipe = (): void => {
        if (parsed?.views.replayRecipe) {
            void navigator.clipboard?.writeText(
                json(parsed.views.replayRecipe),
            );
        }
    };

    const loadedFiles = Object.keys(files).length;

    return (
        <section className="panel shared-test-artifact-panel">
            <div className="panel-heading">
                <h2>Artifact Import</h2>
                <span
                    className={`pill ${parseResult?.ok ? 'good' : parseResult ? 'bad' : 'muted'}`}
                >
                    {parseResult?.ok
                        ? 'valid'
                        : parseResult
                          ? 'invalid'
                          : 'idle'}
                </span>
            </div>
            <div className="artifact-import-controls">
                <label className="field">
                    <span>Artifact Files</span>
                    <input
                        type="file"
                        multiple
                        accept=".json,.jsonl,application/json"
                        onChange={(event) => void handleFiles(event)}
                    />
                </label>
                <button
                    type="button"
                    onClick={() => parseFiles(files)}
                    disabled={loadedFiles === 0}
                >
                    Validate Bundle
                </button>
            </div>
            <div className="artifact-file-grid">
                {SHARED_TEST_ARTIFACT_FILE_NAMES.map((fileName) => {
                    const required =
                        RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT.requiredFiles.includes(
                            fileName,
                        );
                    const loaded = files[fileName] !== undefined;
                    return (
                        <div
                            key={fileName}
                            className={`artifact-file-row ${loaded ? 'loaded' : ''}`}
                        >
                            <strong>{fileName}</strong>
                            <span
                                className={`pill ${loaded ? 'good' : required ? 'bad' : 'muted'}`}
                            >
                                {loaded
                                    ? 'loaded'
                                    : required
                                      ? 'required'
                                      : 'optional'}
                            </span>
                        </div>
                    );
                })}
            </div>
            {(readError || (parseResult && parseResult.issues.length > 0)) && (
                <div className="artifact-issue-list" role="status">
                    {readError && (
                        <div className="workbench-error">{readError}</div>
                    )}
                    {parseResult?.issues.map((issue, index) => (
                        <div
                            className={`artifact-issue-row ${issue.severity}`}
                            key={`${issue.severity}-${issue.file ?? 'bundle'}-${issue.path}-${index}`}
                        >
                            <strong>{issue.severity}</strong>
                            <span>{artifactIssueText(issue)}</span>
                        </div>
                    ))}
                </div>
            )}
            {parsed && (
                <div className="artifact-view-grid">
                    <section className="shared-test-subpanel artifact-summary-panel">
                        <div className="section-heading">
                            <h3>Imported Summary</h3>
                            <span>schema {parsed.schemaVersion}</span>
                        </div>
                        <div className="shared-test-summary-grid">
                            <Metric
                                label="Total"
                                value={String(parsed.report.summary.total)}
                            />
                            <Metric
                                label="Success"
                                value={String(parsed.report.summary.success)}
                                tone="good"
                            />
                            <Metric
                                label="Failure"
                                value={String(parsed.report.summary.failure)}
                                tone={
                                    parsed.report.summary.failure > 0
                                        ? 'bad'
                                        : 'good'
                                }
                            />
                            <Metric
                                label="Events"
                                value={String(parsed.views.eventStream.length)}
                            />
                            <Metric
                                label="RTC diagnostics"
                                value={String(
                                    parsed.views.rtcDiagnostics.length,
                                )}
                            />
                            <Metric
                                label="RTC messages"
                                value={String(parsed.views.rtcMessages.length)}
                            />
                            <Metric
                                label="WS messages"
                                value={String(parsed.views.wsMessages.length)}
                            />
                            <Metric
                                label="Replay"
                                value={
                                    parsed.views.replayRecipe
                                        ? 'available'
                                        : 'none'
                                }
                                tone={
                                    parsed.views.replayRecipe ? 'good' : 'muted'
                                }
                            />
                        </div>
                    </section>
                    <section className="shared-test-subpanel">
                        <div className="section-heading">
                            <h3>Imported Event Stream</h3>
                            <span>
                                {parsed.views.eventStream.length} events
                            </span>
                        </div>
                        <div className="artifact-event-list">
                            {parsed.views.eventStream
                                .slice(0, 24)
                                .map((event, index) => (
                                    <article
                                        className="event-row"
                                        key={`${event.kind}-${index}`}
                                    >
                                        <div className="event-topline">
                                            <span className="pill muted">
                                                {event.kind}
                                            </span>
                                            <strong>
                                                {artifactEventTitle(event)}
                                            </strong>
                                        </div>
                                        <div className="event-meta">
                                            <span>
                                                {artifactEventDetail(event)}
                                            </span>
                                        </div>
                                    </article>
                                ))}
                        </div>
                    </section>
                    <section className="shared-test-subpanel">
                        <div className="section-heading">
                            <h3>Imported RTC Diagnostics</h3>
                            <span>
                                {parsed.views.rtcDiagnostics.length} events
                            </span>
                        </div>
                        <pre className="json-block">
                            {json(parsed.views.rtcDiagnostics.slice(0, 12))}
                        </pre>
                    </section>
                    <section className="shared-test-subpanel">
                        <div className="section-heading">
                            <h3>Imported Failure Focus</h3>
                            <span>{parsed.views.failures.length} failures</span>
                        </div>
                        <pre className="json-block">
                            {json(parsed.views.failures.slice(0, 12))}
                        </pre>
                    </section>
                    {parsed.views.replayRecipe && (
                        <section className="shared-test-subpanel artifact-replay-panel">
                            <div className="section-heading">
                                <h3>Replay Recipe</h3>
                                <button
                                    type="button"
                                    onClick={copyReplayRecipe}
                                >
                                    Copy Replay
                                </button>
                            </div>
                            <pre className="json-block">
                                {json(parsed.views.replayRecipe)}
                            </pre>
                        </section>
                    )}
                </div>
            )}
        </section>
    );
}

function SharedTestPanel() {
    return (
        <div className="shared-test-stack">
            <SharedTestCatalogPanel />
            <SharedTestArtifactImportPanel />
            <section className="panel shared-test-coverage-panel">
                <div className="panel-heading">
                    <h2>Coverage Ownership</h2>
                    <span>
                        {RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF.length}{' '}
                        owners
                    </span>
                </div>
                <div className="coverage-owner-grid">
                    {RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF.map(
                        (owner) => (
                            <article
                                className="coverage-owner-row"
                                key={owner.owner}
                            >
                                <h3>{owner.owner}</h3>
                                <strong>Owns</strong>
                                <ul>
                                    {owner.owns.map((item) => (
                                        <li key={item}>{item}</li>
                                    ))}
                                </ul>
                                <strong>Does not own</strong>
                                <ul>
                                    {owner.doesNotOwn.map((item) => (
                                        <li key={item}>{item}</li>
                                    ))}
                                </ul>
                            </article>
                        ),
                    )}
                </div>
            </section>
        </div>
    );
}

function CommandCenterActionFeedbackPanel({
    feedback,
    state,
    authSession,
}: {
    feedback: CommandCenterActionFeedback;
    state?: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const tone =
        feedback.state === 'success'
            ? 'good'
            : feedback.state === 'error'
              ? 'bad'
              : feedback.state === 'running'
                ? 'active'
                : 'muted';
    const label =
        feedback.state === 'success'
            ? 'success'
            : feedback.state === 'error'
              ? 'failed'
              : feedback.state === 'running'
                ? 'running'
                : 'idle';
    const title =
        feedback.state === 'idle'
            ? 'No action run yet'
            : (feedback.label ?? 'Action');
    const targetText = feedback.target
        ? String(
              redactRallarBlackBoxValue(
                  feedback.target,
                  uiRedactionOptions(state, authSession),
              ),
          )
        : '-';
    const statusText =
        feedback.status !== undefined
            ? `${feedback.status} ${feedback.statusText ?? ''}`.trim()
            : (feedback.statusText ?? '-');
    const message = feedback.message
        ? String(
              redactRallarBlackBoxValue(
                  feedback.message,
                  uiRedactionOptions(state, authSession),
              ),
          )
        : feedback.state === 'running'
          ? 'Waiting for completion.'
          : feedback.state === 'idle'
            ? 'Run an operation to see live feedback.'
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
                    <dt>Target</dt>
                    <dd>{targetText}</dd>
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

function parseVariablesText(text: string):
    | Readonly<{
          ok: true;
          variables: Readonly<Record<string, unknown>>;
      }>
    | Readonly<{ ok: false; error: string }> {
    try {
        const parsed = JSON.parse(text) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? { ok: true, variables: parsed as Record<string, unknown> }
            : { ok: false, error: 'Variables JSON must be an object.' };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

const FLOW_STEP_BUTTONS: readonly FlowBuilderStepKind[] = [
    'auth.login',
    'rest.request',
    'ws.open',
    'ws.send',
    'rtc.connect',
    'rtc.send',
    'wait',
    'cleanup',
];

function flowStepCommandIds(
    recipeCommands: readonly RallarBlackBoxTestCommand[],
    stepId: string,
): readonly string[] {
    return recipeCommands
        .filter(
            (command) => recordValue(command.metadata?.flow).stepId === stepId,
        )
        .map(
            (command, index) =>
                command.commandId ?? `${command.kind}-${index + 1}`,
        );
}

function FlowBuilderPanel({
    state,
    authSession,
    globalValues,
    busy,
    onSelectCommand,
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    busy: boolean;
    onSelectCommand(commandId: string): void;
}) {
    const [templateId, setTemplateId] = useState(
        FLOW_BUILDER_TEMPLATES[0].templateId,
    );
    const [flowText, setFlowText] = useState(() =>
        templateFlowBuilderText(templateId),
    );
    const [variablesText, setVariablesText] = useState(() =>
        JSON.stringify(
            flowBuilderVariablesFromGlobalValues(
                FLOW_BUILDER_TEMPLATES[0].flow.variables,
                globalValues,
            ),
            null,
            2,
        ),
    );
    const [variablesEdited, setVariablesEdited] = useState(false);
    const [sequence, setSequence] = useState(1);
    const [localError, setLocalError] = useState<string | undefined>();
    const flowResult = useMemo(
        () => parseFlowBuilderDefinition(flowText),
        [flowText],
    );
    const variablesResult = useMemo(
        () => parseVariablesText(variablesText),
        [variablesText],
    );
    const recipe = useMemo(() => {
        if (!flowResult.ok || !variablesResult.ok) {
            return undefined;
        }

        return buildFlowBuilderRecipe(
            flowResult.flow,
            variablesResult.variables,
        );
    }, [flowResult, variablesResult]);
    const runnerScenario = useMemo(() => {
        if (!flowResult.ok || !variablesResult.ok) {
            return undefined;
        }

        return buildFlowBuilderRunnerScenario(
            flowResult.flow,
            variablesResult.variables,
        );
    }, [flowResult, variablesResult]);
    const parseError = !flowResult.ok
        ? flowResult.error
        : !variablesResult.ok
          ? variablesResult.error
          : undefined;
    const recipeText = recipe
        ? redactedJson(recipe, state, authSession)
        : (parseError ?? 'No recipe preview available.');
    const runnerText = runnerScenario
        ? redactedJson(runnerScenario, state, authSession)
        : recipeText;
    const recipeValidation = useMemo(
        () =>
            recipe ? validateSchemaAuthoringValue('recipe', recipe) : undefined,
        [recipe],
    );
    const runnerValidation = useMemo(
        () =>
            runnerScenario
                ? validateSchemaAuthoringValue(
                      'runner-scenario',
                      runnerScenario,
                  )
                : undefined,
        [runnerScenario],
    );

    const selectTemplate = (nextTemplateId: string): void => {
        const template =
            FLOW_BUILDER_TEMPLATES.find(
                (entry) => entry.templateId === nextTemplateId,
            ) ?? FLOW_BUILDER_TEMPLATES[0];
        setTemplateId(template.templateId);
        setFlowText(flowBuilderText(template.flow));
        setVariablesText(
            JSON.stringify(
                flowBuilderVariablesFromGlobalValues(
                    template.flow.variables,
                    globalValues,
                ),
                null,
                2,
            ),
        );
        setVariablesEdited(false);
        setLocalError(undefined);
    };

    useEffect(() => {
        if (variablesEdited) {
            return;
        }

        const template =
            FLOW_BUILDER_TEMPLATES.find(
                (entry) => entry.templateId === templateId,
            ) ?? FLOW_BUILDER_TEMPLATES[0];
        setVariablesText(
            JSON.stringify(
                flowBuilderVariablesFromGlobalValues(
                    template.flow.variables,
                    globalValues,
                ),
                null,
                2,
            ),
        );
    }, [
        globalValues?.apiBaseUrl,
        globalValues?.applicationId,
        globalValues?.clientId,
        globalValues?.roomId,
        globalValues?.sessionId,
        globalValues?.workspaceId,
        templateId,
        variablesEdited,
    ]);

    const addStep = (kind: FlowBuilderStepKind): void => {
        if (!flowResult.ok) {
            setLocalError(flowResult.error);
            return;
        }

        setFlowText(flowBuilderText(addFlowBuilderStep(flowResult.flow, kind)));
    };

    const normalizeFlowJson = (): void => {
        if (!flowResult.ok) {
            setLocalError(flowResult.error);
            return;
        }

        setFlowText(flowBuilderText(flowResult.flow));
        setLocalError(undefined);
    };

    const runFlow = async (): Promise<void> => {
        setLocalError(undefined);
        if (!recipe) {
            setLocalError(parseError ?? 'No flow recipe is available.');
            return;
        }

        const commandId = `flow-builder-run-${sequence}`;
        setSequence((current) => current + 1);
        onSelectCommand(commandId);
        try {
            await rallarBlackBoxRuntimeStore.executeManualCommands(
                [
                    {
                        kind: 'recipe.run',
                        commandId,
                        label: `Run ${recipe.name ?? recipe.recipeId}`,
                        recipe,
                    },
                ],
                'Run Flow Builder',
            );
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const copyText = (text: string): void => {
        void navigator.clipboard?.writeText(text);
    };

    const flow = flowResult.ok ? flowResult.flow : undefined;
    return (
        <section className="panel flow-builder-panel">
            <div className="panel-heading">
                <h2>Flow Builder</h2>
                <span className={`pill ${parseError ? 'bad' : 'good'}`}>
                    {parseError
                        ? 'invalid'
                        : `${recipe?.commands.length ?? 0} commands`}
                </span>
            </div>
            <div className="flow-builder-toolbar">
                <label className="field">
                    <span>Template</span>
                    <select
                        value={templateId}
                        onChange={(event) => selectTemplate(event.target.value)}
                        disabled={busy}
                    >
                        {FLOW_BUILDER_TEMPLATES.map((template) => (
                            <option
                                key={template.templateId}
                                value={template.templateId}
                            >
                                {template.label}
                            </option>
                        ))}
                    </select>
                </label>
                <button type="button" onClick={normalizeFlowJson}>
                    Normalize JSON
                </button>
                <button
                    type="button"
                    onClick={() => void runFlow()}
                    disabled={busy || !recipe}
                >
                    Run Flow
                </button>
                <button
                    type="button"
                    onClick={() => copyText(recipeText)}
                    disabled={!recipe}
                >
                    Copy SPA Recipe
                </button>
                <button
                    type="button"
                    onClick={() => copyText(runnerText)}
                    disabled={!runnerScenario}
                >
                    Copy Runner Scenario
                </button>
            </div>
            <div className="flow-builder-add-grid" aria-label="Add flow step">
                {FLOW_STEP_BUTTONS.map((kind) => (
                    <button
                        key={kind}
                        type="button"
                        onClick={() => addStep(kind)}
                        disabled={busy}
                    >
                        Add {kind}
                    </button>
                ))}
            </div>
            <div className="flow-builder-editors">
                <label className="json-editor">
                    <span>Variables JSON</span>
                    <textarea
                        value={variablesText}
                        onChange={(event) => {
                            setVariablesEdited(true);
                            setVariablesText(event.target.value);
                        }}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
                <label className="json-editor">
                    <span>Flow JSON</span>
                    <textarea
                        value={flowText}
                        onChange={(event) => setFlowText(event.target.value)}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
            </div>
            {(parseError || localError) && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError ?? parseError,
                        uiRedactionOptions(state, authSession),
                    )}
                </div>
            )}
            <div className="flow-builder-layout">
                <section className="flow-builder-steps">
                    <div className="section-heading">
                        <h3>Steps</h3>
                        <span>{flow?.steps.length ?? 0} steps</span>
                    </div>
                    <div className="flow-step-list">
                        {!flow && (
                            <div className="empty-state">
                                No valid flow loaded
                            </div>
                        )}
                        {flow?.steps.map((step) => {
                            const commandIds = recipe
                                ? flowStepCommandIds(
                                      recipe.commands,
                                      step.stepId,
                                  )
                                : [];
                            const results = commandIds
                                .map(
                                    (commandId) => state.resultCache[commandId],
                                )
                                .filter(
                                    (
                                        result,
                                    ): result is RallarBlackBoxTestResult =>
                                        Boolean(result),
                                );
                            const failed = results.find((result) => !result.ok);
                            const completed =
                                commandIds.length > 0 &&
                                results.length === commandIds.length;
                            const status = failed
                                ? 'failed'
                                : completed
                                  ? 'completed'
                                  : step.enabled === false
                                    ? 'skipped'
                                    : 'pending';
                            return (
                                <article
                                    className="flow-step-row"
                                    key={step.stepId}
                                >
                                    <div>
                                        <strong>{step.label}</strong>
                                        <small>
                                            {step.stepId} - {step.kind}
                                        </small>
                                    </div>
                                    <span
                                        className={`pill ${status === 'completed' ? 'good' : statusTone(status)}`}
                                    >
                                        {status}
                                    </span>
                                    <div className="manual-command-links">
                                        {commandIds.map((commandId) => (
                                            <button
                                                type="button"
                                                key={commandId}
                                                onClick={() =>
                                                    onSelectCommand(commandId)
                                                }
                                            >
                                                {commandId}
                                            </button>
                                        ))}
                                    </div>
                                    {(step.expect !== undefined ||
                                        step.extract !== undefined) && (
                                        <pre className="mini-json">
                                            {redactedJson(
                                                {
                                                    expect: step.expect,
                                                    extract: step.extract,
                                                },
                                                state,
                                                authSession,
                                            )}
                                        </pre>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                </section>
                <section className="flow-builder-preview">
                    <div className="section-heading">
                        <h3>SPA Recipe Preview</h3>
                        <span>{recipe?.recipeId ?? '-'}</span>
                    </div>
                    <pre className="json-block">{recipeText}</pre>
                    {recipeValidation && (
                        <SchemaAuthoringPanel validation={recipeValidation} />
                    )}
                </section>
                <section className="flow-builder-preview">
                    <div className="section-heading">
                        <h3>Runner Scenario Preview</h3>
                        <span>black-box-runner</span>
                    </div>
                    <pre className="json-block">{runnerText}</pre>
                    {runnerValidation && (
                        <SchemaAuthoringPanel validation={runnerValidation} />
                    )}
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
                    <ManualRallarWorkbenchPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        globalValuesEdited={globalValuesEdited}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                        onGlobalValueChange={updateGlobalValue}
                    />
                    <ReceivedDataInboxPanel
                        state={state}
                        onSelectCommand={setSelectedCommandId}
                    />
                    <CommandHistoryPanel
                        history={history}
                        selectedCommandId={selectedCommandId}
                        onSelect={setSelectedCommandId}
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
                    <WorkbenchPanel
                        busy={busy}
                        runState={runState}
                        loadedFixtureId={loadedFixtureId}
                        lastError={lastError}
                    />
                    <ControlPanel state={state} control={control} />
                    <BootstrapPanel bootstrap={bootstrap} />
                    <ConfigurationPanel state={state} />
                    <CommandQueuePanel
                        rows={queueRows}
                        selectedCommandId={selectedCommandId}
                        onSelect={setSelectedCommandId}
                    />
                    <ReportPanel state={state} authSession={authSession} />
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
