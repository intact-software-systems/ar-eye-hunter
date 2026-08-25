import { createRallarFacade } from '@shared-web/browser/composition/create-rallar-facade.ts';
import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';

export { createRallarFacade } from '@shared-web/browser/composition/create-rallar-facade.ts';

export {
    createRallarDataFacade,
    defineRallarDataStore
} from '@shared-web/browser/rallar-data.ts';

export { createRallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';

export {
    matchesRallarMessageSelector,
    normalizeRallarMessageSelector
} from '@shared-web/browser/messages/rallar-message-selectors.ts';

export {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation
} from '@shared-web/browser/readiness.ts';

export type {
    RallarCrdtDocument,
    RallarCrdtFacade,
    RallarCrdtFacadeDefaults,
    RallarCrdtOpenOptions,
    RallarCrdtOpenScope,
    RallarCrdtSnapshotListener
} from '@shared-web/browser/rallar-crdt.ts';

export type {
    CreateRallarDataFacadeInput,
    RallarDataChangeEvent,
    RallarDataChangeListener,
    RallarDataDurability,
    RallarDataFacade,
    RallarDataHydration,
    RallarDataMigration,
    RallarDataMigrationContext,
    RallarDataScope,
    RallarDataStorageEstimate,
    RallarDataStore,
    RallarDataStoreDefinition,
    RallarDataStoreOptions
} from '@shared-web/browser/rallar-data.ts';

export type {
    RallarMessageSelector,
    RallarMessageSelectorInput
} from '@shared-web/browser/messages/rallar-message-selectors.ts';

export type {
    RallarOperationOptions,
    RallarOperationRetryPredicate
} from '@shared-web/browser/rallar-operation-options.ts';

export type {
    CommandsOrchestrator,
    CommandsOrchestratorPolicies
} from '@shared/cache/CommandsOrchestrator.ts';

export type {
    RallarNormalizedReadinessExpectation,
    RallarReadinessEvaluation,
    RallarReadinessExpectation,
    RallarReadinessStatus
} from '@shared-web/browser/readiness.ts';

export type {
    RallarAdvancedFacade,
    RallarAuthChangeListener,
    RallarAuthChangeReason,
    RallarAuthState,
    RallarCallDataInput,
    RallarCallEndOptions,
    RallarCallHandle,
    RallarCallInviteInput,
    RallarCallInviteListener,
    RallarCallInviteResult,
    RallarCallMediaInput,
    RallarCallParticipantState,
    RallarCallParticipantStatus,
    RallarCallSignalEvent,
    RallarCallSignalKind,
    RallarCallSignalListener,
    RallarCallSignalPayload,
    RallarCallSignalSend,
    RallarCallStartInput,
    RallarCallState,
    RallarCallStatus,
    RallarCameraSourceStartOptions,
    RallarChannelsFacade,
    RallarConnectStatus,
    RallarCreateRoomInput,
    RallarDefaults,
    RallarDirectorAppointOptions,
    RallarDirectorRelayConfig,
    RallarDirectorRelayEnvelope,
    RallarDirectorRelayHandle,
    RallarDirectorRelayMessage,
    RallarDirectorRelaySendResult,
    RallarDirectorRelaySendStatus,
    RallarDirectorRole,
    RallarDirectorState,
    RallarDirectorStatus,
    RallarDirectorStatusListener,
    RallarDirectorStatusOptions,
    RallarFacade,
    RallarIncomingCallInvite,
    RallarJoinRoomInput,
    RallarJoinRoomOptions,
    RallarLeaveRoomOptions,
    RallarListPeopleEventsOptions,
    RallarListRoomEventsInput,
    RallarListRoomEventsOptions,
    RallarMediaSourceAttachOptions,
    RallarMediaSourceController,
    RallarMediaSourceHandle,
    RallarMediaSourceKind,
    RallarMediaSourcesFacade,
    RallarMediaSourceState,
    RallarMediaSourceStatus,
    RallarMessage,
    RallarMessageHandler,
    RallarMessageLane,
    RallarMessageSendBase,
    RallarMessageSendResult,
    RallarMessageTransport,
    RallarMicrophoneSourceStartOptions,
    RallarOnChangeOptions,
    RallarPeopleEventOptions,
    RallarPeopleState,
    RallarPerson,
    RallarProductFacade,
    RallarRealtimeBinarySendInput,
    RallarRealtimeHandler,
    RallarRealtimeHealthOptions,
    RallarRealtimeJsonLane,
    RallarRealtimeJsonLaneSendOptions,
    RallarRealtimeJsonSendInput,
    RallarRealtimeLaneHealth,
    RallarRealtimeMessage,
    RallarRealtimeSendOptions,
    RallarRealtimeSendResult,
    RallarRegisterOptions,
    RallarRemoteStream,
    RallarReplayEventsResult,
    RallarReplayPeopleEventsOptions,
    RallarReplayRoomEventsInput,
    RallarReplayRoomEventsOptions,
    RallarRoomEventOptions,
    RallarRoomGovernanceOptions,
    RallarRoomInviteOptions,
    RallarRoomLifecycleOptions,
    RallarRoomMember,
    RallarRoomMessageChannelDefinition,
    RallarRoomPresenceWaitOptions,
    RallarRoomPresenceWaitResult,
    RallarRoomRealtimeJsonChannel,
    RallarRoomRealtimeJsonDefaults,
    RallarRoomRealtimeJsonSendOptions,
    RallarRoomRealtimeSendResult,
    RallarRoomRealtimeSendStatus,
    RallarRoomRealtimeTransportOptions,
    RallarRoomSession,
    RallarRoomSessionMessageDefinition,
    RallarRoomSessionRealtimeInput,
    RallarRoomState,
    RallarRoomSummary,
    RallarRoomSwitchOperation,
    RallarRoomSwitchPartialFailureError,
    RallarRoomTargetInput,
    RallarRoomTransportState,
    RallarRoomTransportStatus,
    RallarRtcCandidateDiagnostics,
    RallarRtcCandidatePairDiagnostics,
    RallarRtcDiagnostics,
    RallarRtcDiagnosticsOptions,
    RallarRtcLaneStatus,
    RallarRtcLifecycleEvent,
    RallarRtcLifecycleKind,
    RallarRtcLifecycleListener,
    RallarRtcPeerConnectionStatus,
    RallarRtcPeerDiagnostics,
    RallarRtcPeerStatus,
    RallarRtcReconnectOptions,
    RallarRtcRecoveryResult,
    RallarRtcRecoveryStatus,
    RallarRtcRoomLaneWaitOptions,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomLaneWaitStatus,
    RallarRtcRoomMode,
    RallarRtcRoomTransportOptions,
    RallarRtcSendInput,
    RallarRtcStatus,
    RallarRtcStatusListener,
    RallarRtcStatusOptions,
    RallarRtcStatusSubscriptionOptions,
    RallarRtcWaitForOpenOptions,
    RallarRtcWaitForOpenResult,
    RallarScopedOperationOptions,
    RallarScreenSourceStartOptions,
    RallarSetRoomMemberRoleInput,
    RallarSetupInput,
    RallarStartOptions,
    RallarStartResult,
    RallarStateEventListener,
    RallarStateListener,
    RallarSubscriptionScope,
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarTargetedChannelSendOptions,
    RallarTargetedSendResult,
    RallarTargetedSendStatus,
    RallarTargetMembership,
    RallarTargetSelector,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarTypedMessageSendOptions,
    RallarTypedMessageSendStrategy,
    RallarTypedPayloadHandler,
    RallarTypedRtcSendOptions,
    RallarTypedWsSendOptions,
    RallarUnsubscribe,
    RallarUpdateRoomInput,
    RallarWaitForOpenOptions,
    RallarWaitForOpenStatus,
    RallarWsFacade,
    RallarWsLifecycleEvent,
    RallarWsLifecycleKind,
    RallarWsLifecycleListener,
    RallarWsReadyState,
    RallarWsSendInput,
    RallarWsStatus,
    RallarWsStatusListener,
    RallarWsWaitForOpenResult
} from '@shared-web/browser/rallar-facade-contract.ts';

export const rallar: RallarFacade = createRallarFacade();
