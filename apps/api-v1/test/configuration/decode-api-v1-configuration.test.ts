import assert from 'node:assert/strict';

import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import type { ApiV1ConfigurationSourceValue } from '../../src/configuration/decode-api-v1-configuration-source.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import {
    CONFIGURATION_SECRET_SENTINELS,
    validDecodeApiV1ConfigurationInput,
    type MutableApiV1ConfigurationSourceObject,
    type MutableDecodeApiV1ConfigurationInput
} from './api-v1-configuration-test-fixture.ts';

Deno.test('configuration decoder returns the complete normalized development contract', () => {
    const input = validDecodeApiV1ConfigurationInput();
    input.environmentSource = {
        http: {
            corsOrigins: [
                'http://localhost:5176',
                'http://localhost:5173'
            ]
        },
        authentication: {
            adminClientIds: ['zeta', 'admin']
        }
    };
    input.appliedEnvironmentOverrideNames = [
        'CORS_ORIGINS',
        'AUTH_ADMIN_CLIENT_IDS'
    ];

    const configuration = decodeApiV1Configuration(input);

    assert.equal(configuration.profile.name, 'dev');
    assert.equal(configuration.profile.productionHardening, false);
    assert.deepEqual(configuration.profile.appliedEnvironmentOverrideNames, [
        'AUTH_ADMIN_CLIENT_IDS',
        'CORS_ORIGINS'
    ]);
    assert.deepEqual(configuration.http.corsOrigins, [
        'http://localhost:5173',
        'http://localhost:5176'
    ]);
    assert.deepEqual(configuration.authentication.adminClientIds, ['admin', 'zeta']);
    assert.equal(
        configuration.authentication.credentialSecret,
        CONFIGURATION_SECRET_SENTINELS.authenticationCredentialSecret
    );
    assert.deepEqual(configuration.authentication.staticClients, [
        { clientId: 'admin', username: 'admin', password: 'admin-password' },
        { clientId: 'alice', username: 'alice', password: 'alice-password' }
    ]);
    assert.equal(configuration.database.mode, 'pglite-memory');
    assert.equal(configuration.ice.mode, 'local');
});

Deno.test('committed profiles resolve their intended database, delivery, and ICE modes', async () => {
    const defaultsSource = await readJsonResource('defaults-config.json');
    const cases = [
        {
            profileName: 'dev',
            environmentSource: {},
            secretsSource: {
                authenticationCredentialSecret: CONFIGURATION_SECRET_SENTINELS.authenticationCredentialSecret
            },
            expected: ['pglite-memory', 'local', 'local', false]
        },
        {
            profileName: 'prod',
            environmentSource: {
                authentication: { adminClientIds: ['production-operator'] },
                ice: { appName: 'rallar-production', region: 'eu' },
                blackBox: { operatorToken: { allowedClientIds: ['production-operator'] } }
            },
            secretsSource: {
                authenticationCredentialSecret: 'production-auth-credential-secret-at-least-32-characters',
                databaseUrl: CONFIGURATION_SECRET_SENTINELS.databaseUrl,
                meteredApiKey: CONFIGURATION_SECRET_SENTINELS.meteredApiKey,
                blackBoxOperatorTokenSecret: CONFIGURATION_SECRET_SENTINELS.blackBoxOperatorTokenSecret
            },
            expected: ['postgres', 'postgres', 'metered', true]
        },
        {
            profileName: 'prod-in-memory',
            environmentSource: {},
            secretsSource: {
                authenticationCredentialSecret: CONFIGURATION_SECRET_SENTINELS.authenticationCredentialSecret
            },
            expected: ['pglite-memory', 'local', 'local', false]
        }
    ] as const;

    for (const testCase of cases) {
        const configuration = decodeApiV1Configuration({
            profileName: testCase.profileName,
            defaultsSource,
            profileSource: await readJsonResource(`${testCase.profileName}-config.json`),
            environmentSource: testCase.environmentSource,
            appliedEnvironmentOverrideNames: [],
            secretsSource: testCase.secretsSource,
            staticClientsSource: []
        });
        assert.deepEqual(
            [
                configuration.database.mode,
                configuration.database.pubSub,
                configuration.ice.mode,
                configuration.profile.productionHardening
            ],
            testCase.expected
        );
    }
});

Deno.test('configuration decoder rejects unknown and missing fields at every owned source boundary', () => {
    const cases = [
        {
            name: 'unknown top-level defaults field',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                (input.defaultsSource as MutableApiV1ConfigurationSourceObject).surprise = true;
            },
            expectedPath: 'surprise'
        },
        {
            name: 'unknown nested defaults field',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                const defaults = input.defaultsSource as MutableApiV1ConfigurationSourceObject;
                const http = defaults.http as MutableApiV1ConfigurationSourceObject;
                http.surprise = true;
            },
            expectedPath: 'http.surprise'
        },
        {
            name: 'missing required defaults section',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                delete (input.defaultsSource as MutableApiV1ConfigurationSourceObject).group;
            },
            expectedPath: 'group'
        },
        {
            name: 'unknown profile field',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                (input.profileSource as MutableApiV1ConfigurationSourceObject).surprise = true;
            },
            expectedPath: 'surprise'
        },
        {
            name: 'unknown environment field',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                input.environmentSource = { surprise: true };
            },
            expectedPath: 'surprise'
        }
    ] as const;

    for (const testCase of cases) {
        const input = validDecodeApiV1ConfigurationInput();
        testCase.mutate(input);
        const error = captureConfigurationError(() => decodeApiV1Configuration(input));
        assert.equal(
            error.issues.some((issue) => issue.path === testCase.expectedPath),
            true,
            testCase.name
        );
    }
});

Deno.test('configuration decoder validates every numeric policy boundary without fallback', () => {
    const integerMinimums = [
        ['http.port', 1],
        ['http.preflightMaxAgeSeconds', 0],
        ['database.applicationPool.maxConnections', 1],
        ['database.applicationPool.idleTimeoutSeconds', 0],
        ['database.listenerPool.maxConnections', 1],
        ['database.listenerPool.idleTimeoutSeconds', 0],
        ['authentication.sessionTtlMs', 1],
        ['authentication.webSocketTicketTtlMs', 1],
        ['authentication.agentSessionTicketTtlMs', 1],
        ['authentication.rateLimits.windowMs', 1],
        ['authentication.rateLimits.loginIp', 1],
        ['authentication.rateLimits.loginUsername', 1],
        ['authentication.rateLimits.registrationIp', 1],
        ['authentication.rateLimits.registrationUsername', 1],
        ['authentication.rateLimits.webSocketTicket', 1],
        ['stateApi.rateLimits.windowMs', 1],
        ['stateApi.rateLimits.request', 1],
        ['stateApi.rateLimits.eventList', 1],
        ['stateApi.circuitBreaker.failureThreshold', 1],
        ['stateApi.circuitBreaker.openDurationMs', 1],
        ['stateApi.circuitBreaker.resetDurationMs', 1],
        ['stateApi.circuitBreaker.samplingDurationMs', 1],
        ['group.defaultMaxMembers', 0],
        ['group.admission.windowMs', 1],
        ['group.admission.joinPrincipal', 1],
        ['group.admission.joinGroup', 1],
        ['group.admission.presencePrincipal', 1],
        ['group.admission.presenceGroup', 1],
        ['topology.planning.degreeLimit', 1],
        ['topology.planning.rttReportingDegreeLimit', 1],
        ['topology.planning.treeMinSize', 1],
        ['topology.planning.meshMinSize', 1],
        ['topology.planning.meshParamK', 1],
        ['topology.planning.meshExitWidth', 0],
        ['topology.planning.treeExitWidth', 0],
        ['topology.recompute.rttRebuildDebounceMs', 0],
        ['topology.recompute.formationDebounceMs', 0],
        ['topology.recompute.globalWindowMs', 1],
        ['topology.recompute.globalMaxPerWindow', 1],
        ['topology.rttRefinement.minIntervalMs', 0],
        ['topology.rttRefinement.vivaldiDeltaThresholdMs', 0],
        ['topology.queueResilience.failureThreshold', 1],
        ['topology.queueResilience.openDurationMs', 1],
        ['topology.queueResilience.resetDurationMs', 1],
        ['topology.queueResilience.samplingDurationMs', 1],
        ['topology.queueResilience.initialRate', 1],
        ['topology.queueResilience.maxRate', 1],
        ['topology.queueResilience.increaseRate', 1],
        ['topology.queueResilience.decreaseRate', 1],
        ['topology.queueResilience.maxFairnessSelectionsPerWindow', 1],
        ['topology.delivery.publicationRetentionMs', 1],
        ['topology.delivery.heartbeatIntervalMs', 1],
        ['topology.delivery.leaseDurationMs', 2],
        ['topology.delivery.antiEntropyIntervalMs', 1],
        ['topology.delivery.pageSize', 1],
        ['topology.delivery.maxPagesPerTurn', 1],
        ['topology.delivery.maxEntriesPerTurn', 1],
        ['topology.delivery.compactionIntervalMs', 1],
        ['topology.delivery.compactionPageSize', 1],
        ['topology.delivery.reconnectBatchWindowMs', 0],
        ['topology.delivery.consumerRetentionMs', 1],
        ['appInbox.completionWait.maxElapsedMs', 0],
        ['appInbox.completionWait.retryIntervalMs', 0],
        ['appInbox.completionWait.maxRetryIntervalMs', 0],
        ['ice.cacheTtlMs', 1],
        ['ice.rateLimit.windowMs', 1],
        ['ice.rateLimit.requests', 1],
        ['blackBox.operatorToken.ttlMs', 1],
        ['blackBox.pgliteEvidence.pollIntervalMs', 1]
    ] as const;

    for (const [path, minimum] of integerMinimums) {
        const validInput = validDecodeApiV1ConfigurationInput();
        setPath(validInput.defaultsSource, path, minimum);
        preserveCrossFieldValidity(validInput, path);
        assert.doesNotThrow(
            () => decodeApiV1Configuration(validInput),
            `${path} accepts ${minimum}`
        );

        const invalidInput = validDecodeApiV1ConfigurationInput();
        setPath(invalidInput.defaultsSource, path, minimum - 1);
        const error = captureConfigurationError(() => decodeApiV1Configuration(invalidInput));
        assert.equal(
            error.issues.some((issue) => issue.path === path),
            true,
            `${path} rejects ${minimum - 1}`
        );
    }

    for (const [value, valid] of [[-0.01, false], [0, true], [1, true], [1.01, false]] as const) {
        const input = validDecodeApiV1ConfigurationInput();
        setPath(input.defaultsSource, 'appInbox.completionWait.jitterRatio', value);
        if (valid) {
            assert.doesNotThrow(() => decodeApiV1Configuration(input));
        }
        else {
            const error = captureConfigurationError(() => decodeApiV1Configuration(input));
            assert.equal(
                error.issues.some((issue) => issue.path === 'appInbox.completionWait.jitterRatio'),
                true
            );
        }
    }

    for (const [value, valid] of [[65_535, true], [65_536, false]] as const) {
        const input = validDecodeApiV1ConfigurationInput();
        setPath(input.defaultsSource, 'http.port', value);
        if (valid) {
            assert.doesNotThrow(() => decodeApiV1Configuration(input));
        }
        else {
            assert.equal(
                captureConfigurationError(() => decodeApiV1Configuration(input)).issues.some(
                    (issue) => issue.path === 'http.port'
                ),
                true
            );
        }
    }

    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const input = validDecodeApiV1ConfigurationInput();
        setPath(input.defaultsSource, 'topology.planning.degreeLimit', invalid);
        const error = captureConfigurationError(() => decodeApiV1Configuration(input));
        assert.equal(error.issues.some((issue) => issue.path === 'topology.planning.degreeLimit'), true);
    }
});

Deno.test('configuration decoder validates URLs, origins, enums, set duplicates, and ordered arrays', () => {
    const invalidCases = [
        ['publicApi.apiBaseUrl', 'ftp://api.example.test'],
        ['publicApi.wsBaseUrl', 'https://api.example.test'],
        ['http.corsOrigins', ['not-an-origin']],
        ['database.mode', 'sqlite'],
        ['authentication.registrationMode', 'anyone'],
        ['topology.replay.mode', 'sometimes'],
        ['ice.mode', 'turn'],
        ['http.corsOrigins', ['https://app.example.test', 'https://app.example.test']],
        ['authentication.adminClientIds', ['admin', 'admin']]
    ] as const;

    for (const [path, value] of invalidCases) {
        const input = validDecodeApiV1ConfigurationInput();
        setPath(input.defaultsSource, path, value);
        const error = captureConfigurationError(() => decodeApiV1Configuration(input));
        assert.equal(error.issues.some((issue) => issue.path.startsWith(path)), true, path);
    }

    const input = validDecodeApiV1ConfigurationInput();
    setPath(input.defaultsSource, 'crdt.documentTypePolicies', [
        { documentType: 'ordered-second', rollout: 'disabled' },
        { documentType: 'ordered-first', rollout: 'production' }
    ]);
    const configuration = decodeApiV1Configuration(input);
    assert.deepEqual(
        configuration.crdt.documentTypePolicies.map((policy) => policy.documentType),
        ['ordered-first', 'ordered-second']
    );

    const invalidDatabaseUrlInput = validDecodeApiV1ConfigurationInput();
    setPath(invalidDatabaseUrlInput.defaultsSource, 'database.mode', 'postgres');
    setPath(invalidDatabaseUrlInput.defaultsSource, 'database.pubSub', 'postgres');
    setPath(
        invalidDatabaseUrlInput.defaultsSource,
        'database.schemaInitialization',
        'disabled'
    );
    invalidDatabaseUrlInput.secretsSource = {
        authenticationCredentialSecret: CONFIGURATION_SECRET_SENTINELS.authenticationCredentialSecret,
        databaseUrl: 'database-url-secret-sentinel'
    };
    const invalidDatabaseUrlError = captureConfigurationError(() => decodeApiV1Configuration(invalidDatabaseUrlInput));
    assert.equal(
        invalidDatabaseUrlError.issues.some((issue) => issue.path === 'database.url'),
        true
    );
    assert.equal(
        invalidDatabaseUrlError.message.includes('database-url-secret-sentinel'),
        false
    );
});

Deno.test('configuration decoder reports malformed CRDT and topology values instead of defaulting', () => {
    const input = validDecodeApiV1ConfigurationInput();
    setPath(input.defaultsSource, 'crdt.documentTypePolicies', [
        { documentType: 'room-state', rollout: 'unknown' }
    ]);
    setPath(input.environmentSource, 'topology.planning.degreeLimit', 'not-a-number');

    const error = captureConfigurationError(() => decodeApiV1Configuration(input));

    assert.deepEqual(
        error.issues.map((issue) => [issue.source, issue.path]),
        [
            ['defaults', 'crdt.documentTypePolicies'],
            ['environment', 'topology.planning.degreeLimit']
        ]
    );
});

Deno.test('configuration decoder enforces database, pub-sub, ICE, replay, and worker invariants', () => {
    const cases = [
        {
            name: 'PostgreSQL pub-sub on PGlite',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                setPath(input.defaultsSource, 'database.pubSub', 'postgres');
            },
            path: 'database.pubSub'
        },
        {
            name: 'local pub-sub on PostgreSQL',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                setPath(input.defaultsSource, 'database.mode', 'postgres');
                setPath(input.defaultsSource, 'database.pubSub', 'local');
                input.secretsSource = {
                    ...(input.secretsSource as MutableApiV1ConfigurationSourceObject),
                    databaseUrl: CONFIGURATION_SECRET_SENTINELS.databaseUrl
                };
            },
            path: 'database.pubSub'
        },
        {
            name: 'file PGlite memory path',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                setPath(input.defaultsSource, 'database.mode', 'pglite-file');
            },
            path: 'database.dataDirectory'
        },
        {
            name: 'PGlite auto schema init on PostgreSQL',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                setPath(input.defaultsSource, 'database.mode', 'postgres');
                setPath(input.defaultsSource, 'database.pubSub', 'postgres');
                input.secretsSource = {
                    ...(input.secretsSource as MutableApiV1ConfigurationSourceObject),
                    databaseUrl: CONFIGURATION_SECRET_SENTINELS.databaseUrl
                };
            },
            path: 'database.schemaInitialization'
        },
        {
            name: 'disabled queue workers on PGlite',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                setPath(input.defaultsSource, 'topology.replay.queueWorkers', 'disabled');
            },
            path: 'topology.replay.queueWorkers'
        },
        {
            name: 'local ICE with Metered fields',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                setPath(input.defaultsSource, 'ice.appName', 'rallar');
            },
            path: 'ice.appName'
        },
        {
            name: 'Metered ICE without credentials',
            mutate(input: MutableDecodeApiV1ConfigurationInput) {
                setPath(input.defaultsSource, 'ice.mode', 'metered');
                setPath(input.defaultsSource, 'ice.appName', 'rallar');
                setPath(input.defaultsSource, 'ice.region', 'eu');
            },
            path: 'ice.apiKey'
        }
    ] as const;

    for (const testCase of cases) {
        const input = validDecodeApiV1ConfigurationInput();
        testCase.mutate(input);
        const error = captureConfigurationError(() => decodeApiV1Configuration(input));
        assert.equal(error.issues.some((issue) => issue.path === testCase.path), true, testCase.name);
    }
});

Deno.test('configuration decoder aggregates deterministic issues from every source category', () => {
    const input = validDecodeApiV1ConfigurationInput();
    setPath(input.defaultsSource, 'http.port', 0);
    input.profileSource = {
        profile: { productionHardening: false },
        http: { preflightMaxAgeSeconds: -1 }
    };
    input.environmentSource = {
        topology: { planning: { degreeLimit: 'invalid' } }
    };
    input.secretsSource = {};
    setPath(input.defaultsSource, 'topology.queueResilience.initialRate', 11);

    const error = captureConfigurationError(() => decodeApiV1Configuration(input));

    assert.deepEqual(
        error.issues.map((issue) => [issue.source, issue.path]),
        [
            ['defaults', 'http.port'],
            ['profile', 'http.preflightMaxAgeSeconds'],
            ['environment', 'topology.planning.degreeLimit'],
            ['secret', 'authentication.credentialSecret'],
            ['invariant', 'topology.queueResilience.initialRate']
        ]
    );
});

Deno.test('configuration decoder rejects weak authentication credentials in every profile', () => {
    const input = validDecodeApiV1ConfigurationInput();
    input.secretsSource = {
        ...CONFIGURATION_SECRET_SENTINELS,
        authenticationCredentialSecret: 'too-short'
    };

    const error = captureConfigurationError(() => decodeApiV1Configuration(input));

    assert.equal(
        error.issues.some((issue) => issue.path === 'authentication.credentialSecret' && issue.code === 'auth-secret-strength'),
        true
    );
    assert.equal(error.toSafeString().includes('too-short'), false);
});

Deno.test('configuration decoder never retains or renders secret values in failures', () => {
    const input = validDecodeApiV1ConfigurationInput();
    setPath(input.defaultsSource, 'database.mode', 'postgres');
    setPath(input.defaultsSource, 'database.pubSub', 'postgres');
    setPath(input.defaultsSource, 'database.schemaInitialization', 'disabled');
    setPath(input.defaultsSource, 'ice.mode', 'metered');
    setPath(input.defaultsSource, 'ice.appName', 'rallar');
    setPath(input.defaultsSource, 'ice.region', 'eu');
    setPath(input.defaultsSource, 'blackBox.operatorToken.mode', 'enabled');
    setPath(input.defaultsSource, 'blackBox.operatorToken.allowedClientIds', ['admin']);
    input.secretsSource = { ...CONFIGURATION_SECRET_SENTINELS };
    input.environmentSource = { http: { port: 0 } };

    const error = captureConfigurationError(() => decodeApiV1Configuration(input));
    const renderings = [
        error.message,
        error.toSafeString(),
        JSON.stringify(error),
        JSON.stringify(error.issues)
    ];

    for (const sentinel of Object.values(CONFIGURATION_SECRET_SENTINELS)) {
        for (const rendering of renderings) {
            assert.equal(rendering.includes(sentinel), false);
        }
    }
});

Deno.test('production hardening validates the effective configuration and cannot be weakened', () => {
    const input = validDecodeApiV1ConfigurationInput();
    input.profileName = 'prod';
    input.profileSource = { profile: { productionHardening: false } };

    const error = captureConfigurationError(() => decodeApiV1Configuration(input));

    assert.equal(error.issues.some((issue) => issue.path === 'profile.productionHardening'), true);
    assert.equal(error.issues.some((issue) => issue.path === 'database.mode'), true);
    assert.equal(error.issues.some((issue) => issue.path === 'publicApi.apiBaseUrl'), true);
    assert.equal(error.issues.some((issue) => issue.path === 'ice.mode'), true);
});

function captureConfigurationError(run: () => void): ApiV1ConfigurationError {
    try {
        run();
    }
    catch (error) {
        assert.equal(error instanceof ApiV1ConfigurationError, true);
        return error as ApiV1ConfigurationError;
    }
    throw new Error('Expected ApiV1ConfigurationError');
}

function setPath(
    source: ApiV1ConfigurationSourceValue | undefined,
    path: string,
    value: ApiV1ConfigurationSourceValue | undefined
): void {
    const segments = path.split('.');
    let current = source as MutableApiV1ConfigurationSourceObject;
    for (const segment of segments.slice(0, -1)) {
        const child = current[segment];
        if (typeof child !== 'object' || child === null || Array.isArray(child)) {
            const replacement: MutableApiV1ConfigurationSourceObject = {};
            current[segment] = replacement;
            current = replacement;
        }
        else {
            current = child as MutableApiV1ConfigurationSourceObject;
        }
    }
    current[segments.at(-1)!] = value;
}

function preserveCrossFieldValidity(
    input: MutableDecodeApiV1ConfigurationInput,
    path: string
): void {
    if (path === 'topology.planning.degreeLimit') {
        setPath(input.defaultsSource, 'topology.planning.meshParamK', 1);
    }
    if (path === 'topology.planning.meshMinSize') {
        setPath(input.defaultsSource, 'topology.planning.treeMinSize', 1);
    }
    if (path === 'topology.delivery.maxEntriesPerTurn') {
        setPath(input.defaultsSource, 'topology.delivery.pageSize', 1);
    }
    if (path === 'topology.delivery.leaseDurationMs') {
        setPath(input.defaultsSource, 'topology.delivery.heartbeatIntervalMs', 1);
    }
    if (path === 'appInbox.completionWait.maxRetryIntervalMs') {
        setPath(input.defaultsSource, 'appInbox.completionWait.retryIntervalMs', 0);
    }
}

async function readJsonResource(
    name: string
): Promise<ApiV1ConfigurationSourceValue> {
    return JSON.parse(
        await Deno.readTextFile(
            new URL(`../../resources/configuration/${name}`, import.meta.url)
        )
    ) as ApiV1ConfigurationSourceValue;
}
