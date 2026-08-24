import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSourceFile, type SourceAnalysis } from '../helpers/source-analysis';

type ExportSnapshot = Readonly<{
    values: readonly string[];
    types: readonly string[];
    starExports: readonly string[];
    namespaceExports: readonly string[];
}>;

type PublicSurfaceSnapshot = Readonly<{
    filePath: string;
    resolveStarExports?: boolean;
    expected: ExportSnapshot;
}>;

const PUBLIC_SURFACES: readonly PublicSurfaceSnapshot[] = [
    {
        filePath: 'packages/shared-web/browser/rallar.ts',
        expected: {
            values: [
                'createRallarCrdtFacade',
                'createRallarDataFacade',
                'createRallarFacade',
                'defineRallarDataStore',
                'evaluateRallarReadinessExpectation',
                'matchesRallarMessageSelector',
                'normalizeRallarMessageSelector',
                'normalizeRallarReadinessExpectation',
                'rallar'
            ],
            types: [
                'RallarAuthChangeListener',
                'RallarAuthChangeReason',
                'RallarAuthState',
                'RallarCallDataInput',
                'RallarCallEndOptions',
                'RallarCallHandle',
                'RallarCallInviteInput',
                'RallarCallInviteListener',
                'RallarCallInviteResult',
                'RallarCallMediaInput',
                'RallarCallParticipantState',
                'RallarCallParticipantStatus',
                'RallarCallSignalEvent',
                'RallarCallSignalKind',
                'RallarCallSignalListener',
                'RallarCallSignalPayload',
                'RallarCallSignalSend',
                'RallarCallStartInput',
                'RallarCallState',
                'RallarCallStatus',
                'RallarCallWaitOptions',
                'RallarCameraSourceStartOptions',
                'RallarConnectStatus',
                'RallarCrdtDocument',
                'RallarCrdtFacade',
                'RallarCrdtFacadeDefaults',
                'RallarCrdtOpenOptions',
                'RallarCrdtOpenScope',
                'RallarCrdtSnapshotListener',
                'RallarCreateRoomInput',
                'RallarDataChangeEvent',
                'RallarDataChangeListener',
                'RallarDataDurability',
                'RallarDataFacade',
                'RallarDataHydration',
                'RallarDataMigration',
                'RallarDataMigrationContext',
                'RallarDataScope',
                'RallarDataStorageEstimate',
                'RallarDataStore',
                'RallarDataStoreDefinition',
                'RallarDataStoreOptions',
                'RallarDefaults',
                'RallarDirectorAppointOptions',
                'RallarDirectorRelayConfig',
                'RallarDirectorRelayEnvelope',
                'RallarDirectorRelayHandle',
                'RallarDirectorRelayMessage',
                'RallarDirectorRelaySendResult',
                'RallarDirectorRelaySendStatus',
                'RallarDirectorResignOptions',
                'RallarDirectorRole',
                'RallarDirectorState',
                'RallarDirectorStatus',
                'RallarDirectorStatusListener',
                'RallarDirectorStatusOptions',
                'RallarFacade',
                'RallarFlow',
                'RallarFlowPolicies',
                'RallarIncomingCallInvite',
                'RallarJoinRoomInput',
                'RallarJoinRoomOptions',
                'RallarLeaveRoomOptions',
                'RallarListPeopleEventsOptions',
                'RallarListRoomEventsInput',
                'RallarListRoomEventsOptions',
                'RallarMediaSourceAttachOptions',
                'RallarMediaSourceController',
                'RallarMediaSourceHandle',
                'RallarMediaSourceKind',
                'RallarMediaSourceState',
                'RallarMediaSourceStatus',
                'RallarMediaSourcesFacade',
                'RallarMessage',
                'RallarMessageHandler',
                'RallarMessageLane',
                'RallarMessageSelector',
                'RallarMessageSelectorInput',
                'RallarMessageSendBase',
                'RallarMessageSendResult',
                'RallarMessageSendStatus',
                'RallarMessageTransport',
                'RallarMicrophoneSourceStartOptions',
                'RallarNormalizedReadinessExpectation',
                'RallarOnChangeOptions',
                'RallarOperationOptions',
                'RallarOperationRetryPredicate',
                'RallarPeopleEventListener',
                'RallarPeopleEventOptions',
                'RallarPeopleState',
                'RallarPerson',
                'RallarReadinessEvaluation',
                'RallarReadinessExpectation',
                'RallarReadinessStatus',
                'RallarRealtimeBinarySendInput',
                'RallarRealtimeHandler',
                'RallarRealtimeHealthOptions',
                'RallarRealtimeJsonLane',
                'RallarRealtimeJsonLaneDefaults',
                'RallarRealtimeJsonLaneSendOptions',
                'RallarRealtimeJsonSendInput',
                'RallarRealtimeLaneHealth',
                'RallarRealtimeMessage',
                'RallarRealtimeSendOptions',
                'RallarRealtimeSendResult',
                'RallarRefreshOptions',
                'RallarRegisterOptions',
                'RallarRemoteStream',
                'RallarReplayEventsResult',
                'RallarReplayPeopleEventsOptions',
                'RallarReplayRoomEventsInput',
                'RallarReplayRoomEventsOptions',
                'RallarRoomEventListener',
                'RallarRoomEventOptions',
                'RallarRoomGovernanceOptions',
                'RallarRoomInviteOptions',
                'RallarRoomLifecycleOptions',
                'RallarRoomMember',
                'RallarRoomMessageChannel',
                'RallarRoomMessageChannelDefinition',
                'RallarRoomPresenceWaitOptions',
                'RallarRoomPresenceWaitResult',
                'RallarRoomRealtimeJsonChannel',
                'RallarRoomRealtimeJsonDefaults',
                'RallarRoomRealtimeJsonSendOptions',
                'RallarRoomRealtimeSendResult',
                'RallarRoomRealtimeSendStatus',
                'RallarRoomRealtimeTransportOptions',
                'RallarRoomSession',
                'RallarRoomSessionMessageDefinition',
                'RallarRoomSessionRealtimeInput',
                'RallarRoomState',
                'RallarRoomSummary',
                'RallarRoomSwitchOperation',
                'RallarRoomSwitchPartialFailureError',
                'RallarRoomTargetInput',
                'RallarRoomTransportState',
                'RallarRoomTransportStatus',
                'RallarRtcCandidateDiagnostics',
                'RallarRtcCandidatePairDiagnostics',
                'RallarRtcDiagnostics',
                'RallarRtcDiagnosticsOptions',
                'RallarRtcLaneStatus',
                'RallarRtcLifecycleEvent',
                'RallarRtcLifecycleKind',
                'RallarRtcLifecycleListener',
                'RallarRtcPeerConnectionStatus',
                'RallarRtcPeerDiagnostics',
                'RallarRtcPeerStatus',
                'RallarRtcReconnectOptions',
                'RallarRtcRecoveryResult',
                'RallarRtcRecoveryStatus',
                'RallarRtcRoomLaneWaitOptions',
                'RallarRtcRoomLaneWaitResult',
                'RallarRtcRoomLaneWaitStatus',
                'RallarRtcRoomMode',
                'RallarRtcRoomTransportOptions',
                'RallarRtcSendInput',
                'RallarRtcStatus',
                'RallarRtcStatusListener',
                'RallarRtcStatusOptions',
                'RallarRtcStatusSubscriptionOptions',
                'RallarRtcWaitForOpenOptions',
                'RallarRtcWaitForOpenResult',
                'RallarScopedOperationOptions',
                'RallarScreenSourceStartOptions',
                'RallarSetupInput',
                'RallarStartOptions',
                'RallarStartResult',
                'RallarStateEventListener',
                'RallarStateListener',
                'RallarStatsFacade',
                'RallarStatsGroupInput',
                'RallarStatsReadOptions',
                'RallarSubscriptionScope',
                'RallarTargetMembership',
                'RallarTargetSelector',
                'RallarTargetedChannel',
                'RallarTargetedChannelDefinition',
                'RallarTargetedChannelSendOptions',
                'RallarTargetedSendResult',
                'RallarTargetedSendStatus',
                'RallarTypedMessageChannel',
                'RallarTypedMessageChannelDefinition',
                'RallarTypedMessageSendOptions',
                'RallarTypedMessageSendStrategy',
                'RallarTypedPayloadHandler',
                'RallarTypedRtcSendOptions',
                'RallarTypedWsSendOptions',
                'RallarUnsubscribe',
                'RallarUpdateRoomInput',
                'RallarWaitForOpenOptions',
                'RallarWaitForOpenStatus',
                'RallarWsLifecycleEvent',
                'RallarWsLifecycleKind',
                'RallarWsLifecycleListener',
                'RallarWsReadyState',
                'RallarWsSendInput',
                'RallarWsStatus',
                'RallarWsStatusListener',
                'RallarWsStatusSubscriptionOptions',
                'RallarWsWaitForOpenResult'
            ],
            starExports: [],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/browser/rallar-core.ts',
        expected: {
            values: [
                'configureApiClient',
                'createRallarMessagesFacade',
                'createRallarPeopleFacade',
                'createRallarRoomsFacade',
                'createRallarStatsFacade',
                'matchesRallarMessageSelector',
                'normalizeApiBaseUrl',
                'normalizeRallarMessageSelector',
                'readApiBaseUrl'
            ],
            types: [
                'CreateRallarMessagesFacadeOptions',
                'CreateRallarPeopleFacadeOptions',
                'CreateRallarRoomsFacadeOptions',
                'CreateRallarStatsFacadeOptions',
                'RallarApiClientConfig',
                'RallarAuthChangeListener',
                'RallarAuthChangeReason',
                'RallarAuthFacade',
                'RallarAuthState',
                'RallarConnectStatus',
                'RallarConnectionFacade',
                'RallarConnectionOperations',
                'RallarCreateRoomInput',
                'RallarDefaults',
                'RallarFlow',
                'RallarFlowPolicies',
                'RallarJoinRoomOptions',
                'RallarLeaveRoomOptions',
                'RallarListPeopleEventsOptions',
                'RallarListRoomEventsInput',
                'RallarListRoomEventsOptions',
                'RallarMessage',
                'RallarMessageHandler',
                'RallarMessageLane',
                'RallarMessageSelector',
                'RallarMessageSelectorInput',
                'RallarMessageSendBase',
                'RallarMessageSendResult',
                'RallarMessageSendStatus',
                'RallarMessageTransport',
                'RallarMessagesFacade',
                'RallarOnChangeOptions',
                'RallarOperationOptions',
                'RallarOperationRetryPredicate',
                'RallarPeopleEventListener',
                'RallarPeopleEventOptions',
                'RallarPeopleFacade',
                'RallarPeopleState',
                'RallarPerson',
                'RallarRefreshOptions',
                'RallarRegisterOptions',
                'RallarReplayEventsResult',
                'RallarReplayPeopleEventsOptions',
                'RallarReplayRoomEventsInput',
                'RallarReplayRoomEventsOptions',
                'RallarRoomEventListener',
                'RallarRoomEventOptions',
                'RallarRoomMember',
                'RallarRoomMessageChannel',
                'RallarRoomMessageChannelDefinition',
                'RallarRoomSession',
                'RallarRoomSessionMessageDefinition',
                'RallarRoomSessionRealtimeInput',
                'RallarRoomState',
                'RallarRoomSummary',
                'RallarRoomSwitchOperation',
                'RallarRoomSwitchPartialFailureError',
                'RallarRoomsFacade',
                'RallarRtcSendInput',
                'RallarScopedOperationOptions',
                'RallarSetupInput',
                'RallarStartOptions',
                'RallarStartResult',
                'RallarStateEventListener',
                'RallarStateListener',
                'RallarStatsFacade',
                'RallarSubscriptionScope',
                'RallarTypedMessageChannel',
                'RallarTypedMessageChannelDefinition',
                'RallarTypedMessageSendOptions',
                'RallarTypedMessageSendStrategy',
                'RallarTypedPayloadHandler',
                'RallarTypedRtcSendOptions',
                'RallarTypedWsSendOptions',
                'RallarUnsubscribe',
                'RallarWsSendInput'
            ],
            starExports: [],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/browser/rallar-realtime.ts',
        expected: {
            values: [
                'createRallarRealtimeFacade',
                'createRallarRtcFacade'
            ],
            types: [
                'CreateRallarRealtimeFacadeOptions',
                'CreateRallarRtcFacadeOptions',
                'RallarRealtimeBinarySendInput',
                'RallarRealtimeFacade',
                'RallarRealtimeHandler',
                'RallarRealtimeHealthOptions',
                'RallarRealtimeJsonLane',
                'RallarRealtimeJsonLaneDefaults',
                'RallarRealtimeJsonLaneSendOptions',
                'RallarRealtimeJsonSendInput',
                'RallarRealtimeLaneHealth',
                'RallarRealtimeMessage',
                'RallarRealtimeSendOptions',
                'RallarRealtimeSendResult',
                'RallarRoomRealtimeJsonChannel',
                'RallarRoomRealtimeJsonDefaults',
                'RallarRoomRealtimeJsonSendOptions',
                'RallarRoomRealtimeSendResult',
                'RallarRoomRealtimeSendStatus',
                'RallarRoomRealtimeTransportOptions',
                'RallarRoomTransportState',
                'RallarRoomTransportStatus',
                'RallarRtcCandidateDiagnostics',
                'RallarRtcCandidatePairDiagnostics',
                'RallarRtcDiagnostics',
                'RallarRtcDiagnosticsOptions',
                'RallarRtcFacade',
                'RallarRtcLaneStatus',
                'RallarRtcLifecycleEvent',
                'RallarRtcLifecycleKind',
                'RallarRtcLifecycleListener',
                'RallarRtcPeerConnectionStatus',
                'RallarRtcPeerDiagnostics',
                'RallarRtcPeerStatus',
                'RallarRtcReconnectOptions',
                'RallarRtcRecoveryResult',
                'RallarRtcRecoveryStatus',
                'RallarRtcRoomLaneWaitOptions',
                'RallarRtcRoomLaneWaitResult',
                'RallarRtcRoomLaneWaitStatus',
                'RallarRtcRoomMode',
                'RallarRtcRoomTransportOptions',
                'RallarRtcStatus',
                'RallarRtcStatusListener',
                'RallarRtcStatusOptions',
                'RallarRtcStatusSubscriptionOptions',
                'RallarRtcWaitForOpenOptions',
                'RallarRtcWaitForOpenResult',
                'RallarWaitForOpenOptions',
                'RallarWaitForOpenStatus'
            ],
            starExports: [
                '@shared-web/browser/rallar-core.ts'
            ],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/browser/rallar-media-calls.ts',
        expected: {
            values: [
                'createRallarCallsFacade',
                'createRallarMediaFacade'
            ],
            types: [
                'CreateRallarCallsFacadeOptions',
                'CreateRallarMediaFacadeOptions',
                'RallarCallDataInput',
                'RallarCallEndOptions',
                'RallarCallHandle',
                'RallarCallInviteInput',
                'RallarCallInviteListener',
                'RallarCallInviteResult',
                'RallarCallMediaInput',
                'RallarCallParticipantState',
                'RallarCallParticipantStatus',
                'RallarCallSignalEvent',
                'RallarCallSignalKind',
                'RallarCallSignalListener',
                'RallarCallSignalPayload',
                'RallarCallSignalSend',
                'RallarCallStartInput',
                'RallarCallState',
                'RallarCallStatus',
                'RallarCallWaitOptions',
                'RallarCallsFacade',
                'RallarCameraSourceStartOptions',
                'RallarIncomingCallInvite',
                'RallarMediaFacade',
                'RallarMediaSourceAttachOptions',
                'RallarMediaSourceController',
                'RallarMediaSourceHandle',
                'RallarMediaSourceKind',
                'RallarMediaSourceState',
                'RallarMediaSourceStatus',
                'RallarMediaSourcesFacade',
                'RallarMicrophoneSourceStartOptions',
                'RallarRemoteStream',
                'RallarScreenSourceStartOptions',
                'RallarUnsubscribe'
            ],
            starExports: [],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/browser/rallar-data.ts',
        expected: {
            values: [
                'createRallarDataFacade',
                'defineRallarDataStore'
            ],
            types: [
                'RallarDataChangeEvent',
                'RallarDataChangeListener',
                'RallarDataDurability',
                'RallarDataFacade',
                'RallarDataFacadeOptions',
                'RallarDataHydration',
                'RallarDataMigration',
                'RallarDataMigrationContext',
                'RallarDataScope',
                'RallarDataStorageEstimate',
                'RallarDataStore',
                'RallarDataStoreDefinition',
                'RallarDataStoreOptions',
                'RallarUnsubscribe'
            ],
            starExports: [],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/browser/rallar-crdt.ts',
        expected: {
            values: [
                'createRallarCrdtFacade'
            ],
            types: [
                'RallarCrdtCounterAddInput',
                'RallarCrdtDocument',
                'RallarCrdtFacade',
                'RallarCrdtFacadeDefaults',
                'RallarCrdtFacadeOptions',
                'RallarCrdtHttpCatchUpClient',
                'RallarCrdtNumberMergeInput',
                'RallarCrdtNumericMutationOptions',
                'RallarCrdtOpenOptions',
                'RallarCrdtOpenScope',
                'RallarCrdtSequenceDeleteInput',
                'RallarCrdtSequenceInsertInput',
                'RallarCrdtSequenceMoveInput',
                'RallarCrdtSequenceMutationOptions',
                'RallarCrdtSnapshotListener',
                'RallarCrdtUndoRedoGroupInput'
            ],
            starExports: [],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/game/mod.ts',
        resolveStarExports: true,
        expected: {
            values: [
                'DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS',
                'DEFAULT_RALLAR_GAME_LANE_IDS',
                'RALLAR_GAME_CANNOT_HOST_SCORE',
                'RALLAR_GAME_MISSING_CAPABILITY_SCORE',
                'createRallarAuthorityBrowserMatch',
                'createRallarBrowserMatch',
                'createRallarGameAuthorityClient',
                'createRallarGameEnvelope',
                'createRallarGameLanePresets',
                'createRallarGameMatch',
                'createRallarGameSequenceTracker',
                'deriveRallarGameDiagnostics',
                'electRallarGameHost',
                'isRallarGameEnvelope',
                'resolveRallarGameLaneIds',
                'resolveRallarGameTypeIds',
                'scoreRallarGameHostCapability'
            ],
            types: [
                'RallarAuthorityBrowserMatchConfig',
                'RallarAuthorityBrowserMatchDependencies',
                'RallarAuthorityBrowserMatchHandle',
                'RallarBrowserMatchConfig',
                'RallarBrowserMatchDependencies',
                'RallarBrowserMatchHandle',
                'RallarGameAuthorityClientConfig',
                'RallarGameAuthorityClientHandle',
                'RallarGameAuthorityClientRallarFacade',
                'RallarGameAuthorityPeerAssistOptions',
                'RallarGameCapabilityMessage',
                'RallarGameDiagnostics',
                'RallarGameDiagnosticsInput',
                'RallarGameDirectorAppointmentContext',
                'RallarGameDirectorAppointmentDiagnostics',
                'RallarGameDirectorAppointmentEligibility',
                'RallarGameDirectorAppointmentEligibilityStatus',
                'RallarGameDirectorAppointmentPolicy',
                'RallarGameDirectorAuthority',
                'RallarGameEgressState',
                'RallarGameEgressStatus',
                'RallarGameEnvelope',
                'RallarGameEnvelopeCreateInput',
                'RallarGameEnvelopeHandler',
                'RallarGameEnvelopeKind',
                'RallarGameEnvelopeRejectReason',
                'RallarGameHostAppointResult',
                'RallarGameHostCandidate',
                'RallarGameHostCandidateReason',
                'RallarGameHostCapability',
                'RallarGameHostElectionInput',
                'RallarGameHostElectionResult',
                'RallarGameHostLease',
                'RallarGameLaneIds',
                'RallarGameLanePresetBuilder',
                'RallarGameLanePresetOptions',
                'RallarGameLaneReadyOptions',
                'RallarGameMatchConfig',
                'RallarGameMatchHandle',
                'RallarGameMatchPhase',
                'RallarGameMatchStatus',
                'RallarGamePeerReadiness',
                'RallarGamePresenceSendOptions',
                'RallarGameRallarFacade',
                'RallarGameRecoveryState',
                'RallarGameRuntimeRelay',
                'RallarGameSendResult',
                'RallarGameSequenceAcceptConstraints',
                'RallarGameSequenceAcceptResult',
                'RallarGameSequenceTracker',
                'RallarGameStatusHandler',
                'RallarGameTypeIds'
            ],
            starExports: [
                './authority-client.ts',
                './authority-match-support.ts',
                './diagnostics.ts',
                './election.ts',
                './envelopes.ts',
                './lanes.ts',
                './match-support.ts',
                './match.ts',
                './types.ts'
            ],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/browser/api/state-mutation-http-contracts.ts',
        expected: {
            values: [],
            types: [
                'AcceptStateGroupInviteBody',
                'AppointStateGroupDirectorBody',
                'BanStateGroupMemberBody',
                'ConnectStateClientSessionBody',
                'ConnectStateGroupPresenceSessionBody',
                'CreateStateGroupBody',
                'CreateStateGroupInviteBody',
                'DisconnectStateGroupPresenceSessionBody',
                'HeartbeatStateClientSessionBody',
                'HeartbeatStateGroupPresenceSessionBody',
                'JoinStateGroupBody',
                'PutStateGroupTopologyConfigBody',
                'PutStateGroupTopologyOverrideBody',
                'ReconfigureStateGroupTopologyBody',
                'RemoveStateGroupMemberBody',
                'RevokeStateGroupInviteBody',
                'RotateStateGroupJoinCodeBody',
                'SetStateGroupMemberRoleBody',
                'TransferStateGroupOwnershipBody',
                'UnbanStateGroupMemberBody',
                'UpdateStateGroupBody',
                'UpsertStateGroupMemberBody'
            ],
            starExports: [],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/browser/state-read/point-read.ts',
        expected: {
            values: ['readStateClientSnapshot', 'readStateGroupSnapshot'],
            types: [
                'ReadStateClientSnapshotOptions',
                'ReadStateGroupSnapshotOptions',
                'StateClientSnapshotRead',
                'StateGroupSnapshotRead'
            ],
            starExports: [],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/browser/state-read/diagnostics.ts',
        expected: {
            values: ['emitBrowserStateReadDiagnostic', 'setBrowserStateReadDiagnosticsSink'],
            types: ['BrowserStateReadDiagnosticEvent', 'BrowserStateReadDiagnosticsSink'],
            starExports: [],
            namespaceExports: []
        }
    },
    {
        filePath: 'packages/shared-web/mod.ts',
        expected: {
            values: [
                'DEFAULT_STATE_HEARTBEAT_TTL_MSECS',
                'appointStateGroupDirectorWorkflow',
                'archiveStateGroup',
                'banStateGroupMember',
                'createAndJoinStateGroup',
                'deleteStateGroup',
                'joinStateGroup',
                'leaveStateGroup',
                'refreshStateHeartbeat',
                'refreshStateSnapshots',
                'removeStateGroupMember',
                'setStateGroupMemberRole',
                'transferStateGroupOwnership',
                'unbanStateGroupMember',
                'updateStateGroupDetails',
                'updateStateGroupMetadata'
            ],
            types: [
                'ApiMutationRequestOptions',
                'ApiRequestOptions',
                'RefreshStateHeartbeatOptions',
                'RefreshStateHeartbeatResult',
                'StateGroupWorkflowValue',
                'StateHeartbeatWorkflowValue',
                'StateSnapshots',
                'StateSnapshotsWorkflowValue'
            ],
            starExports: [
                './browser/api-client-config.ts',
                './browser/api-integration.ts',
                './browser/api/http-error.ts',
                './browser/api/state-mutation-http-contracts.ts',
                './browser/app-context.ts',
                './browser/auth/agent-session-ticket-http-api.ts',
                './browser/auth/session-http-api.ts',
                './browser/auth/websocket-ticket-http-api.ts',
                './browser/browser-al-runtime-stores.ts',
                './browser/browser-cache-repositories.ts',
                './browser/browser-queuebox.ts',
                './browser/heartbeat.ts',
                './browser/middleware.ts',
                './browser/rallar-ai.ts',
                './browser/rallar-crdt-transport.ts',
                './browser/rallar-crdt.ts',
                './browser/rallar.ts',
                './browser/resilience-config.ts',
                './browser/rtc-engine.ts',
                './browser/rtc-message-router.ts',
                './browser/state-read/diagnostics.ts',
                './browser/ws-message-router.ts',
                './game/mod.ts'
            ],
            namespaceExports: [
                'dataCaches from ./browser/data-caches.ts',
                'qboxEngine from ./browser/qbox-engine.ts',
                'wsEngine from ./browser/ws-engine.ts'
            ]
        }
    }
];

describe('shared-web public API snapshots', () => {
    for (const surface of PUBLIC_SURFACES) {
        it(`keeps ${surface.filePath} exports intentional`, () => {
            expect(collectExportSnapshot(surface.filePath, {
                resolveStarExports: surface.resolveStarExports === true
            })).toEqual(surface.expected);
        });
    }
});

function collectExportSnapshot(
    filePath: string,
    options: Readonly<{ resolveStarExports: boolean; }>
): ExportSnapshot {
    const analysis = readSourceAnalysis(filePath);
    const direct = collectDirectExports(analysis);
    if (!options.resolveStarExports) {
        return direct;
    }

    const resolved = collectResolvedExports(filePath, new Set([filePath]));
    return {
        values: sortUnique([...direct.values, ...resolved.values]),
        types: sortUnique([...direct.types, ...resolved.types]),
        starExports: direct.starExports,
        namespaceExports: direct.namespaceExports
    };
}

function collectResolvedExports(
    filePath: string,
    seen: Set<string>
): Pick<ExportSnapshot, 'values' | 'types'> {
    const analysis = readSourceAnalysis(filePath);
    const direct = collectDirectExports(analysis);
    const values = [...direct.values];
    const types = [...direct.types];

    for (const specifier of direct.starExports) {
        const resolved = resolveLocalModule(filePath, specifier);
        if (!resolved || seen.has(resolved)) {
            continue;
        }

        seen.add(resolved);
        const child = collectResolvedExports(resolved, seen);
        values.push(...child.values);
        types.push(...child.types);
    }

    return {
        values: sortUnique(values),
        types: sortUnique(types)
    };
}

function collectDirectExports(analysis: SourceAnalysis): ExportSnapshot {
    const values: string[] = [];
    const types: string[] = [];
    const starExports: string[] = [];
    const namespaceExports: string[] = [];

    for (const entry of analysis.exports) {
        if (entry.kind === 'star' && entry.specifier) {
            starExports.push(entry.specifier);
            continue;
        }

        if (
            entry.kind === 'namespace' &&
            entry.exportedName &&
            entry.specifier
        ) {
            namespaceExports.push(
                `${entry.exportedName} from ${entry.specifier}`
            );
            continue;
        }

        const exportName = entry.kind === 'default'
            ? entry.localName
            : entry.exportedName;
        if (!exportName) {
            continue;
        }

        if (entry.typeOnly) {
            types.push(exportName);
        }
        else {
            values.push(exportName);
        }
    }

    return {
        values: sortUnique(values),
        types: sortUnique(types),
        starExports: sortUnique(starExports),
        namespaceExports: sortUnique(namespaceExports)
    };
}

function readSourceAnalysis(filePath: string): SourceAnalysis {
    return analyzeSourceFile(toAbsolutePath(filePath));
}

function resolveLocalModule(filePath: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) {
        return undefined;
    }
    return path.relative(
        process.cwd(),
        path.resolve(path.dirname(toAbsolutePath(filePath)), specifier)
    );
}

function toAbsolutePath(filePath: string): string {
    return path.resolve(process.cwd(), filePath);
}

function sortUnique(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort();
}
