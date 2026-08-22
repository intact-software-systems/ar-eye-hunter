import { ApiV1ConfigurationError, type ApiV1ConfigurationIssue } from './api-v1-configuration-error.ts';
import type { ApiV1ConfigurationProfile } from './api-v1-configuration.ts';
import type {
    ApiV1ConfigurationSourceObject,
    ApiV1ConfigurationSourceValue
} from './decode-api-v1-configuration-source.ts';

export interface ApiV1ConfigurationEnvironment {
    get(name: string): string | undefined;
}

export interface ApiV1ConfigurationEnvironmentResolution {
    readonly profileName: ApiV1ConfigurationProfile['name'];
    readonly environmentSource: ApiV1ConfigurationSourceObject;
    readonly appliedEnvironmentOverrideNames: readonly string[];
    readonly secretsSource: ApiV1ConfigurationSourceObject;
}

interface MutableSourceObject {
    [key: string]: ApiV1ConfigurationSourceValue | undefined;
}

interface ApiV1ConfigurationEnvironmentOverlay extends MutableSourceObject {
    profile: MutableSourceObject;
    http: MutableSourceObject;
    publicApi: MutableSourceObject;
    database: MutableSourceObject;
    authentication: MutableSourceObject & { rateLimits: MutableSourceObject; };
    stateApi: MutableSourceObject;
    group: MutableSourceObject & { admission: MutableSourceObject; };
    topology: MutableSourceObject & {
        planning: MutableSourceObject;
        recompute: MutableSourceObject;
        rttRefinement: MutableSourceObject;
        replay: MutableSourceObject;
    };
    appInbox: MutableSourceObject & { completionWait: MutableSourceObject; };
    ice: MutableSourceObject;
    crdt: MutableSourceObject;
    blackBox: MutableSourceObject & {
        operatorToken: MutableSourceObject;
        pgliteEvidence: MutableSourceObject;
    };
    observability: MutableSourceObject;
}

interface EnvironmentSetting {
    readonly name: string;
    readonly decode: (raw: string) => ApiV1ConfigurationSourceValue;
    readonly apply: (
        source: ApiV1ConfigurationEnvironmentOverlay,
        value: ApiV1ConfigurationSourceValue
    ) => void;
}

const REMOVED_ENVIRONMENT_SETTINGS: Readonly<Record<string, string>> = {
    ENVIRONMENT: 'profile.name',
    API_BASE_URL: 'publicApi.apiBaseUrl',
    RALLAR_GROUP_FORMATION_DAMPING: 'topology.recompute.formationDebounceMs',
    RALLAR_GROUP_STATE_DISSEMINATION: 'topology.delivery'
};

const SECRET_SETTING_KEYS = [
    ['DATABASE_URL', 'databaseUrl'],
    ['RALLAR_AUTH_CREDENTIAL_SECRET', 'authenticationCredentialSecret'],
    ['METERED_API_KEY', 'meteredApiKey'],
    ['RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET', 'blackBoxOperatorTokenSecret']
] as const;

export function readApiV1ConfigurationEnvironment(
    environment: ApiV1ConfigurationEnvironment
): ApiV1ConfigurationEnvironmentResolution {
    rejectRemovedEnvironmentSettings(environment);
    const profileName = readProfileName(environment);
    const environmentSource = createEnvironmentOverlay();
    const appliedEnvironmentOverrideNames: string[] = [];
    for (const setting of ENVIRONMENT_SETTINGS) {
        const raw = environment.get(setting.name);
        if (raw === undefined) {
            continue;
        }
        setting.apply(environmentSource, setting.decode(raw));
        appliedEnvironmentOverrideNames.push(setting.name);
    }
    const secretsSource: MutableSourceObject = {};
    for (const [name, key] of SECRET_SETTING_KEYS) {
        const value = environment.get(name);
        if (value !== undefined) {
            secretsSource[key] = value;
        }
    }
    return {
        profileName,
        environmentSource,
        appliedEnvironmentOverrideNames,
        secretsSource
    };
}

function readProfileName(
    environment: ApiV1ConfigurationEnvironment
): ApiV1ConfigurationProfile['name'] {
    const value = environment.get('RALLAR_API_CONFIGURATION_PROFILE');
    if (value === undefined) {
        return 'dev';
    }
    if (value === 'dev' || value === 'prod' || value === 'prod-in-memory') {
        return value;
    }
    throw new ApiV1ConfigurationError([{
        source: 'environment',
        path: 'profile.name',
        environmentName: 'RALLAR_API_CONFIGURATION_PROFILE',
        code: 'invalid-profile-selector',
        message: 'Profile selector must be exactly dev, prod, or prod-in-memory.'
    }]);
}

function rejectRemovedEnvironmentSettings(
    environment: ApiV1ConfigurationEnvironment
): void {
    const issues: ApiV1ConfigurationIssue[] = [];
    for (const [name, path] of Object.entries(REMOVED_ENVIRONMENT_SETTINGS)) {
        if (environment.get(name) !== undefined) {
            issues.push({
                source: 'environment',
                path,
                environmentName: name,
                code: name === 'ENVIRONMENT'
                    ? 'invalid-profile-selector'
                    : 'removed-environment-setting',
                message: 'Removed environment setting is not accepted.'
            });
        }
    }
    if (issues.length > 0) {
        throw new ApiV1ConfigurationError(issues);
    }
}

function createEnvironmentOverlay(): ApiV1ConfigurationEnvironmentOverlay {
    return {
        profile: {},
        http: {},
        publicApi: {},
        database: {},
        authentication: { rateLimits: {} },
        stateApi: {},
        group: { admission: {} },
        topology: {
            planning: {},
            recompute: {},
            rttRefinement: {},
            replay: {}
        },
        appInbox: { completionWait: {} },
        ice: {},
        crdt: {},
        blackBox: { operatorToken: {}, pgliteEvidence: {} },
        observability: {}
    };
}

function decodeString(raw: string): string {
    return raw.trim();
}

function decodeBoolean(raw: string): ApiV1ConfigurationSourceValue {
    const value = raw.trim();
    if (value === '1' || value === 'true') {
        return true;
    }
    if (value === '0' || value === 'false') {
        return false;
    }
    return value;
}

function decodeNumber(raw: string): ApiV1ConfigurationSourceValue {
    const value = raw.trim();
    return value.length === 0 ? value : Number(value);
}

function decodeCsv(raw: string): readonly string[] {
    return raw.split(',').map((value) => value.trim());
}

function decodeJson(raw: string): ApiV1ConfigurationSourceValue {
    try {
        return JSON.parse(raw) as ApiV1ConfigurationSourceValue;
    }
    catch {
        return raw;
    }
}

const ENVIRONMENT_SETTINGS: readonly EnvironmentSetting[] = [
    {
        name: 'RALLAR_PRODUCTION_HARDENING',
        decode: decodeBoolean,
        apply: (source, value) => source.profile.productionHardening = value
    },
    {
        name: 'PORT',
        decode: decodeNumber,
        apply: (source, value) => source.http.port = value
    },
    {
        name: 'CORS_ORIGINS',
        decode: decodeCsv,
        apply: (source, value) => source.http.corsOrigins = value
    },
    {
        name: 'RALLAR_API_BASE_URL',
        decode: decodeString,
        apply: (source, value) => source.publicApi.apiBaseUrl = value
    },
    {
        name: 'RALLAR_WS_BASE_URL',
        decode: decodeString,
        apply: (source, value) => source.publicApi.wsBaseUrl = value
    },
    {
        name: 'RALLAR_SQL_BACKEND',
        decode: decodeString,
        apply: (source, value) => source.database.mode = value
    },
    {
        name: 'RALLAR_PGLITE_DATA_DIR',
        decode: decodeString,
        apply: (source, value) => source.database.dataDirectory = value
    },
    {
        name: 'RALLAR_PGLITE_SCHEMA_INIT',
        decode: decodeString,
        apply: (source, value) => source.database.schemaInitialization = value
    },
    {
        name: 'RALLAR_DB_PUBSUB',
        decode: decodeString,
        apply: (source, value) => source.database.pubSub = value
    },
    {
        name: 'AUTH_REGISTRATION_MODE',
        decode: decodeString,
        apply: (source, value) => source.authentication.registrationMode = value
    },
    {
        name: 'AUTH_ADMIN_CLIENT_IDS',
        decode: decodeCsv,
        apply: (source, value) => source.authentication.adminClientIds = value
    },
    {
        name: 'AUTH_STATIC_CLIENTS_MODE',
        decode: decodeString,
        apply: (source, value) => source.authentication.staticClientsMode = value
    },
    {
        name: 'RALLAR_LOGIN_IP_RATE_LIMIT',
        decode: decodeNumber,
        apply: (source, value) => source.authentication.rateLimits.loginIp = value
    },
    {
        name: 'RALLAR_LOGIN_USER_RATE_LIMIT',
        decode: decodeNumber,
        apply: (source, value) => source.authentication.rateLimits.loginUsername = value
    },
    {
        name: 'RALLAR_STATE_STRICT_READ_AUTH',
        decode: decodeBoolean,
        apply: (source, value) => source.stateApi.strictReadAuthorization = value
    },
    {
        name: 'RALLAR_GROUP_DEFAULT_MAX_MEMBERS',
        decode: decodeNumber,
        apply: (source, value) => source.group.defaultMaxMembers = value
    },
    {
        name: 'RALLAR_GROUP_JOIN_ADMISSION_PRINCIPAL_RATE_LIMIT',
        decode: decodeNumber,
        apply: (source, value) => source.group.admission.joinPrincipal = value
    },
    {
        name: 'RALLAR_GROUP_JOIN_ADMISSION_GROUP_RATE_LIMIT',
        decode: decodeNumber,
        apply: (source, value) => source.group.admission.joinGroup = value
    },
    {
        name: 'RALLAR_GROUP_PRESENCE_CONNECT_PRINCIPAL_RATE_LIMIT',
        decode: decodeNumber,
        apply: (source, value) => source.group.admission.presencePrincipal = value
    },
    {
        name: 'RALLAR_GROUP_PRESENCE_CONNECT_GROUP_RATE_LIMIT',
        decode: decodeNumber,
        apply: (source, value) => source.group.admission.presenceGroup = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT',
        decode: decodeNumber,
        apply: (source, value) => source.topology.planning.degreeLimit = value
    },
    {
        name: 'RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT',
        decode: decodeNumber,
        apply: (source, value) => source.topology.planning.rttReportingDegreeLimit = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE',
        decode: decodeNumber,
        apply: (source, value) => source.topology.planning.treeMinSize = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE',
        decode: decodeNumber,
        apply: (source, value) => source.topology.planning.meshMinSize = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_MESH_PARAM_K',
        decode: decodeNumber,
        apply: (source, value) => source.topology.planning.meshParamK = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_MESH_EXIT_WIDTH',
        decode: decodeNumber,
        apply: (source, value) => source.topology.planning.meshExitWidth = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_TREE_EXIT_WIDTH',
        decode: decodeNumber,
        apply: (source, value) => source.topology.planning.treeExitWidth = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS',
        decode: decodeNumber,
        apply: (source, value) => source.topology.recompute.rttRebuildDebounceMs = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS',
        decode: decodeNumber,
        apply: (source, value) => source.topology.recompute.formationDebounceMs = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS',
        decode: decodeNumber,
        apply: (source, value) => source.topology.recompute.globalWindowMs = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTES_PER_WINDOW',
        decode: decodeNumber,
        apply: (source, value) => source.topology.recompute.globalMaxPerWindow = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS',
        decode: decodeNumber,
        apply: (source, value) => source.topology.rttRefinement.minIntervalMs = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS',
        decode: decodeNumber,
        apply: (source, value) => source.topology.rttRefinement.vivaldiDeltaThresholdMs = value
    },
    {
        name: 'RALLAR_RTC_TOPOLOGY_REPLAY',
        decode: decodeString,
        apply: (source, value) => source.topology.replay.mode = value
    },
    {
        name: 'RALLAR_API_QUEUE_WORKERS',
        decode: decodeString,
        apply: (source, value) => source.topology.replay.queueWorkers = value
    },
    {
        name: 'RALLAR_APP_INBOX_PHASE_TIMING',
        decode: decodeBoolean,
        apply: (source, value) => source.appInbox.phaseTiming = value
    },
    {
        name: 'RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS',
        decode: decodeNumber,
        apply: (source, value) => source.appInbox.completionWait.maxElapsedMs = value
    },
    {
        name: 'RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS',
        decode: decodeNumber,
        apply: (source, value) => source.appInbox.completionWait.retryIntervalMs = value
    },
    {
        name: 'RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS',
        decode: decodeNumber,
        apply: (source, value) => source.appInbox.completionWait.maxRetryIntervalMs = value
    },
    {
        name: 'RALLAR_APP_INBOX_WAIT_JITTER_RATIO',
        decode: decodeNumber,
        apply: (source, value) => source.appInbox.completionWait.jitterRatio = value
    },
    {
        name: 'RALLAR_ICE_MODE',
        decode: decodeString,
        apply: (source, value) => source.ice.mode = value
    },
    {
        name: 'METERED_APP_NAME',
        decode: decodeString,
        apply: (source, value) => source.ice.appName = value
    },
    {
        name: 'METERED_REGION',
        decode: decodeString,
        apply: (source, value) => source.ice.region = value
    },
    {
        name: 'RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON',
        decode: decodeJson,
        apply: (source, value) => source.crdt.documentTypePolicies = value
    },
    {
        name: 'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS',
        decode: decodeCsv,
        apply: (source, value) => source.blackBox.operatorToken.allowedClientIds = value
    },
    {
        name: 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS',
        decode: decodeNumber,
        apply: (source, value) => source.blackBox.operatorToken.ttlMs = value
    },
    {
        name: 'RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR',
        decode: decodeString,
        apply: (source, value) => {
            source.blackBox.pgliteEvidence.mode = 'directory';
            source.blackBox.pgliteEvidence.directory = value;
        }
    },
    {
        name: 'RALLAR_TIMING_LOGS',
        decode: decodeBoolean,
        apply: (source, value) => source.observability.timingLogs = value
    }
];
