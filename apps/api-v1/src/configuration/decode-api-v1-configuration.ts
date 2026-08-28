import { decodeRallarCrdtDocumentTypePolicies } from '@shared/crdt/mod.ts';

import type {
    ApiV1AppInboxConfiguration,
    ApiV1AuthenticationConfiguration,
    ApiV1BlackBoxConfiguration,
    ApiV1CircuitBreakerConfiguration,
    ApiV1Configuration,
    ApiV1CrdtConfiguration,
    ApiV1DatabaseConfiguration,
    ApiV1DatabasePoolConfiguration,
    ApiV1GroupConfiguration,
    ApiV1HttpConfiguration,
    ApiV1IceConfiguration,
    ApiV1ObservabilityConfiguration,
    ApiV1OperatorTokenConfiguration,
    ApiV1PGliteEvidenceConfiguration,
    ApiV1PublicApiConfiguration,
    ApiV1StateApiConfiguration,
    ApiV1TopologyConfiguration
} from './api-v1-configuration.ts';
import {
    readApiV1ConfigurationDecodedSources,
    type ApiV1ConfigurationSourceValue,
    type DecodeApiV1ConfigurationInput
} from './decode-api-v1-configuration-source.ts';
import { ApiV1ConfigurationStructuredValueDecoder } from './decode-api-v1-configuration-structured-values.ts';
import { decodeApiV1ConfigurationUrl, requireApiV1DatabaseUrl } from './decode-api-v1-configuration-urls.ts';
import {
    ApiV1ConfigurationValueDecoder,
    readApiV1ConfigurationSecrets,
    type ApiV1ConfigurationSecrets
} from './decode-api-v1-configuration-values.ts';
import { validateApiV1ConfigurationInvariants } from './validate-api-v1-configuration-invariants.ts';

export type { DecodeApiV1ConfigurationInput } from './decode-api-v1-configuration-source.ts';

export function decodeApiV1Configuration(
    input: DecodeApiV1ConfigurationInput
): ApiV1Configuration {
    const decodedSources = readApiV1ConfigurationDecodedSources(input);
    const decoder = new ApiV1ConfigurationValueDecoder(
        decodedSources.sources,
        decodedSources.issues
    );
    const structuredValues = new ApiV1ConfigurationStructuredValueDecoder(decoder);
    const profileName = decoder.profileName(input.profileName);
    const configuredProductionHardening = decoder.boolean('profile.productionHardening');
    const productionHardening = profileName === 'prod-hardened';
    if (configuredProductionHardening !== productionHardening) {
        decoder.invariant(
            'profile.productionHardening',
            'profile-hardening-mismatch',
            'Production hardening must match the selected profile.'
        );
    }
    const appliedEnvironmentOverrideNames = structuredValues.stringSet(
        'profile.appliedEnvironmentOverrideNames',
        input.appliedEnvironmentOverrideNames,
        'environment'
    );
    const secrets = readApiV1ConfigurationSecrets(input.secretsSource, decoder);

    const http = decodeHttp(decoder, structuredValues);
    const publicApi = decodePublicApi(decoder);
    const database = decodeDatabase(decoder, secrets);
    const authentication = decodeAuthentication({
        values: decoder,
        structuredValues,
        secrets,
        staticClientsSource: input.staticClientsSource
    });
    const stateApi = decodeStateApi(decoder);
    const group = decodeGroup(decoder);
    const topology = decodeTopology(decoder);
    const appInbox = decodeAppInbox(decoder);
    const ice = decodeIce(decoder, secrets);
    const crdt = decodeCrdt(decoder);
    const blackBox = decodeBlackBox(decoder, structuredValues, secrets);
    const observability = decodeObservability(decoder);

    validateApiV1ConfigurationInvariants(decoder, {
        profileName,
        productionHardening,
        publicApi,
        database,
        authentication,
        stateApi,
        topology,
        appInbox,
        ice,
        blackBox,
        http
    });

    decoder.throwIfIssues();
    return {
        profile: {
            name: profileName,
            productionHardening,
            appliedEnvironmentOverrideNames
        },
        http,
        publicApi,
        database,
        authentication,
        stateApi,
        group,
        topology,
        appInbox,
        ice,
        crdt,
        blackBox,
        observability
    };
}

function decodeHttp(
    decoder: ApiV1ConfigurationValueDecoder,
    structuredValues: ApiV1ConfigurationStructuredValueDecoder
): ApiV1HttpConfiguration {
    return {
        port: decoder.integer('http.port', 1, 65_535),
        corsOrigins: structuredValues.originSet('http.corsOrigins'),
        preflightMaxAgeSeconds: decoder.integer('http.preflightMaxAgeSeconds', 0)
    };
}

function decodePublicApi(
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1PublicApiConfiguration {
    return {
        apiBaseUrl: decodeApiV1ConfigurationUrl(decoder, 'publicApi.apiBaseUrl', [
            'http:',
            'https:'
        ]),
        wsBaseUrl: decodeApiV1ConfigurationUrl(decoder, 'publicApi.wsBaseUrl', [
            'ws:',
            'wss:'
        ])
    };
}

function decodeDatabase(
    decoder: ApiV1ConfigurationValueDecoder,
    secrets: ApiV1ConfigurationSecrets
): ApiV1DatabaseConfiguration {
    const mode = decoder.enumeration(
        'database.mode',
        ['postgres', 'pglite-file', 'pglite-memory'] as const
    );
    const schemaInitialization = decoder.enumeration(
        'database.schemaInitialization',
        ['auto', 'disabled'] as const
    );
    const pubSub = decoder.enumeration(
        'database.pubSub',
        ['postgres', 'local', 'disabled'] as const
    );
    const applicationPool = decodeDatabasePool(decoder, 'database.applicationPool');
    const listenerPool = decodeDatabasePool(decoder, 'database.listenerPool');

    if (mode === 'postgres') {
        const url = requireApiV1DatabaseUrl(decoder, secrets.databaseUrl);
        if (schemaInitialization !== 'disabled') {
            decoder.invariant(
                'database.schemaInitialization',
                'postgres-schema-initialization',
                'PostgreSQL requires disabled application schema initialization.'
            );
        }
        if (pubSub !== 'postgres' && pubSub !== 'disabled') {
            decoder.invariant(
                'database.pubSub',
                'postgres-pub-sub',
                'PostgreSQL permits only postgres or disabled pub/sub.'
            );
        }
        if (decoder.hasExplicitOverlay('database.dataDirectory')) {
            decoder.invariant(
                'database.dataDirectory',
                'postgres-data-directory',
                'PostgreSQL does not accept a PGlite data directory.'
            );
        }
        return {
            mode,
            url,
            schemaInitialization: 'disabled',
            pubSub: pubSub === 'disabled' ? 'disabled' : 'postgres',
            applicationPool,
            listenerPool
        };
    }

    const dataDirectory = decoder.nonEmptyString('database.dataDirectory');
    if (pubSub !== 'local' && pubSub !== 'disabled') {
        decoder.invariant(
            'database.pubSub',
            'pglite-pub-sub',
            'PGlite permits only local or disabled pub/sub.'
        );
    }
    if (mode === 'pglite-file') {
        if (dataDirectory === 'memory://') {
            decoder.invariant(
                'database.dataDirectory',
                'pglite-file-directory',
                'PGlite file mode requires a non-memory data directory.'
            );
        }
        return {
            mode,
            dataDirectory,
            schemaInitialization,
            pubSub: pubSub === 'disabled' ? 'disabled' : 'local',
            applicationPool,
            listenerPool
        };
    }
    if (dataDirectory !== 'memory://') {
        decoder.invariant(
            'database.dataDirectory',
            'pglite-memory-directory',
            'PGlite memory mode requires the memory:// data directory.'
        );
    }
    return {
        mode: 'pglite-memory',
        dataDirectory: 'memory://',
        schemaInitialization,
        pubSub: pubSub === 'disabled' ? 'disabled' : 'local',
        applicationPool,
        listenerPool
    };
}

function decodeDatabasePool(
    decoder: ApiV1ConfigurationValueDecoder,
    path: 'database.applicationPool' | 'database.listenerPool'
): ApiV1DatabasePoolConfiguration {
    return {
        maxConnections: decoder.integer(`${path}.maxConnections`, 1),
        idleTimeoutSeconds: decoder.integer(`${path}.idleTimeoutSeconds`, 0)
    };
}

interface DecodeAuthenticationInput {
    readonly values: ApiV1ConfigurationValueDecoder;
    readonly structuredValues: ApiV1ConfigurationStructuredValueDecoder;
    readonly secrets: ApiV1ConfigurationSecrets;
    readonly staticClientsSource: ApiV1ConfigurationSourceValue | undefined;
}

function decodeAuthentication(
    input: DecodeAuthenticationInput
): ApiV1AuthenticationConfiguration {
    const staticClientsMode = input.values.enumeration(
        'authentication.staticClientsMode',
        ['demo', 'disabled'] as const
    );
    const staticClients = input.structuredValues.staticClients(
        input.staticClientsSource,
        staticClientsMode === 'demo'
    );
    return {
        registrationMode: input.values.enumeration(
            'authentication.registrationMode',
            ['public', 'admin'] as const
        ),
        staticClientsMode,
        staticClients,
        adminClientIds: input.structuredValues.stringSet('authentication.adminClientIds'),
        credentialSecret: input.values.requireSecret(
            'authenticationCredentialSecret',
            input.secrets.authenticationCredentialSecret
        ),
        sessionTtlMs: input.values.integer('authentication.sessionTtlMs', 1),
        webSocketTicketTtlMs: input.values.integer('authentication.webSocketTicketTtlMs', 1),
        agentSessionTicketTtlMs: input.values.integer('authentication.agentSessionTicketTtlMs', 1),
        rateLimits: {
            windowMs: input.values.integer('authentication.rateLimits.windowMs', 1),
            loginIp: input.values.integer('authentication.rateLimits.loginIp', 1),
            loginUsername: input.values.integer('authentication.rateLimits.loginUsername', 1),
            registrationIp: input.values.integer('authentication.rateLimits.registrationIp', 1),
            registrationUsername: input.values.integer(
                'authentication.rateLimits.registrationUsername',
                1
            ),
            webSocketTicket: input.values.integer(
                'authentication.rateLimits.webSocketTicket',
                1
            )
        }
    };
}

function decodeStateApi(
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1StateApiConfiguration {
    return {
        strictReadAuthorization: decoder.boolean('stateApi.strictReadAuthorization'),
        rateLimits: {
            windowMs: decoder.integer('stateApi.rateLimits.windowMs', 1),
            request: decoder.integer('stateApi.rateLimits.request', 1),
            eventList: decoder.integer('stateApi.rateLimits.eventList', 1)
        },
        circuitBreaker: decodeCircuitBreaker(decoder, 'stateApi.circuitBreaker')
    };
}

function decodeCircuitBreaker(
    decoder: ApiV1ConfigurationValueDecoder,
    path: 'stateApi.circuitBreaker' | 'topology.queueResilience'
): ApiV1CircuitBreakerConfiguration {
    return {
        failureThreshold: decoder.integer(`${path}.failureThreshold`, 1),
        openDurationMs: decoder.integer(`${path}.openDurationMs`, 1),
        resetDurationMs: decoder.integer(`${path}.resetDurationMs`, 1),
        samplingDurationMs: decoder.integer(`${path}.samplingDurationMs`, 1)
    };
}

function decodeGroup(
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1GroupConfiguration {
    const defaultMaxMembers = decoder.integer('group.defaultMaxMembers', 0);
    return {
        defaultMaxMembers: defaultMaxMembers === 0 ? null : defaultMaxMembers,
        admission: {
            windowMs: decoder.integer('group.admission.windowMs', 1),
            joinPrincipal: decoder.integer('group.admission.joinPrincipal', 1),
            joinGroup: decoder.integer('group.admission.joinGroup', 1),
            presencePrincipal: decoder.integer('group.admission.presencePrincipal', 1),
            presenceGroup: decoder.integer('group.admission.presenceGroup', 1)
        }
    };
}

function decodeTopology(
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1TopologyConfiguration {
    const circuitBreaker = decodeCircuitBreaker(decoder, 'topology.queueResilience');
    return {
        planning: {
            topologyKind: decoder.enumeration(
                'topology.planning.topologyKind',
                ['auto', 'star', 'tree', 'mesh'] as const
            ),
            degreeLimit: decoder.integer('topology.planning.degreeLimit', 1),
            rttReportingDegreeLimit: decoder.integer(
                'topology.planning.rttReportingDegreeLimit',
                1
            ),
            treeMinSize: decoder.integer('topology.planning.treeMinSize', 1),
            meshMinSize: decoder.integer('topology.planning.meshMinSize', 1),
            meshParamK: decoder.integer('topology.planning.meshParamK', 1),
            meshExitWidth: decoder.integer('topology.planning.meshExitWidth', 0),
            treeExitWidth: decoder.integer('topology.planning.treeExitWidth', 0)
        },
        recompute: {
            rttRebuildDebounceMs: decoder.integer(
                'topology.recompute.rttRebuildDebounceMs',
                0
            ),
            formationDebounceMs: decoder.integer(
                'topology.recompute.formationDebounceMs',
                0
            ),
            globalWindowMs: decoder.integer('topology.recompute.globalWindowMs', 1),
            globalMaxPerWindow: decoder.integer(
                'topology.recompute.globalMaxPerWindow',
                1
            )
        },
        rttRefinement: {
            minIntervalMs: decoder.integer('topology.rttRefinement.minIntervalMs', 0),
            vivaldiDeltaThresholdMs: decoder.integer(
                'topology.rttRefinement.vivaldiDeltaThresholdMs',
                0
            )
        },
        replay: {
            mode: decoder.enumeration(
                'topology.replay.mode',
                ['enabled', 'disabled'] as const
            ),
            queueWorkers: decoder.enumeration(
                'topology.replay.queueWorkers',
                ['enabled', 'disabled'] as const
            )
        },
        queueResilience: {
            ...circuitBreaker,
            initialRate: decoder.integer('topology.queueResilience.initialRate', 1),
            maxRate: decoder.integer('topology.queueResilience.maxRate', 1),
            increaseRate: decoder.integer('topology.queueResilience.increaseRate', 1),
            decreaseRate: decoder.integer('topology.queueResilience.decreaseRate', 1),
            maxFairnessSelectionsPerWindow: decoder.integer(
                'topology.queueResilience.maxFairnessSelectionsPerWindow',
                1
            )
        },
        delivery: {
            publicationRetentionMs: decoder.integer(
                'topology.delivery.publicationRetentionMs',
                1
            ),
            heartbeatIntervalMs: decoder.integer(
                'topology.delivery.heartbeatIntervalMs',
                1
            ),
            leaseDurationMs: decoder.integer('topology.delivery.leaseDurationMs', 2),
            antiEntropyIntervalMs: decoder.integer(
                'topology.delivery.antiEntropyIntervalMs',
                1
            ),
            pageSize: decoder.integer('topology.delivery.pageSize', 1),
            maxPagesPerTurn: decoder.integer('topology.delivery.maxPagesPerTurn', 1),
            maxEntriesPerTurn: decoder.integer(
                'topology.delivery.maxEntriesPerTurn',
                1
            ),
            compactionIntervalMs: decoder.integer(
                'topology.delivery.compactionIntervalMs',
                1
            ),
            compactionPageSize: decoder.integer(
                'topology.delivery.compactionPageSize',
                1
            ),
            reconnectBatchWindowMs: decoder.integer(
                'topology.delivery.reconnectBatchWindowMs',
                0
            ),
            consumerRetentionMs: decoder.integer(
                'topology.delivery.consumerRetentionMs',
                1
            )
        }
    };
}

function decodeAppInbox(
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1AppInboxConfiguration {
    return {
        phaseTiming: decoder.boolean('appInbox.phaseTiming'),
        completionWait: {
            maxElapsedMs: decoder.integer('appInbox.completionWait.maxElapsedMs', 0),
            retryIntervalMs: decoder.integer(
                'appInbox.completionWait.retryIntervalMs',
                0
            ),
            maxRetryIntervalMs: decoder.integer(
                'appInbox.completionWait.maxRetryIntervalMs',
                0
            ),
            jitterRatio: decoder.ratio('appInbox.completionWait.jitterRatio')
        }
    };
}

function decodeIce(
    decoder: ApiV1ConfigurationValueDecoder,
    secrets: ApiV1ConfigurationSecrets
): ApiV1IceConfiguration {
    const mode = decoder.enumeration('ice.mode', ['local', 'metered'] as const);
    const cacheTtlMs = decoder.integer('ice.cacheTtlMs', 1);
    const rateLimit = {
        windowMs: decoder.integer('ice.rateLimit.windowMs', 1),
        requests: decoder.integer('ice.rateLimit.requests', 1)
    };
    if (mode === 'metered') {
        return {
            mode,
            appName: decoder.nonEmptyString('ice.appName'),
            apiKey: decoder.requireSecret('meteredApiKey', secrets.meteredApiKey),
            region: decoder.nonEmptyString('ice.region'),
            cacheTtlMs,
            rateLimit
        };
    }
    if (decoder.hasValue('ice.appName')) {
        decoder.invariant(
            'ice.appName',
            'local-ice-field',
            'Local ICE does not accept a Metered provider app name.'
        );
    }
    if (secrets.meteredApiKey !== undefined) {
        decoder.invariant(
            'ice.apiKey',
            'local-ice-api-key',
            'Local ICE does not accept a Metered API key.'
        );
    }
    return { mode: 'local', cacheTtlMs, rateLimit };
}

function decodeCrdt(
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1CrdtConfiguration {
    const value = decoder.sourceValue('crdt.documentTypePolicies');
    try {
        const policies = decodeRallarCrdtDocumentTypePolicies(value);
        const keys = policies.map(toCrdtPolicyKey);
        if (new Set(keys).size !== keys.length) {
            decoder.sourceIssue(
                'crdt.documentTypePolicies',
                'duplicate-policy',
                'CRDT document type policies must not contain duplicate scopes.'
            );
        }
        return {
            documentTypePolicies: [...policies].sort((left, right) =>
                toCrdtPolicyKey(left).localeCompare(toCrdtPolicyKey(right))
            )
        };
    }
    catch {
        decoder.sourceIssue(
            'crdt.documentTypePolicies',
            'invalid-crdt-policy',
            'CRDT document type policies are invalid.'
        );
        return { documentTypePolicies: [] };
    }
}

function toCrdtPolicyKey(
    policy: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        scope?: string;
        documentType: string;
    }>
): string {
    return [
        policy.applicationId ?? '*',
        policy.workspaceId ?? '*',
        policy.scope ?? 'any',
        policy.documentType
    ].join('\u0000');
}

function decodeBlackBox(
    decoder: ApiV1ConfigurationValueDecoder,
    structuredValues: ApiV1ConfigurationStructuredValueDecoder,
    secrets: ApiV1ConfigurationSecrets
): ApiV1BlackBoxConfiguration {
    const operatorMode = decoder.enumeration(
        'blackBox.operatorToken.mode',
        ['disabled', 'enabled'] as const
    );
    const allowedClientIds = structuredValues.stringSet(
        'blackBox.operatorToken.allowedClientIds'
    );
    const ttlMs = decoder.integer('blackBox.operatorToken.ttlMs', 1);
    const operatorToken: ApiV1OperatorTokenConfiguration = operatorMode === 'enabled'
        ? {
            mode: 'enabled',
            allowedClientIds,
            ttlMs,
            secret: decoder.requireSecret(
                'blackBoxOperatorTokenSecret',
                secrets.blackBoxOperatorTokenSecret
            )
        }
        : { mode: 'disabled', allowedClientIds, ttlMs };

    const evidenceMode = decoder.enumeration(
        'blackBox.pgliteEvidence.mode',
        ['disabled', 'directory'] as const
    );
    const pollIntervalMs = decoder.integer(
        'blackBox.pgliteEvidence.pollIntervalMs',
        1
    );
    const pgliteEvidence: ApiV1PGliteEvidenceConfiguration = evidenceMode === 'directory'
        ? {
            mode: 'directory',
            directory: decoder.nonEmptyString('blackBox.pgliteEvidence.directory'),
            pollIntervalMs
        }
        : { mode: 'disabled', pollIntervalMs };
    if (
        evidenceMode === 'disabled' &&
        decoder.hasValue('blackBox.pgliteEvidence.directory')
    ) {
        decoder.invariant(
            'blackBox.pgliteEvidence.directory',
            'disabled-evidence-directory',
            'Disabled PGlite evidence does not accept a directory.'
        );
    }
    return { operatorToken, pgliteEvidence };
}

function decodeObservability(
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1ObservabilityConfiguration {
    return {
        timingLogs: decoder.boolean('observability.timingLogs'),
        startupSummary: decoder.boolean('observability.startupSummary')
    };
}
