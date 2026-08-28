import assert from 'node:assert/strict';

import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import type { ApiV1ConfigurationSourceValue } from '../../src/configuration/decode-api-v1-configuration-source.ts';
import {
    readApiV1Configuration,
    toApiV1ConfigurationStartupSummary,
    type ReadApiV1ConfigurationInput
} from '../../src/configuration/read-api-v1-configuration.ts';
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

    (defaults.http as { port: number; }).port = 1234;
    environmentValues.AUTH_ADMIN_CLIENT_IDS = 'mutated';
    (staticClients[0] as { clientId: string; }).clientId = 'mutated';

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

function readerInput(environmentValues: Record<string, string>): ReadApiV1ConfigurationInput {
    return {
        environment: { get: (name) => environmentValues[name] },
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
