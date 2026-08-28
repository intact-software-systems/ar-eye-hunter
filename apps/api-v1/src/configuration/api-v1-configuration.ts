import type { LoginClientData } from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';

export interface ApiV1ConfigurationProfile {
    readonly name: 'dev' | 'prod' | 'prod-hardened' | 'prod-in-memory';
    readonly productionHardening: boolean;
    readonly appliedEnvironmentOverrideNames: readonly string[];
}

export interface ApiV1HttpConfiguration {
    readonly port: number;
    readonly corsOrigins: readonly string[];
    readonly preflightMaxAgeSeconds: number;
}

export interface ApiV1PublicApiConfiguration {
    readonly apiBaseUrl: string;
    readonly wsBaseUrl: string;
}

export interface ApiV1DatabasePoolConfiguration {
    readonly maxConnections: number;
    readonly idleTimeoutSeconds: number;
}

interface ApiV1DatabaseCommonConfiguration {
    readonly applicationPool: ApiV1DatabasePoolConfiguration;
    readonly listenerPool: ApiV1DatabasePoolConfiguration;
}

export interface ApiV1PostgreSqlDatabaseConfiguration extends ApiV1DatabaseCommonConfiguration {
    readonly mode: 'postgres';
    readonly url: string;
    readonly schemaInitialization: 'disabled';
    readonly pubSub: 'postgres' | 'disabled';
}

export interface ApiV1PGliteFileDatabaseConfiguration extends ApiV1DatabaseCommonConfiguration {
    readonly mode: 'pglite-file';
    readonly dataDirectory: string;
    readonly schemaInitialization: 'auto' | 'disabled';
    readonly pubSub: 'local' | 'disabled';
}

export interface ApiV1PGliteMemoryDatabaseConfiguration extends ApiV1DatabaseCommonConfiguration {
    readonly mode: 'pglite-memory';
    readonly dataDirectory: 'memory://';
    readonly schemaInitialization: 'auto' | 'disabled';
    readonly pubSub: 'local' | 'disabled';
}

export type ApiV1DatabaseConfiguration =
    | ApiV1PostgreSqlDatabaseConfiguration
    | ApiV1PGliteFileDatabaseConfiguration
    | ApiV1PGliteMemoryDatabaseConfiguration;

export interface ApiV1RateLimitConfiguration {
    readonly windowMs: number;
    readonly requests: number;
}

export interface ApiV1AuthenticationRateLimits {
    readonly windowMs: number;
    readonly loginIp: number;
    readonly loginUsername: number;
    readonly registrationIp: number;
    readonly registrationUsername: number;
    readonly webSocketTicket: number;
}

export interface ApiV1AuthenticationConfiguration {
    readonly registrationMode: 'public' | 'admin';
    readonly staticClientsMode: 'demo' | 'disabled';
    readonly staticClients: readonly LoginClientData[];
    readonly adminClientIds: readonly string[];
    readonly credentialSecret: string;
    readonly sessionTtlMs: number;
    readonly webSocketTicketTtlMs: number;
    readonly agentSessionTicketTtlMs: number;
    readonly rateLimits: ApiV1AuthenticationRateLimits;
}

export interface ApiV1StateApiRateLimits {
    readonly windowMs: number;
    readonly request: number;
    readonly eventList: number;
}

export interface ApiV1CircuitBreakerConfiguration {
    readonly failureThreshold: number;
    readonly openDurationMs: number;
    readonly resetDurationMs: number;
    readonly samplingDurationMs: number;
}

export interface ApiV1StateApiConfiguration {
    readonly strictReadAuthorization: boolean;
    readonly rateLimits: ApiV1StateApiRateLimits;
    readonly circuitBreaker: ApiV1CircuitBreakerConfiguration;
}

export interface ApiV1GroupAdmissionConfiguration {
    readonly windowMs: number;
    readonly joinPrincipal: number;
    readonly joinGroup: number;
    readonly presencePrincipal: number;
    readonly presenceGroup: number;
}

export interface ApiV1GroupConfiguration {
    readonly defaultMaxMembers: number | null;
    readonly admission: ApiV1GroupAdmissionConfiguration;
}

export interface ApiV1TopologyPlanningConfiguration {
    readonly topologyKind: 'auto' | 'star' | 'tree' | 'mesh';
    readonly degreeLimit: number;
    readonly rttReportingDegreeLimit: number;
    readonly treeMinSize: number;
    readonly meshMinSize: number;
    readonly meshParamK: number;
    readonly meshExitWidth: number;
    readonly treeExitWidth: number;
}

export interface ApiV1TopologyRecomputeConfiguration {
    readonly rttRebuildDebounceMs: number;
    readonly formationDebounceMs: number;
    readonly globalWindowMs: number;
    readonly globalMaxPerWindow: number;
}

export interface ApiV1TopologyRttRefinementConfiguration {
    readonly minIntervalMs: number;
    readonly vivaldiDeltaThresholdMs: number;
}

export interface ApiV1TopologyReplayConfiguration {
    readonly mode: 'enabled' | 'disabled';
    readonly queueWorkers: 'enabled' | 'disabled';
}

export interface ApiV1QueueResilienceConfiguration extends ApiV1CircuitBreakerConfiguration {
    readonly initialRate: number;
    readonly maxRate: number;
    readonly increaseRate: number;
    readonly decreaseRate: number;
    readonly maxFairnessSelectionsPerWindow: number;
}

export interface ApiV1TopologyDeliveryConfiguration {
    readonly publicationRetentionMs: number;
    readonly heartbeatIntervalMs: number;
    readonly leaseDurationMs: number;
    readonly antiEntropyIntervalMs: number;
    readonly pageSize: number;
    readonly maxPagesPerTurn: number;
    readonly maxEntriesPerTurn: number;
    readonly compactionIntervalMs: number;
    readonly compactionPageSize: number;
    readonly reconnectBatchWindowMs: number;
    readonly consumerRetentionMs: number;
}

export interface ApiV1TopologyConfiguration {
    readonly planning: ApiV1TopologyPlanningConfiguration;
    readonly recompute: ApiV1TopologyRecomputeConfiguration;
    readonly rttRefinement: ApiV1TopologyRttRefinementConfiguration;
    readonly replay: ApiV1TopologyReplayConfiguration;
    readonly queueResilience: ApiV1QueueResilienceConfiguration;
    readonly delivery: ApiV1TopologyDeliveryConfiguration;
}

export interface ApiV1AppInboxCompletionWaitConfiguration {
    readonly maxElapsedMs: number;
    readonly retryIntervalMs: number;
    readonly maxRetryIntervalMs: number;
    readonly jitterRatio: number;
}

export interface ApiV1AppInboxConfiguration {
    readonly phaseTiming: boolean;
    readonly completionWait: ApiV1AppInboxCompletionWaitConfiguration;
}

interface ApiV1IceCommonConfiguration {
    readonly cacheTtlMs: number;
    readonly rateLimit: ApiV1RateLimitConfiguration;
}

export interface ApiV1LocalIceConfiguration extends ApiV1IceCommonConfiguration {
    readonly mode: 'local';
}

export interface ApiV1MeteredIceConfiguration extends ApiV1IceCommonConfiguration {
    readonly mode: 'metered';
    readonly appName: string;
    readonly apiKey: string;
    readonly region: string;
}

export type ApiV1IceConfiguration = ApiV1LocalIceConfiguration | ApiV1MeteredIceConfiguration;

export interface ApiV1CrdtConfiguration {
    readonly documentTypePolicies: readonly RallarCrdtDocumentTypePolicy[];
}

export interface ApiV1DisabledOperatorTokenConfiguration {
    readonly mode: 'disabled';
    readonly allowedClientIds: readonly string[];
    readonly ttlMs: number;
}

export interface ApiV1EnabledOperatorTokenConfiguration {
    readonly mode: 'enabled';
    readonly allowedClientIds: readonly string[];
    readonly ttlMs: number;
    readonly secret: string;
}

export type ApiV1OperatorTokenConfiguration =
    | ApiV1DisabledOperatorTokenConfiguration
    | ApiV1EnabledOperatorTokenConfiguration;

export interface ApiV1DisabledPGliteEvidenceConfiguration {
    readonly mode: 'disabled';
    readonly pollIntervalMs: number;
}

export interface ApiV1DirectoryPGliteEvidenceConfiguration {
    readonly mode: 'directory';
    readonly directory: string;
    readonly pollIntervalMs: number;
}

export type ApiV1PGliteEvidenceConfiguration =
    | ApiV1DisabledPGliteEvidenceConfiguration
    | ApiV1DirectoryPGliteEvidenceConfiguration;

export interface ApiV1BlackBoxConfiguration {
    readonly operatorToken: ApiV1OperatorTokenConfiguration;
    readonly pgliteEvidence: ApiV1PGliteEvidenceConfiguration;
}

export interface ApiV1ObservabilityConfiguration {
    readonly timingLogs: boolean;
    readonly startupSummary: boolean;
}

export interface ApiV1Configuration {
    readonly profile: ApiV1ConfigurationProfile;
    readonly http: ApiV1HttpConfiguration;
    readonly publicApi: ApiV1PublicApiConfiguration;
    readonly database: ApiV1DatabaseConfiguration;
    readonly authentication: ApiV1AuthenticationConfiguration;
    readonly stateApi: ApiV1StateApiConfiguration;
    readonly group: ApiV1GroupConfiguration;
    readonly topology: ApiV1TopologyConfiguration;
    readonly appInbox: ApiV1AppInboxConfiguration;
    readonly ice: ApiV1IceConfiguration;
    readonly crdt: ApiV1CrdtConfiguration;
    readonly blackBox: ApiV1BlackBoxConfiguration;
    readonly observability: ApiV1ObservabilityConfiguration;
}
