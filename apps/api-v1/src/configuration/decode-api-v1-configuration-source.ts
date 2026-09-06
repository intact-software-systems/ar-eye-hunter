import type { ApiV1ConfigurationIssue, ApiV1ConfigurationIssueSource } from './api-v1-configuration-error.ts';

export type ApiV1ConfigurationSourceValue =
    | null
    | boolean
    | number
    | string
    | ApiV1ConfigurationSourceArray
    | ApiV1ConfigurationSourceObject;

export interface ApiV1ConfigurationSourceArray extends ReadonlyArray<ApiV1ConfigurationSourceValue> {}

export interface ApiV1ConfigurationSourceObject {
    readonly [key: string]: ApiV1ConfigurationSourceValue | undefined;
}

export interface DecodeApiV1ConfigurationInput {
    readonly profileName: ApiV1ConfigurationSourceValue | undefined;
    readonly defaultsSource: ApiV1ConfigurationSourceValue | undefined;
    readonly profileSource: ApiV1ConfigurationSourceValue | undefined;
    readonly environmentSource: ApiV1ConfigurationSourceValue | undefined;
    readonly appliedEnvironmentOverrideNames: ApiV1ConfigurationSourceValue | undefined;
    readonly secretsSource: ApiV1ConfigurationSourceValue | undefined;
    readonly staticClientsSource: ApiV1ConfigurationSourceValue | undefined;
}

export interface ApiV1ConfigurationSource {
    readonly name: 'defaults' | 'profile' | 'environment';
    readonly value: ApiV1ConfigurationSourceObject;
}

export interface ApiV1ConfigurationSourcePathValue {
    readonly found: boolean;
    readonly blocked: boolean;
    readonly value: ApiV1ConfigurationSourceValue | undefined;
}

export interface ApiV1ConfigurationResolvedSourceValue extends ApiV1ConfigurationSourcePathValue {
    readonly source: 'defaults' | 'profile' | 'environment';
}

export interface ApiV1ConfigurationDecodedSources {
    readonly sources: readonly ApiV1ConfigurationSource[];
    readonly issues: readonly ApiV1ConfigurationIssue[];
}

interface ReadApiV1ConfigurationSourceInput {
    readonly value: ApiV1ConfigurationSourceValue | undefined;
    readonly source: 'defaults' | 'profile' | 'environment';
    readonly topLevelKeys: ReadonlySet<string>;
    readonly requireTopLevelKeys: boolean;
    readonly issues: ApiV1ConfigurationIssue[];
}

interface CollectApiV1ConfigurationUnknownKeysInput {
    readonly value: ApiV1ConfigurationSourceObject;
    readonly path: string;
    readonly allowedKeys: ReadonlySet<string>;
    readonly source: 'defaults' | 'profile' | 'environment';
    readonly issues: ApiV1ConfigurationIssue[];
}

const DEFAULT_TOP_LEVEL_KEYS = new Set([
    'http',
    'publicApi',
    'database',
    'authentication',
    'stateApi',
    'group',
    'topology',
    'appInbox',
    'ice',
    'crdt',
    'blackBox',
    'observability'
]);

const OVERLAY_TOP_LEVEL_KEYS = new Set([
    'profile',
    ...DEFAULT_TOP_LEVEL_KEYS
]);

const CONFIGURATION_KEYS_BY_PATH: Readonly<Record<string, ReadonlySet<string>>> = {
    profile: new Set(['productionHardening']),
    http: new Set(['port', 'corsOrigins', 'preflightMaxAgeSeconds']),
    publicApi: new Set(['apiBaseUrl', 'wsBaseUrl']),
    database: new Set([
        'mode',
        'dataDirectory',
        'schemaInitialization',
        'pubSub',
        'applicationPool',
        'listenerPool'
    ]),
    'database.applicationPool': new Set(['maxConnections', 'idleTimeoutSeconds']),
    'database.listenerPool': new Set(['maxConnections', 'idleTimeoutSeconds']),
    authentication: new Set([
        'registrationMode',
        'staticClientsMode',
        'adminClientIds',
        'sessionTtlMs',
        'webSocketTicketTtlMs',
        'agentSessionTicketTtlMs',
        'rateLimits'
    ]),
    'authentication.rateLimits': new Set([
        'windowMs',
        'loginIp',
        'loginUsername',
        'registrationIp',
        'registrationUsername',
        'webSocketTicket'
    ]),
    stateApi: new Set(['strictReadAuthorization', 'rateLimits', 'circuitBreaker']),
    'stateApi.rateLimits': new Set(['windowMs', 'request', 'eventList']),
    'stateApi.circuitBreaker': new Set([
        'failureThreshold',
        'openDurationMs',
        'resetDurationMs',
        'samplingDurationMs'
    ]),
    group: new Set(['defaultMaxMembers', 'admission']),
    'group.admission': new Set([
        'windowMs',
        'joinPrincipal',
        'joinGroup',
        'presencePrincipal',
        'presenceGroup'
    ]),
    topology: new Set([
        'planning',
        'recompute',
        'rttRefinement',
        'replay',
        'queueResilience',
        'delivery'
    ]),
    'topology.planning': new Set([
        'topologyKind',
        'degreeLimit',
        'rttReportingDegreeLimit',
        'treeMinSize',
        'meshMinSize',
        'meshParamK',
        'meshExitWidth',
        'treeExitWidth'
    ]),
    'topology.recompute': new Set([
        'rttRebuildDebounceMs',
        'formationDebounceMs',
        'globalWindowMs',
        'globalMaxPerWindow'
    ]),
    'topology.rttRefinement': new Set(['minIntervalMs', 'vivaldiDeltaThresholdMs']),
    'topology.replay': new Set(['mode', 'queueWorkers']),
    'topology.queueResilience': new Set([
        'failureThreshold',
        'openDurationMs',
        'resetDurationMs',
        'samplingDurationMs',
        'initialRate',
        'maxRate',
        'increaseRate',
        'decreaseRate',
        'maxFairnessSelectionsPerWindow'
    ]),
    'topology.delivery': new Set([
        'publicationRetentionMs',
        'heartbeatIntervalMs',
        'leaseDurationMs',
        'antiEntropyIntervalMs',
        'pageSize',
        'maxPagesPerTurn',
        'maxEntriesPerTurn',
        'compactionIntervalMs',
        'compactionPageSize',
        'reconnectBatchWindowMs',
        'consumerRetentionMs'
    ]),
    appInbox: new Set(['phaseTiming', 'completionWait']),
    'appInbox.completionWait': new Set([
        'maxElapsedMs',
        'retryIntervalMs',
        'maxRetryIntervalMs',
        'jitterRatio'
    ]),
    ice: new Set(['mode', 'appName', 'region', 'cacheTtlMs', 'rateLimit']),
    'ice.rateLimit': new Set(['windowMs', 'requests']),
    crdt: new Set(['documentTypePolicies']),
    blackBox: new Set(['operatorToken', 'pgliteEvidence']),
    'blackBox.operatorToken': new Set(['mode', 'allowedClientIds', 'ttlMs']),
    'blackBox.pgliteEvidence': new Set(['mode', 'directory', 'pollIntervalMs']),
    observability: new Set(['timingLogs', 'startupSummary'])
};

const ENVIRONMENT_NAME_BY_PATH: Readonly<Record<string, string>> = {
    'http.port': 'PORT',
    'http.corsOrigins': 'CORS_ORIGINS',
    'publicApi.apiBaseUrl': 'RALLAR_API_BASE_URL',
    'publicApi.wsBaseUrl': 'RALLAR_WS_BASE_URL',
    'database.mode': 'RALLAR_SQL_BACKEND',
    'database.dataDirectory': 'RALLAR_PGLITE_DATA_DIR',
    'database.schemaInitialization': 'RALLAR_PGLITE_SCHEMA_INIT',
    'database.pubSub': 'RALLAR_DB_PUBSUB',
    'authentication.registrationMode': 'AUTH_REGISTRATION_MODE',
    'authentication.staticClientsMode': 'AUTH_STATIC_CLIENTS_MODE',
    'authentication.adminClientIds': 'AUTH_ADMIN_CLIENT_IDS',
    'authentication.rateLimits.loginIp': 'RALLAR_LOGIN_IP_RATE_LIMIT',
    'authentication.rateLimits.loginUsername': 'RALLAR_LOGIN_USER_RATE_LIMIT',
    'authentication.rateLimits.registrationIp': 'RALLAR_REGISTRATION_IP_RATE_LIMIT',
    'authentication.rateLimits.registrationUsername': 'RALLAR_REGISTRATION_USER_RATE_LIMIT',
    'stateApi.strictReadAuthorization': 'RALLAR_STATE_STRICT_READ_AUTH',
    'group.defaultMaxMembers': 'RALLAR_GROUP_DEFAULT_MAX_MEMBERS',
    'group.admission.joinPrincipal': 'RALLAR_GROUP_JOIN_ADMISSION_PRINCIPAL_RATE_LIMIT',
    'group.admission.joinGroup': 'RALLAR_GROUP_JOIN_ADMISSION_GROUP_RATE_LIMIT',
    'group.admission.presencePrincipal': 'RALLAR_GROUP_PRESENCE_CONNECT_PRINCIPAL_RATE_LIMIT',
    'group.admission.presenceGroup': 'RALLAR_GROUP_PRESENCE_CONNECT_GROUP_RATE_LIMIT',
    'topology.planning.degreeLimit': 'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT',
    'topology.planning.rttReportingDegreeLimit': 'RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT',
    'topology.planning.treeMinSize': 'RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE',
    'topology.planning.meshMinSize': 'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE',
    'topology.planning.meshParamK': 'RALLAR_RTC_TOPOLOGY_MESH_PARAM_K',
    'topology.planning.meshExitWidth': 'RALLAR_RTC_TOPOLOGY_MESH_EXIT_WIDTH',
    'topology.planning.treeExitWidth': 'RALLAR_RTC_TOPOLOGY_TREE_EXIT_WIDTH',
    'topology.recompute.rttRebuildDebounceMs': 'RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS',
    'topology.recompute.formationDebounceMs': 'RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS',
    'topology.recompute.globalWindowMs': 'RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS',
    'topology.recompute.globalMaxPerWindow': 'RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTES_PER_WINDOW',
    'topology.rttRefinement.minIntervalMs': 'RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS',
    'topology.rttRefinement.vivaldiDeltaThresholdMs': 'RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS',
    'topology.replay.mode': 'RALLAR_RTC_TOPOLOGY_REPLAY',
    'topology.replay.queueWorkers': 'RALLAR_API_QUEUE_WORKERS',
    'appInbox.phaseTiming': 'RALLAR_APP_INBOX_PHASE_TIMING',
    'appInbox.completionWait.maxElapsedMs': 'RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS',
    'appInbox.completionWait.retryIntervalMs': 'RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS',
    'appInbox.completionWait.maxRetryIntervalMs': 'RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS',
    'appInbox.completionWait.jitterRatio': 'RALLAR_APP_INBOX_WAIT_JITTER_RATIO',
    'ice.mode': 'RALLAR_ICE_MODE',
    'ice.appName': 'METERED_APP_NAME',
    'ice.region': 'METERED_REGION',
    'crdt.documentTypePolicies': 'RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON',
    'blackBox.operatorToken.allowedClientIds': 'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS',
    'blackBox.operatorToken.ttlMs': 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS',
    'blackBox.pgliteEvidence.directory': 'RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR',
    'observability.timingLogs': 'RALLAR_TIMING_LOGS'
};

export function readApiV1ConfigurationDecodedSources(
    input: DecodeApiV1ConfigurationInput
): ApiV1ConfigurationDecodedSources {
    const issues: ApiV1ConfigurationIssue[] = [];
    return {
        sources: [
            readApiV1ConfigurationSource({
                value: input.defaultsSource,
                source: 'defaults',
                topLevelKeys: DEFAULT_TOP_LEVEL_KEYS,
                requireTopLevelKeys: true,
                issues
            }),
            readApiV1ConfigurationSource({
                value: input.profileSource,
                source: 'profile',
                topLevelKeys: OVERLAY_TOP_LEVEL_KEYS,
                requireTopLevelKeys: false,
                issues
            }),
            readApiV1ConfigurationSource({
                value: input.environmentSource,
                source: 'environment',
                topLevelKeys: OVERLAY_TOP_LEVEL_KEYS,
                requireTopLevelKeys: false,
                issues
            })
        ],
        issues
    };
}

export function readApiV1ConfigurationSourcePath(
    source: ApiV1ConfigurationSourceObject,
    path: string
): ApiV1ConfigurationSourcePathValue {
    const segments = path.split('.');
    let current: ApiV1ConfigurationSourceValue | undefined = source;
    for (const [index, segment] of segments.entries()) {
        if (!isApiV1ConfigurationSourceRecord(current)) {
            return { found: true, blocked: true, value: undefined };
        }
        if (!Object.hasOwn(current, segment)) {
            return { found: false, blocked: false, value: undefined };
        }
        current = current[segment];
        if (
            index < segments.length - 1 &&
            !isApiV1ConfigurationSourceRecord(current)
        ) {
            return { found: true, blocked: true, value: undefined };
        }
    }
    return { found: true, blocked: false, value: current };
}

export function apiV1ConfigurationEnvironmentName(path: string): string | undefined {
    return ENVIRONMENT_NAME_BY_PATH[path];
}

function readApiV1ConfigurationSource(
    input: ReadApiV1ConfigurationSourceInput
): ApiV1ConfigurationSource {
    if (!isApiV1ConfigurationSourceRecord(input.value)) {
        input.issues.push({
            source: input.source,
            path: '',
            code: 'invalid-object',
            message: 'Configuration source must be an object.'
        });
        return { name: input.source, value: {} };
    }
    collectApiV1ConfigurationUnknownKeys({
        value: input.value,
        path: '',
        allowedKeys: input.topLevelKeys,
        source: input.source,
        issues: input.issues
    });
    if (input.requireTopLevelKeys) {
        for (const key of input.topLevelKeys) {
            if (!Object.hasOwn(input.value, key)) {
                input.issues.push({
                    source: input.source,
                    path: key,
                    code: 'missing-property',
                    message: 'Required configuration property is missing.'
                });
            }
        }
    }
    return { name: input.source, value: input.value };
}

function collectApiV1ConfigurationUnknownKeys(
    input: CollectApiV1ConfigurationUnknownKeysInput
): void {
    for (const key of Object.keys(input.value)) {
        const childPath = input.path.length === 0 ? key : `${input.path}.${key}`;
        if (!input.allowedKeys.has(key)) {
            input.issues.push({
                source: input.source,
                path: childPath,
                environmentName: environmentNameForSource(input.source, childPath),
                code: 'unknown-property',
                message: 'Configuration source contains an unknown property.'
            });
            continue;
        }
        const childKeys = CONFIGURATION_KEYS_BY_PATH[childPath];
        if (
            childKeys === undefined ||
            childPath === 'crdt.documentTypePolicies'
        ) {
            continue;
        }
        const child = input.value[key];
        if (!isApiV1ConfigurationSourceRecord(child)) {
            input.issues.push({
                source: input.source,
                path: childPath,
                environmentName: environmentNameForSource(input.source, childPath),
                code: 'invalid-object',
                message: 'Configuration section must be an object.'
            });
            continue;
        }
        collectApiV1ConfigurationUnknownKeys({
            value: child,
            path: childPath,
            allowedKeys: childKeys,
            source: input.source,
            issues: input.issues
        });
    }
}

function environmentNameForSource(
    source: ApiV1ConfigurationIssueSource,
    path: string
): string | undefined {
    return source === 'environment' ? ENVIRONMENT_NAME_BY_PATH[path] : undefined;
}

function isApiV1ConfigurationSourceRecord(
    value: ApiV1ConfigurationSourceValue | undefined
): value is ApiV1ConfigurationSourceObject {
    return typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}
