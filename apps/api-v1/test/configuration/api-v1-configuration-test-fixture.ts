export const CONFIGURATION_SECRET_SENTINELS = {
    authenticationCredentialSecret: 'auth-secret-sentinel-8de3f40c',
    blackBoxOperatorTokenSecret: 'operator-secret-sentinel-325c7e21',
    databaseUrl: 'postgres://configuration-user:database-secret-sentinel@database.test/rallar',
    meteredApiKey: 'metered-secret-sentinel-2c51c947'
} as const;

export function validConfigurationDefaultsSource(): MutableApiV1ConfigurationSourceObject {
    return {
        http: {
            port: 8080,
            corsOrigins: [
                'http://localhost:5173',
                'http://localhost:5174',
                'http://localhost:5175',
                'http://localhost:5176'
            ],
            preflightMaxAgeSeconds: 600
        },
        publicApi: {
            apiBaseUrl: 'http://localhost:8080',
            wsBaseUrl: 'ws://localhost:8080'
        },
        database: {
            mode: 'pglite-memory',
            dataDirectory: 'memory://',
            schemaInitialization: 'auto',
            pubSub: 'local',
            applicationPool: {
                maxConnections: 5,
                idleTimeoutSeconds: 20
            },
            listenerPool: {
                maxConnections: 1,
                idleTimeoutSeconds: 0
            }
        },
        authentication: {
            registrationMode: 'public',
            staticClientsMode: 'demo',
            adminClientIds: ['admin'],
            sessionTtlMs: 2_592_000_000,
            webSocketTicketTtlMs: 30_000,
            agentSessionTicketTtlMs: 60_000,
            rateLimits: {
                windowMs: 60_000,
                loginIp: 30,
                loginUsername: 5,
                registrationIp: 20,
                registrationUsername: 5,
                webSocketTicket: 30
            }
        },
        stateApi: {
            strictReadAuthorization: false,
            rateLimits: {
                windowMs: 60_000,
                request: 300,
                eventList: 60
            },
            circuitBreaker: {
                failureThreshold: 10,
                openDurationMs: 10_000,
                resetDurationMs: 10_000,
                samplingDurationMs: 10_000
            }
        },
        group: {
            defaultMaxMembers: 256,
            admission: {
                windowMs: 60_000,
                joinPrincipal: 60,
                joinGroup: 600,
                presencePrincipal: 120,
                presenceGroup: 1_200
            }
        },
        topology: {
            planning: {
                topologyKind: 'auto',
                degreeLimit: 5,
                rttReportingDegreeLimit: 5,
                treeMinSize: 5,
                meshMinSize: 16,
                meshParamK: 2,
                meshExitWidth: 4,
                treeExitWidth: 0
            },
            recompute: {
                rttRebuildDebounceMs: 250,
                formationDebounceMs: 500,
                globalWindowMs: 5_000,
                globalMaxPerWindow: 2
            },
            rttRefinement: {
                minIntervalMs: 30_000,
                vivaldiDeltaThresholdMs: 5
            },
            replay: {
                mode: 'enabled',
                queueWorkers: 'enabled'
            },
            queueResilience: {
                failureThreshold: 10,
                openDurationMs: 10_000,
                resetDurationMs: 10_000,
                samplingDurationMs: 10_000,
                initialRate: 1,
                maxRate: 10,
                increaseRate: 1,
                decreaseRate: 1,
                maxFairnessSelectionsPerWindow: 10
            },
            delivery: {
                publicationRetentionMs: 86_400_000,
                heartbeatIntervalMs: 10_000,
                leaseDurationMs: 30_000,
                antiEntropyIntervalMs: 1_000,
                pageSize: 100,
                maxPagesPerTurn: 10,
                maxEntriesPerTurn: 1_000,
                compactionIntervalMs: 60_000,
                compactionPageSize: 1_000,
                reconnectBatchWindowMs: 25,
                consumerRetentionMs: 86_400_000
            }
        },
        appInbox: {
            phaseTiming: false,
            completionWait: {
                maxElapsedMs: 30_000,
                retryIntervalMs: 250,
                maxRetryIntervalMs: 1_000,
                jitterRatio: 0.1
            }
        },
        ice: {
            mode: 'local',
            cacheTtlMs: 300_000,
            rateLimit: {
                windowMs: 60_000,
                requests: 20
            }
        },
        crdt: {
            documentTypePolicies: [
                { documentType: '*', rollout: 'disabled' }
            ]
        },
        blackBox: {
            operatorToken: {
                mode: 'disabled',
                allowedClientIds: [],
                ttlMs: 86_400_000
            },
            pgliteEvidence: {
                mode: 'disabled',
                pollIntervalMs: 25
            }
        },
        observability: {
            timingLogs: true,
            startupSummary: true
        }
    };
}

export function validConfigurationProfileSource(): MutableApiV1ConfigurationSourceObject {
    return {
        profile: {
            productionHardening: false
        }
    };
}

export function validConfigurationStaticClientsSource(): readonly ApiV1ConfigurationSourceValue[] {
    return [
        { clientId: 'admin', username: 'admin', password: 'admin-password' },
        { clientId: 'alice', username: 'alice', password: 'alice-password' }
    ];
}

export function validDecodeApiV1ConfigurationInput(): MutableDecodeApiV1ConfigurationInput {
    return {
        profileName: 'dev',
        defaultsSource: validConfigurationDefaultsSource(),
        profileSource: validConfigurationProfileSource(),
        environmentSource: {},
        appliedEnvironmentOverrideNames: [],
        secretsSource: {
            authenticationCredentialSecret: CONFIGURATION_SECRET_SENTINELS.authenticationCredentialSecret
        },
        staticClientsSource: validConfigurationStaticClientsSource()
    };
}
import type {
    ApiV1ConfigurationSourceValue,
    DecodeApiV1ConfigurationInput
} from '../../src/configuration/decode-api-v1-configuration-source.ts';

export interface MutableApiV1ConfigurationSourceObject {
    [key: string]: ApiV1ConfigurationSourceValue | undefined;
}

export interface MutableDecodeApiV1ConfigurationInput extends DecodeApiV1ConfigurationInput {
    profileName: ApiV1ConfigurationSourceValue | undefined;
    defaultsSource: ApiV1ConfigurationSourceValue | undefined;
    profileSource: ApiV1ConfigurationSourceValue | undefined;
    environmentSource: ApiV1ConfigurationSourceValue | undefined;
    appliedEnvironmentOverrideNames: ApiV1ConfigurationSourceValue | undefined;
    secretsSource: ApiV1ConfigurationSourceValue | undefined;
    staticClientsSource: ApiV1ConfigurationSourceValue | undefined;
}
