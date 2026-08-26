export { AppDataCorruptionError } from './app-data/app-data-corruption-error.ts';
export type {
    AppDataAlreadyExists,
    AppDataConditionalDeleteResult,
    AppDataConditionalInsertResult,
    AppDataConditionalWriteResult,
    AppDataDeleted,
    AppDataDeleteExpiredInput,
    AppDataDeleteIfRevisionInput,
    AppDataEntry,
    AppDataEntryPageInput,
    AppDataInserted,
    AppDataKey,
    AppDataRepository,
    AppDataUpsertIfRevisionInput,
    AppDataUpsertInput,
    AppDataWriteConflict,
    AppDataWritten
} from './app-data/app-data-repository.ts';
export { defineAppDataStore } from './app-data/app-data-store-definition.ts';
export type {
    RallarServerAppDataReadConsistency,
    RallarServerAppDataStoreDefinition,
    RallarServerAppDataStoreOptions
} from './app-data/app-data-store-definition.ts';
export type { AppDataValueCodec } from './app-data/app-data-value-codec.ts';
export { PSqlAppDataRepository } from './app-data/postgres/p-sql-app-data-repository.ts';
export { RallarServerAppDataConflictError } from './app-data/rallar-server-app-data-conflict-error.ts';
export { RallarServerAppDataStore } from './app-data/rallar-server-app-data-store.ts';
export { RallarServerAppData } from './app-data/rallar-server-app-data.ts';

export { installRallarGameAuthorityServer } from './game/install-rallar-game-authority-server.ts';
export type {
    PublishRallarGameAuthorityEventInput,
    PublishRallarGameAuthoritySnapshotInput,
    RallarGameAuthorityServerCommandInput,
    RallarGameAuthorityServerCommandOutcome,
    RallarGameAuthorityServerConfig,
    RallarGameAuthorityServerHandle,
    RallarGameAuthorityServerRallarFacade,
    RallarGameAuthorityServerStatus,
    RallarGameAuthorityServerSyncInput,
    RallarGameAuthorityServerWsFacade
} from './game/install-rallar-game-authority-server.ts';
export { createRallarServerValidatedMatchResult } from './game/match-result.ts';
export type { RallarServerValidatedMatchResultInput } from './game/match-result.ts';

export { createRallarAiOllamaProvider } from './rallar-ai/create-rallar-ai-ollama-provider.ts';
export type {
    CreateRallarAiOllamaProviderOptions,
    RallarAiOllamaFetch
} from './rallar-ai/create-rallar-ai-ollama-provider.ts';
export { createRallarServerAi } from './rallar-ai/create-rallar-server-ai.ts';
export { installRallarServerAiHttpRoute } from './rallar-ai/install-rallar-server-ai-http-route.ts';
export type {
    InstallRallarServerAiHttpRouteInput,
    RallarServerAiHttpHandler,
    RallarServerAiHttpRequest,
    RallarServerAiHttpResponse,
    RallarServerAiHttpRouter
} from './rallar-ai/install-rallar-server-ai-http-route.ts';
export { installRallarServerAiWebSocketTopic } from './rallar-ai/install-rallar-server-ai-websocket-topic.ts';
export type {
    InstallRallarServerAiWebSocketTopicInput,
    RallarServerAiWebSocketConfig,
    RallarServerAiWebSocketHandler,
    RallarServerAiWebSocketHandlerAuthorization,
    RallarServerAiWebSocketMessage,
    RallarServerAiWebSocketMessageContext,
    RallarServerAiWebSocketPort,
    RallarServerAiWebSocketSelector,
    RallarServerAiWebSocketTopicDefinition
} from './rallar-ai/install-rallar-server-ai-websocket-topic.ts';
export type {
    CreateRallarServerAiInput,
    RallarServerAi,
    RallarServerAiLimits,
    RallarServerAiRequestContext,
    RallarServerAiRequestRedactor
} from './rallar-ai/rallar-server-ai-contracts.ts';
export { createRallarServerAiResultPersistence } from './rallar-ai/rallar-server-ai-result-persistence.ts';
export type {
    CreateRallarServerAiResultPersistenceInput,
    RallarServerAiResultPersistence,
    RallarServerAiResultPersistenceInput,
    RallarServerAiResultStore,
    RallarServerAiResultStorePort
} from './rallar-ai/rallar-server-ai-result-persistence.ts';
export { createRallarServerAiResultPublisher } from './rallar-ai/rallar-server-ai-result-publication.ts';
export type {
    CreateRallarServerAiResultPublisherInput,
    RallarServerAiResultPublicationInput,
    RallarServerAiResultPublicationPort,
    RallarServerAiResultPublicationTarget,
    RallarServerAiResultPublisher
} from './rallar-ai/rallar-server-ai-result-publication.ts';

export {
    createRallarServerApplication,
    RallarServerApplication
} from './rallar-server/rallar-server-application.ts';
export type {
    CreateRallarServerApplicationInput,
    RallarServerApplicationRouteInstallers,
    RallarServerApplicationSystemInstallers,
    RallarServerQueueEngine,
    RallarServerRouteInstaller,
    RallarServerRuntime
} from './rallar-server/rallar-server-application.ts';

export { createAuthMutationService } from './rallar-system/auth/auth-mutation-service.ts';
export type { AuthMutationService } from './rallar-system/auth/auth-mutation-service.ts';
export {
    createHmacAuthCredentialIssuer,
    isValidAuthCredentialSecret
} from './rallar-system/auth/credentials/auth-credential-issuer.ts';
export type { AuthCredentialIssuer } from './rallar-system/auth/credentials/auth-credential-issuer.ts';
export { hashAuthSecret } from './rallar-system/auth/credentials/hash-auth-secret.ts';
export {
    authenticateAuthUser,
    verifyAuthUserPassword
} from './rallar-system/auth/login/authenticate-auth-user.ts';
export type {
    AuthenticatedUserIdentity,
    AuthUserLoginRepository,
    LoginAuthUserOptions,
    LoginClientData
} from './rallar-system/auth/login/authenticate-auth-user.ts';
export {
    materializeAuthUserRegistration,
    prepareAuthUserRegistration,
    prepareAuthUserRegistrationVerifier
} from './rallar-system/auth/login/prepare-auth-user-registration.ts';
export type { PreparedAuthUserRegistration } from './rallar-system/auth/login/prepare-auth-user-registration.ts';
export { decodeAuthMutationResult } from './rallar-system/auth/mutation/decode-auth-mutation-result.ts';

export type {
    ClientMutationWritten,
    ClientStateService,
    ClientStateServiceDependencies,
    ClientStateWritten,
    RegisterAuthorisedWsClientInput
} from './rallar-system/client-state/client-state-service-contracts.ts';
export { createClientStateService } from './rallar-system/client-state/client-state-service.ts';
export type { ClientStateServiceFactory } from './rallar-system/client-state/client-state-service.ts';
export { ClientMutationRejectedError } from './rallar-system/client-state/validation/client-mutation-rejection.ts';

export { installRallarCrdtWsTopics } from './rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';
export {
    RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES,
    RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES
} from './rallar-system/crdt/realtime/rallar-crdt-server-contracts.ts';
export type {
    RallarCrdtServerAcceptedEnvelope,
    RallarCrdtServerDocumentAuthorizationInput,
    RallarCrdtServerEnvelopeKind,
    RallarCrdtServerLiveValidationContext,
    RallarCrdtServerMutationIngress,
    RallarCrdtServerPrincipalFanoutInput,
    RallarCrdtServerTopicBridge,
    RallarCrdtServerTopicBridgeOptions,
    RallarCrdtServerTopicScope,
    RallarCrdtServerTrustedMetadata,
    RallarCrdtServerWsTopicInstaller
} from './rallar-system/crdt/realtime/rallar-crdt-server-contracts.ts';
export { validateRallarCrdtServerLiveEnvelope } from './rallar-system/crdt/realtime/validate-rallar-crdt-server-live-envelope.ts';
export type { ValidateRallarCrdtServerLiveEnvelopeInput } from './rallar-system/crdt/realtime/validate-rallar-crdt-server-live-envelope.ts';

export type {
    GroupJoinCodeWritten,
    GroupSnapshotPage,
    GroupSnapshotPageOptions,
    GroupStateRuntime,
    GroupStateService,
    GroupStateServiceDependencies,
    GroupStateWritten,
    GroupWritten
} from './rallar-system/group-state/group-state-service-contracts.ts';
export {
    createGroupStateRuntime,
    createGroupStateService,
    GroupMutationIdempotencyConflictError
} from './rallar-system/group-state/group-state-service.ts';

export { createRallarMiddleware } from './rallar-system/middleware/create-rallar-middleware.ts';
export type { CreateRallarMiddlewareOptions } from './rallar-system/middleware/rallar-middleware-construction.ts';
export type {
    RallarMiddlewareRuntime,
    RtcTopologyReplayRuntime
} from './rallar-system/middleware/rallar-middleware-runtime.ts';

export { GroupTopologyConfigRepository } from './rallar-system/topology/config/persistence/group-topology-config-repository.ts';
export { createGroupTopologyRuntimeOwners } from './rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
export type {
    CreateGroupTopologyRuntimeOwnersInput,
    GroupTopologyRuntimeOwners
} from './rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
export {
    planRallarRtcTopologySnapshot,
    RallarRtcTopologyService
} from './rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
export type {
    RallarRtcTopologyRttQueueResult,
    RallarRtcTopologyServiceOptions,
    RallarRtcTopologyUpdateOptions,
    RallarRtcTopologyUpdateResult,
    RtcTopologyKindHysteresisWidths,
    RtcTopologyPlanningIntent
} from './rallar-system/topology/runtime/rallar-rtc-topology-service.ts';

export type {
    RallarServerWsAuthorizer,
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsPayload,
    RallarServerWsProxyContext,
    RallarServerWsProxyRule,
    RallarServerWsPublishResult,
    RallarServerWsPublishStatus,
    RallarServerWsRoomAuthorizationDecision,
    RallarServerWsRoomAuthorizationInput,
    RallarServerWsRoomAuthorizer,
    RallarServerWsRouterOptions,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition,
    RallarServerWsTopicMetadata,
    RallarServerWsTopicScope,
    RallarServerWsValidator
} from './rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
export { RallarServerWsRouter } from './rallar-system/websocket/router/rallar-server-ws-router.ts';
export { readRallarServerWsStatus } from './rallar-system/websocket/router/rallar-server-ws-status.ts';
export type {
    RallarServerWsConnectionStatus,
    RallarServerWsStatus
} from './rallar-system/websocket/router/rallar-server-ws-status.ts';

export {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS,
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry
} from './runtime-state/optimistic-runtime-state-write.ts';
