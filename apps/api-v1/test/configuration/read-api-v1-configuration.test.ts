import assert from 'node:assert/strict';

import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import type { ApiV1ConfigurationSourceValue } from '../../src/configuration/decode-api-v1-configuration-source.ts';
import {
    readApiV1Configuration,
    toApiV1ConfigurationStartupSummary,
    type ReadApiV1ConfigurationInput
} from '../../src/configuration/read-api-v1-configuration.ts';
import { toApiAppInboxServiceOptions } from '../../src/services/timing-service.ts';
import {
    CONFIGURATION_SECRET_SENTINELS,
    validConfigurationDefaultsSource,
    validConfigurationEnvironment,
    validConfigurationProfileSource,
    validConfigurationStaticClientsSource
} from './api-v1-configuration-test-fixture.ts';

const DEFAULTS_URL = new URL('../../resources/configuration/defaults-config.json', import.meta.url);
const DEV_URL = new URL('../../resources/configuration/dev-config.json', import.meta.url);
const PROD_URL = new URL('../../resources/configuration/prod-config.json', import.meta.url);
const PROD_HARDENED_URL = new URL(
    '../../resources/configuration/prod-hardened-config.json',
    import.meta.url
);
const PROD_IN_MEMORY_URL = new URL(
    '../../resources/configuration/prod-in-memory-config.json',
    import.meta.url
);
const STATIC_CLIENTS_URL = new URL('../../resources/authorised-clients.json', import.meta.url);

Deno.test('configuration reader carries selected phase timing through AppInbox service options', async () => {
    for (const selection of [{ raw: 'false', expectedPhase: false }, { raw: 'true', expectedPhase: true }]) {
        const configuration = await readApiV1Configuration(readerInput({
            ...validConfigurationEnvironment('prod-in-memory'),
            RALLAR_TIMING_LOGS: 'true',
            RALLAR_APP_INBOX_PHASE_TIMING: selection.raw
        }));
        assert.deepEqual({
            timingLogs: configuration.observability.timingLogs,
            decodedPhase: configuration.appInbox.phaseTiming,
            appInboxOptionPhase: toApiAppInboxServiceOptions(configuration.appInbox).phaseTiming
        }, {
            timingLogs: true,
            decodedPhase: selection.expectedPhase,
            appInboxOptionPhase: selection.expectedPhase
        });
    }
});

Deno.test('configuration reader selects only absent or exact canonical profiles', async () => {
    const absentEnvironment = validConfigurationEnvironment();
    delete absentEnvironment.RALLAR_API_CONFIGURATION_PROFILE;
    assert.equal(
        (await readApiV1Configuration(readerInput(absentEnvironment))).profile.name,
        'dev'
    );

    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(
            readerInput(validConfigurationEnvironment(profile))
        );
        assert.equal(configuration.profile.name, profile);
    }

    const rejected: readonly Record<string, string>[] = [
        { RALLAR_API_CONFIGURATION_PROFILE: 'production' },
        { RALLAR_API_CONFIGURATION_PROFILE: 'Prod' },
        { RALLAR_API_CONFIGURATION_PROFILE: '' },
        { RALLAR_API_CONFIGURATION_PROFILE: ' dev ' }
    ];
    for (const values of rejected) {
        const error = await captureConfigurationError(
            readerInput({ ...validConfigurationEnvironment(), ...values })
        );
        assert.equal(error.issues.some((issue) => issue.code === 'invalid-profile-selector'), true);
    }
});

Deno.test('configuration reader bounds password derivations by the host cores minus one unless the environment names a bound', async () => {
    const fromHost = await readApiV1Configuration(readerInput(validConfigurationEnvironment(), 4));
    assert.equal(fromHost.authentication.maxConcurrentPasswordDerivations, 3);

    const singleCore = await readApiV1Configuration(readerInput(validConfigurationEnvironment(), 1));
    assert.equal(singleCore.authentication.maxConcurrentPasswordDerivations, 1);

    const fromEnvironment = await readApiV1Configuration(readerInput({
        ...validConfigurationEnvironment(),
        RALLAR_AUTH_MAX_CONCURRENT_PASSWORD_DERIVATIONS: '7'
    }, 4));
    assert.equal(fromEnvironment.authentication.maxConcurrentPasswordDerivations, 7);
    assert.equal(
        fromEnvironment.profile.appliedEnvironmentOverrideNames.includes(
            'RALLAR_AUTH_MAX_CONCURRENT_PASSWORD_DERIVATIONS'
        ),
        true
    );
});

Deno.test('configuration reader rejects a password derivation bound below one', async () => {
    const error = await captureConfigurationError(readerInput({
        ...validConfigurationEnvironment(),
        RALLAR_AUTH_MAX_CONCURRENT_PASSWORD_DERIVATIONS: '0'
    }, 4));

    assert.equal(error.issues.some((issue) => issue.path === 'authentication.maxConcurrentPasswordDerivations'), true);
});

Deno.test('configuration reader keeps production hardening profile-owned', async () => {
    const environment = {
        ...validConfigurationEnvironment('prod'),
        RALLAR_PRODUCTION_HARDENING: '1'
    };

    const configuration = await readApiV1Configuration(readerInput(environment));

    assert.equal(configuration.profile.productionHardening, false);
    assert.equal(
        configuration.profile.appliedEnvironmentOverrideNames.includes(
            'RALLAR_PRODUCTION_HARDENING'
        ),
        false
    );
});

Deno.test('configuration reader applies exact leaf precedence and ignores unrelated environment', async () => {
    const environment = {
        ...validConfigurationEnvironment(),
        AUTH_ADMIN_CLIENT_IDS: 'zeta,admin',
        CORS_ORIGINS: 'http://localhost:5176,http://localhost:5173',
        PORT: '9090',
        RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR: '/tmp/rallar-evidence',
        UNRELATED_PLATFORM_SETTING: 'ignored'
    };
    const configuration = await readApiV1Configuration(readerInput(environment));

    assert.equal(configuration.http.port, 9090);
    assert.deepEqual(configuration.http.corsOrigins, [
        'http://localhost:5173',
        'http://localhost:5176'
    ]);
    assert.deepEqual(configuration.authentication.adminClientIds, ['admin', 'zeta']);
    assert.deepEqual(configuration.blackBox.pgliteEvidence, {
        mode: 'directory',
        directory: '/tmp/rallar-evidence',
        pollIntervalMs: 25
    });
    assert.equal(
        configuration.authentication.credentialSecret,
        CONFIGURATION_SECRET_SENTINELS.authenticationCredentialSecret
    );
    assert.deepEqual(configuration.profile.appliedEnvironmentOverrideNames, [
        'AUTH_ADMIN_CLIENT_IDS',
        'CORS_ORIGINS',
        'PORT',
        'RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR'
    ]);

    const invalidPortError = await captureConfigurationError(
        readerInput({ ...validConfigurationEnvironment(), PORT: 'not-an-integer' })
    );
    assert.equal(
        invalidPortError.issues.some((issue) => issue.environmentName === 'PORT' && issue.code === 'invalid-integer'),
        true
    );
});

Deno.test('configuration reader loads static clients for convenient production and disables them for hardening', async () => {
    let staticClientReads = 0;
    const devInput = readerInput(validConfigurationEnvironment());
    const configuration = await readApiV1Configuration({
        ...devInput,
        readTextFile: async (url) => {
            if (url.href === STATIC_CLIENTS_URL.href) {
                staticClientReads += 1;
            }
            return await devInput.readTextFile(url);
        }
    });
    assert.equal(staticClientReads, 1);
    assert.deepEqual(
        configuration.authentication.staticClients.map((client) => client.clientId),
        ['admin', 'user', 'guest', 'test', 'test2', 'alice', 'bob', 'charlie']
    );

    const prodConfiguration = await readApiV1Configuration(
        readerInput(validConfigurationEnvironment('prod'))
    );
    assert.equal(prodConfiguration.profile.productionHardening, false);
    assert.equal(prodConfiguration.authentication.registrationMode, 'public');
    assert.equal(prodConfiguration.authentication.staticClientsMode, 'demo');
    assert.deepEqual(
        prodConfiguration.authentication.staticClients.map((client) => client.clientId),
        ['admin', 'user', 'guest', 'test', 'test2', 'alice', 'bob', 'charlie']
    );

    const hardenedConfiguration = await readApiV1Configuration(
        readerInput(validConfigurationEnvironment('prod-hardened'))
    );
    assert.equal(hardenedConfiguration.profile.productionHardening, true);
    assert.equal(hardenedConfiguration.authentication.registrationMode, 'admin');
    assert.equal(hardenedConfiguration.authentication.staticClientsMode, 'disabled');
    assert.deepEqual(hardenedConfiguration.authentication.staticClients, []);
});

Deno.test('convenient production keeps bundled users outside privileged identity lists', async () => {
    for (
        const [environmentName, clientId] of [
            ['AUTH_ADMIN_CLIENT_IDS', 'alice'],
            ['RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS', 'bob']
        ] as const
    ) {
        const environment = {
            ...validConfigurationEnvironment('prod'),
            [environmentName]: clientId
        };
        const error = await captureConfigurationError(readerInput(environment));

        assert.equal(
            error.issues.some((issue) => issue.code === 'production-demo-privilege-overlap'),
            true,
            environmentName
        );
    }
});

Deno.test('convenient production requires an operator allowlist when token issuance is enabled', async () => {
    const environment = validConfigurationEnvironment('prod');
    delete environment.RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS;

    const error = await captureConfigurationError(readerInput(environment));

    assert.equal(
        error.issues.some((issue) => issue.code === 'production-operator-allowlist-required'),
        true
    );
});

Deno.test('configuration reader preserves ordered arrays and isolates the frozen snapshot', async () => {
    const defaults = validConfigurationDefaultsSource();
    const profile = validConfigurationProfileSource();
    const staticClients = validConfigurationStaticClientsSource().map((value) => structuredClone(value));
    const sources = new Map<string, ApiV1ConfigurationSourceValue>([
        [DEFAULTS_URL.href, defaults],
        [DEV_URL.href, profile],
        [PROD_URL.href, profile],
        [PROD_HARDENED_URL.href, profile],
        [PROD_IN_MEMORY_URL.href, profile],
        [STATIC_CLIENTS_URL.href, staticClients]
    ]);
    const environmentValues = validConfigurationEnvironment();
    environmentValues.AUTH_ADMIN_CLIENT_IDS = 'zeta,admin';
    const configuration = await readApiV1Configuration({
        ...readerInput(environmentValues),
        readTextFile: (url) => Promise.resolve(JSON.stringify(sources.get(url.href)))
    });

    if (defaults.http === null || typeof defaults.http !== 'object' || Array.isArray(defaults.http)) {
        throw new Error('Configuration fixture HTTP source must be an object.');
    }
    Reflect.set(defaults.http, 'port', 1234);
    environmentValues.AUTH_ADMIN_CLIENT_IDS = 'mutated';
    const staticClient = staticClients[0];
    if (staticClient === null || typeof staticClient !== 'object' || Array.isArray(staticClient)) {
        throw new Error('Configuration fixture static client must be an object.');
    }
    Reflect.set(staticClient, 'clientId', 'mutated');

    assert.equal(configuration.http.port, 8080);
    assert.deepEqual(configuration.authentication.adminClientIds, ['admin', 'zeta']);
    assert.deepEqual(
        configuration.authentication.staticClients.map((client) => client.clientId),
        ['admin', 'alice']
    );
    assertRecursivelyFrozen(configuration);
});

Deno.test('configuration startup summary is useful and contains no secret-derived data', async () => {
    const configuration = await readApiV1Configuration(
        readerInput(validConfigurationEnvironment('prod'))
    );
    const summary = toApiV1ConfigurationStartupSummary(configuration);

    assert.deepEqual(summary, {
        profile: 'prod',
        productionHardening: false,
        databaseMode: 'postgres',
        databasePubSub: 'postgres',
        iceMode: 'metered',
        publicApi: {
            apiBaseUrl: 'https://api.rallar.intactss.com',
            wsBaseUrl: 'wss://api.rallar.intactss.com'
        },
        corsOrigins: [
            'https://ar-eye-hunter.pages.dev',
            'https://blackbox.rallar.intactss.com',
            'https://relic-hunters-v1.intact-software-systems.workers.dev'
        ],
        workerCategories: {
            apiQueue: 'enabled',
            rtcTopologyReplay: 'enabled'
        },
        applicationPool: { maxConnections: 5 },
        appInbox: { newLaneConcurrency: 4, newLaneHeldRows: 16 },
        topologyPlanning: { rttReplanMinimumLayoutAgeMs: 15_000 },
        appliedEnvironmentOverrideNames: [
            'AUTH_ADMIN_CLIENT_IDS',
            'METERED_APP_NAME',
            'METERED_REGION',
            'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS'
        ]
    });
    const rendered = JSON.stringify(summary);
    for (const secret of Object.values(CONFIGURATION_SECRET_SENTINELS)) {
        assert.equal(rendered.includes(secret), false);
    }
    assert.equal(rendered.includes('credentialSecret'), false);
    assert.equal(rendered.includes('databaseUrl'), false);
    assert.equal(rendered.includes('fingerprint'), false);
    assert.equal(rendered.includes('length'), false);
});

Deno.test('ICE request input overrides defaults and profile without changing window or cache and remains frozen', async () => {
    const environment = { ...validConfigurationEnvironment('prod-in-memory'), RALLAR_ICE_RATE_LIMIT_REQUESTS: '101' };
    const input = readerInput(environment);
    const configuration = await readApiV1Configuration({
        ...input,
        readTextFile: async function readIceOverrideConfigurationResource (url) {
            const source: unknown = JSON.parse(await input.readTextFile(url));
            if (url.href === PROD_IN_MEMORY_URL.href) {
                if (source === null || typeof source !== 'object' || Array.isArray(source)) {
                    throw new Error('Configuration resource must be a JSON object.');
                }
                Reflect.set(source, 'ice', { mode: 'local', rateLimit: { requests: 37 } });
            }
            return JSON.stringify(source);
        }
    });
    assert.deepEqual(configuration.ice.rateLimit, { requests: 101, windowMs: 60_000 });
    assert.equal(configuration.ice.cacheTtlMs, 300_000);
    assertRecursivelyFrozen(configuration);
    assert.equal(configuration.profile.appliedEnvironmentOverrideNames.includes('RALLAR_ICE_RATE_LIMIT_REQUESTS'), true);
    const summary = toApiV1ConfigurationStartupSummary(configuration);
    assert.equal(summary.appliedEnvironmentOverrideNames.includes('RALLAR_ICE_RATE_LIMIT_REQUESTS'), true);
    for (const secret of Object.values(CONFIGURATION_SECRET_SENTINELS)) {
        assert.equal(JSON.stringify(summary).includes(secret), false);
    }
});

Deno.test('ICE request input rejects malformed and nonpositive integers with safe source diagnostics', async () => {
    for (const value of ['', 'malformed-input-sentinel', '0', '-1', '1.5', 'Infinity', 'NaN']) {
        const error = await captureConfigurationError(readerInput({
            ...validConfigurationEnvironment('prod-in-memory'),
            RALLAR_ICE_RATE_LIMIT_REQUESTS: value
        }));
        assert.equal(
            error.issues.some((issue) =>
                issue.path === 'ice.rateLimit.requests' && issue.environmentName === 'RALLAR_ICE_RATE_LIMIT_REQUESTS' && issue.source === 'environment'
            ),
            true
        );
        assert.equal(error.message.includes('malformed-input-sentinel'), false);
        for (const secret of Object.values(CONFIGURATION_SECRET_SENTINELS)) {
            assert.equal(error.message.includes(secret), false);
        }
    }
});

Deno.test('single-process prod-in-memory polls AppInbox completion only as a five-second fallback to the same-process notice', async () => {
    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(readerInput(validConfigurationEnvironment(profile)));
        assert.deepEqual(configuration.appInbox.completionWait, {
            maxElapsedMs: 30_000,
            retryIntervalMs: 250,
            maxRetryIntervalMs: profile === 'prod-in-memory' ? 5_000 : 1_000,
            jitterRatio: 0.1
        });
    }
});

Deno.test('all committed profiles preserve the default finite ICE admission policy', async () => {
    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(readerInput(validConfigurationEnvironment(profile)));
        assert.deepEqual(configuration.ice.rateLimit, { requests: 20, windowMs: 60_000 });
        assert.equal(configuration.ice.cacheTtlMs, 300_000);
    }
});

Deno.test('every committed profile gives the application pool five connections and the listener one', async () => {
    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(readerInput(validConfigurationEnvironment(profile)));
        assert.equal(configuration.database.applicationPool.maxConnections, 5, profile);
        assert.equal(configuration.database.listenerPool.maxConnections, 1, profile);
    }
});

Deno.test('every committed profile runs four AppInbox context heads together unless the environment selects another bound (D296)', async () => {
    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(readerInput(validConfigurationEnvironment(profile)));
        assert.equal(configuration.appInbox.newLaneConcurrency, 4, profile);
    }
    const selected = await readApiV1Configuration(readerInput({
        ...validConfigurationEnvironment('prod-in-memory'),
        RALLAR_APP_INBOX_NEW_LANE_CONCURRENCY: '1'
    }));
    assert.equal(selected.appInbox.newLaneConcurrency, 1);
    for (const outOfRange of ['0', '9']) {
        const error = await captureConfigurationError(readerInput({
            ...validConfigurationEnvironment(),
            RALLAR_APP_INBOX_NEW_LANE_CONCURRENCY: outOfRange
        }, 4));
        assert.equal(error.issues.some((issue) => issue.path === 'appInbox.newLaneConcurrency'), true, outOfRange);
    }
});

Deno.test('every committed profile holds sixteen AppInbox flight rows unless the environment selects another bound', async () => {
    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(readerInput(validConfigurationEnvironment(profile)));
        assert.equal(configuration.appInbox.newLaneHeldRows, 16, profile);
    }
    const selected = await readApiV1Configuration(readerInput({
        ...validConfigurationEnvironment('prod-in-memory'),
        RALLAR_APP_INBOX_NEW_LANE_HELD_ROWS: '32'
    }));
    assert.equal(selected.appInbox.newLaneHeldRows, 32);
    for (const outOfRange of ['3', '65']) {
        const error = await captureConfigurationError(readerInput({
            ...validConfigurationEnvironment(),
            RALLAR_APP_INBOX_NEW_LANE_HELD_ROWS: outOfRange
        }, 4));
        assert.equal(error.issues.some((issue) => issue.path === 'appInbox.newLaneHeldRows'), true, outOfRange);
    }
});

Deno.test('the environment selects the RTT replan minimum layout age within its range', async () => {
    const selected = await readApiV1Configuration(readerInput({
        ...validConfigurationEnvironment('prod-in-memory'),
        RALLAR_RTC_TOPOLOGY_RTT_REPLAN_MINIMUM_LAYOUT_AGE_MS: '0'
    }));
    assert.equal(selected.topology.planning.rttReplanMinimumLayoutAgeMs, 0);
    for (const outOfRange of ['-1', '120001']) {
        const error = await captureConfigurationError(readerInput({
            ...validConfigurationEnvironment(),
            RALLAR_RTC_TOPOLOGY_RTT_REPLAN_MINIMUM_LAYOUT_AGE_MS: outOfRange
        }));
        assert.equal(
            error.issues.some((issue) => issue.path === 'topology.planning.rttReplanMinimumLayoutAgeMs'),
            true,
            outOfRange
        );
    }
});

Deno.test('every committed profile samples the API heap every thirty seconds while timing logs are on', async () => {
    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(readerInput(validConfigurationEnvironment(profile)));
        assert.equal(configuration.observability.heapSampleIntervalMs, 30_000, profile);
    }
});

Deno.test('every committed profile keeps finished AppInbox commands one day unless the environment selects another retention', async () => {
    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(readerInput(validConfigurationEnvironment(profile)));
        assert.equal(configuration.appInbox.finishedRetentionMs, 24 * 60 * 60 * 1_000, profile);
    }
    const selected = await readApiV1Configuration(readerInput({
        ...validConfigurationEnvironment('prod-in-memory'),
        RALLAR_APP_INBOX_FINISHED_RETENTION_MS: '3600000'
    }));
    assert.equal(selected.appInbox.finishedRetentionMs, 3_600_000);
    for (const outOfRange of ['59999', '2592000001']) {
        const error = await captureConfigurationError(readerInput({
            ...validConfigurationEnvironment(),
            RALLAR_APP_INBOX_FINISHED_RETENTION_MS: outOfRange
        }));
        assert.equal(
            error.issues.some((issue) => issue.path === 'appInbox.finishedRetentionMs'),
            true,
            outOfRange
        );
    }
});

Deno.test('every committed profile keeps disconnected client sessions seven days unless the environment selects another retention', async () => {
    for (const profile of ['dev', 'prod', 'prod-hardened', 'prod-in-memory'] as const) {
        const configuration = await readApiV1Configuration(readerInput(validConfigurationEnvironment(profile)));
        assert.equal(configuration.clientSessions.disconnectedRetentionMs, 7 * 24 * 60 * 60 * 1_000, profile);
    }
    const selected = await readApiV1Configuration(readerInput({
        ...validConfigurationEnvironment('prod-in-memory'),
        RALLAR_CLIENT_SESSION_DISCONNECTED_RETENTION_MS: '3600000'
    }));
    assert.equal(selected.clientSessions.disconnectedRetentionMs, 3_600_000);
    for (const outOfRange of ['0', '2592000001']) {
        const error = await captureConfigurationError(readerInput({
            ...validConfigurationEnvironment(),
            RALLAR_CLIENT_SESSION_DISCONNECTED_RETENTION_MS: outOfRange
        }));
        assert.equal(
            error.issues.some((issue) => issue.path === 'clientSessions.disconnectedRetentionMs'),
            true,
            outOfRange
        );
    }
});

function readerInput(
    environmentValues: Record<string, string>,
    hardwareConcurrency = 4
): ReadApiV1ConfigurationInput {
    return {
        environment: { get: (name) => environmentValues[name] },
        hardwareConcurrency,
        readTextFile: (url) => Deno.readTextFile(url),
        defaultsUrl: DEFAULTS_URL,
        profileUrls: {
            dev: DEV_URL,
            prod: PROD_URL,
            'prod-hardened': PROD_HARDENED_URL,
            'prod-in-memory': PROD_IN_MEMORY_URL
        },
        staticClientsUrl: STATIC_CLIENTS_URL
    };
}

async function captureConfigurationError(
    input: ReadApiV1ConfigurationInput
): Promise<ApiV1ConfigurationError> {
    try {
        await readApiV1Configuration(input);
    }
    catch (error) {
        assert.equal(error instanceof ApiV1ConfigurationError, true);
        return error as ApiV1ConfigurationError;
    }
    assert.fail('Expected configuration reader to throw.');
}

function assertRecursivelyFrozen(value: object): void {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) {
        if (typeof child === 'object' && child !== null) {
            assertRecursivelyFrozen(child);
        }
    }
}
