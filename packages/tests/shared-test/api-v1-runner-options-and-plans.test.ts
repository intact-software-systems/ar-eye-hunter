import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    parseApiV1BlackBoxArgs,
    toApiV1BlackBoxEnvironment,
    toApiV1ServerCommand,
    toClusterRecipeMatrixCommand,
    toManagedApiServerPlans,
    toManagedPGliteRunEnvironment,
    toRecipeMatrixCommands
} from '@shared-test/black-box-runner/api-v1-black-box-run.mts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('API-v1 runner options and process plans', () => {
    it('starts three API servers for every managed Postgres cluster command', async () => {
        const packageJson = JSON.parse(
            await readFile(path.join(repoRoot, 'packages/shared-test/package.json'), 'utf8')
        ) as { scripts?: Record<string, string>; };

        for (
            const scriptName of [
                'bb:api-v1:postgres',
                'bb:api-v1:postgres:crdt',
                'bb:api-v1:postgres:medium-scale',
                'bb:api-v1:postgres:topology-replay'
            ]
        ) {
            expect(packageJson.scripts?.[scriptName], scriptName).toContain('--secondary-port=18081');
            expect(packageJson.scripts?.[scriptName], scriptName).toContain('--tertiary-port=18082');
        }
    });

    it('defaults to Postgres on port 18080', () => {
        const options = parseApiV1BlackBoxArgs([]);

        expect(options).toMatchObject({
            backend: 'postgres',
            port: 18080,
            profile: 'api-v1-black-box',
            artifactDir: '.artifacts/api-v1-black-box/postgres',
            requireGates: true,
            runMigrations: true,
            recipesOnly: false
        });
        expect(options).not.toHaveProperty('secondaryPort');
        expect(options).not.toHaveProperty('tertiaryPort');
    });

    it('accepts a complete set of pairwise-distinct Postgres cluster ports', () => {
        expect(
            parseApiV1BlackBoxArgs([
                '--backend=postgres',
                '--port=18080',
                '--secondary-port=18081',
                '--tertiary-port=18082'
            ])
        ).toMatchObject({
            backend: 'postgres',
            port: 18080,
            secondaryPort: 18081,
            tertiaryPort: 18082
        });
    });

    it('selects the opt-in medium-scale cluster profile without the ordinary profile', () => {
        expect(
            parseApiV1BlackBoxArgs([
                '--backend=postgres',
                '--secondary-port=18081',
                '--tertiary-port=18082',
                '--cluster-only',
                '--cluster-profile=api-v1-black-box-medium-scale'
            ])
        ).toMatchObject({
            backend: 'postgres',
            secondaryPort: 18081,
            tertiaryPort: 18082,
            clusterOnly: true,
            clusterProfile: 'api-v1-black-box-medium-scale'
        });

        expect(() => parseApiV1BlackBoxArgs(['--cluster-only'])).toThrow(
            /cluster-only.*secondary-port.*tertiary-port/i
        );
    });

    it('selects the dedicated topology replay profile and makes only C passive', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
            '--tertiary-port=18082',
            '--cluster-only',
            '--cluster-profile=api-v1-black-box-topology-replay'
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});
        const [primary, secondary, tertiary] = toManagedApiServerPlans(options, env, '/tmp/api-v1-bb');

        expect(options.clusterProfile).toBe('api-v1-black-box-topology-replay');
        expect(primary?.env.RALLAR_API_QUEUE_WORKERS).not.toBe('disabled');
        expect(primary?.env.RALLAR_DB_PUBSUB).not.toBe('disabled');
        expect(secondary?.env.RALLAR_API_QUEUE_WORKERS).not.toBe('disabled');
        expect(secondary?.env.RALLAR_DB_PUBSUB).not.toBe('disabled');
        expect(tertiary?.env).toMatchObject({
            RALLAR_API_QUEUE_WORKERS: 'disabled',
            RALLAR_DB_PUBSUB: 'disabled',
            RALLAR_RTC_TOPOLOGY_REPLAY: 'enabled'
        });
    });

    it.each([
        ['same as the primary port', ['--port=18080', '--secondary-port=18080']],
        ['outside the port range', ['--secondary-port=65536']],
        ['with pglite-memory', ['--backend=pglite-memory', '--secondary-port=18081']],
        ['with pglite-file', ['--backend=pglite-file', '--secondary-port=18081']],
        ['in recipes-only mode', ['--recipes-only', '--secondary-port=18081']]
    ])('rejects a secondary API port %s', (_label, args) => {
        expect(() => parseApiV1BlackBoxArgs(args)).toThrow(/secondary/i);
    });

    it.each([
        ['without a secondary port', ['--tertiary-port=18082']],
        ['when the secondary port has no tertiary peer', ['--secondary-port=18081']],
        ['when it duplicates the primary port', ['--secondary-port=18081', '--tertiary-port=18080']],
        ['when it duplicates the secondary port', ['--secondary-port=18081', '--tertiary-port=18081']],
        ['outside the port range', ['--secondary-port=18081', '--tertiary-port=65536']],
        ['without a value', ['--secondary-port=18081', '--tertiary-port']],
        [
            'with pglite-memory',
            ['--backend=pglite-memory', '--secondary-port=18081', '--tertiary-port=18082']
        ],
        [
            'with pglite-file',
            ['--backend=pglite-file', '--secondary-port=18081', '--tertiary-port=18082']
        ],
        ['in recipes-only mode', ['--recipes-only', '--secondary-port=18081', '--tertiary-port=18082']]
    ])('rejects an invalid managed three-server topology %s', (_label, args) => {
        expect(() => parseApiV1BlackBoxArgs(args)).toThrow(/secondary|tertiary/i);
    });

    it('keeps recipes-only mode free of server and migration side effects', () => {
        expect(parseApiV1BlackBoxArgs(['--recipes-only'])).toMatchObject({
            backend: 'postgres',
            profile: 'api-v1-black-box-recipes',
            requireGates: true,
            runMigrations: false,
            recipesOnly: true
        });
    });

    it('allows recipes-only mode to opt into the full managed API-v1 profile', () => {
        expect(parseApiV1BlackBoxArgs(['--recipes-only', '--profile=api-v1-black-box'])).toMatchObject({
            profile: 'api-v1-black-box',
            recipesOnly: true
        });
    });

    it('builds a canonical Postgres validation environment with local run overrides', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres', '--port=18080']);
        const env = toApiV1BlackBoxEnvironment(options, {});
        const [plan] = toManagedApiServerPlans(options, env, '/tmp/api-v1-bb');

        expect(plan?.env).toMatchObject({
            RALLAR_API_CONFIGURATION_PROFILE: 'prod-in-memory',
            PORT: '18080',
            RALLAR_SQL_BACKEND: 'postgres',
            RALLAR_PGLITE_SCHEMA_INIT: 'disabled',
            RALLAR_DB_PUBSUB: 'postgres',
            DATABASE_URL: 'postgres://app:app@localhost:5432/appdb',
            RALLAR_LOGIN_IP_RATE_LIMIT: '100',
            RALLAR_LOGIN_USER_RATE_LIMIT: '100',
            RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'local-api-v1-black-box-operator-secret',
            RALLAR_AUTH_CREDENTIAL_SECRET: 'local-api-v1-black-box-auth-credential-secret-v1',
            RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON: '[{"documentType":"black-box-map","rollout":"production"}]'
        });
    });

    it('creates a bounded execution token independently of caller-provided run IDs', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            `--run-id=${'x'.repeat(10_000)}`
        ]);
        const first = toApiV1BlackBoxEnvironment(options, {
            RALLAR_BB_EXECUTION_TOKEN: 'caller-controlled-token'
        });
        const second = toApiV1BlackBoxEnvironment(options, {});

        expect(first.RALLAR_BB_RUN_ID).toHaveLength(10_000);
        expect(first.RALLAR_BB_EXECUTION_TOKEN).toMatch(/^[a-f0-9]{24}$/);
        expect(first.RALLAR_BB_EXECUTION_TOKEN).toHaveLength(24);
        expect(second.RALLAR_BB_EXECUTION_TOKEN).toMatch(/^[a-f0-9]{24}$/);
        expect(second.RALLAR_BB_EXECUTION_TOKEN).not.toBe(first.RALLAR_BB_EXECUTION_TOKEN);
    });

    it('preserves an explicit managed API CRDT document policy', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=pglite-memory']);
        const policy = '[{"documentType":"custom-map","rollout":"development"}]';
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON: policy
        });

        expect(env.RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON).toBe(policy);
    });

    it('preserves explicit managed API login rate limits', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_LOGIN_IP_RATE_LIMIT: '41',
            RALLAR_LOGIN_USER_RATE_LIMIT: '17'
        });

        expect(env.RALLAR_LOGIN_IP_RATE_LIMIT).toBe('41');
        expect(env.RALLAR_LOGIN_USER_RATE_LIMIT).toBe('17');
    });

    it('exposes secondary and tertiary URLs only for a managed cluster run', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--port=18080',
            '--secondary-port=18081',
            '--tertiary-port=18082'
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});

        expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:18080');
        expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:18080');
        expect(env.RALLAR_API_BASE_URL_SECONDARY).toBe('http://127.0.0.1:18081');
        expect(env.RALLAR_WS_BASE_URL_SECONDARY).toBe('ws://127.0.0.1:18081');
        expect(env.RALLAR_API_BASE_URL_TERTIARY).toBe('http://127.0.0.1:18082');
        expect(env.RALLAR_WS_BASE_URL_TERTIARY).toBe('ws://127.0.0.1:18082');
    });

    it('plans isolated process URLs and log files for all three managed servers', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--port=18080',
            '--secondary-port=18081',
            '--tertiary-port=18082'
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});

        expect(toManagedApiServerPlans(options, env, '/tmp/api-v1-bb')).toEqual([
            expect.objectContaining({
                port: 18080,
                baseUrl: 'http://127.0.0.1:18080',
                logPath: '/tmp/api-v1-bb/api-v1-server.log',
                env: expect.objectContaining({
                    PORT: '18080',
                    RALLAR_API_BASE_URL: 'http://127.0.0.1:18080',
                    RALLAR_WS_BASE_URL: 'ws://127.0.0.1:18080'
                })
            }),
            expect.objectContaining({
                port: 18081,
                baseUrl: 'http://127.0.0.1:18081',
                logPath: '/tmp/api-v1-bb/api-v1-server-secondary.log',
                env: expect.objectContaining({
                    PORT: '18081',
                    RALLAR_API_BASE_URL: 'http://127.0.0.1:18081',
                    RALLAR_WS_BASE_URL: 'ws://127.0.0.1:18081'
                })
            }),
            expect.objectContaining({
                port: 18082,
                baseUrl: 'http://127.0.0.1:18082',
                logPath: '/tmp/api-v1-bb/api-v1-server-tertiary.log',
                env: expect.objectContaining({
                    PORT: '18082',
                    RALLAR_API_BASE_URL: 'http://127.0.0.1:18082',
                    RALLAR_WS_BASE_URL: 'ws://127.0.0.1:18082'
                })
            })
        ]);
    });

    it('keeps runner targets and unrelated caller variables out of API child processes', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
            '--tertiary-port=18082'
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'operator-secret',
            RALLAR_AUTH_CREDENTIAL_SECRET: 'credential-secret-at-least-32-characters',
            RUNNER_ONLY_SENTINEL: 'must-not-reach-child'
        });

        for (const plan of toManagedApiServerPlans(options, env, '/tmp/api-v1-bb')) {
            expect(plan.env.RALLAR_API_CONFIGURATION_PROFILE).toBe('prod-in-memory');
            expect(plan.env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET).toBe('operator-secret');
            expect(plan.env.RALLAR_AUTH_CREDENTIAL_SECRET).toBe(
                'credential-secret-at-least-32-characters'
            );
            expect(plan.env).not.toHaveProperty('RALLAR_API_BASE_URL_SECONDARY');
            expect(plan.env).not.toHaveProperty('RALLAR_WS_BASE_URL_SECONDARY');
            expect(plan.env).not.toHaveProperty('RALLAR_API_BASE_URL_TERTIARY');
            expect(plan.env).not.toHaveProperty('RALLAR_WS_BASE_URL_TERTIARY');
            expect(plan.env).not.toHaveProperty('RALLAR_BB_RUN_ID');
            expect(plan.env).not.toHaveProperty('RALLAR_BB_EXECUTION_TOKEN');
            expect(plan.env).not.toHaveProperty('RALLAR_STATE_WRITE_EVIDENCE_OUTPUT');
            expect(plan.env).not.toHaveProperty('RUNNER_ONLY_SENTINEL');
        }
    });

    it('preserves explicit black-box operator token secret values', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'custom-operator-secret'
        });

        expect(env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET).toBe('custom-operator-secret');
    });

    it('preserves explicit Postgres DATABASE_URL values', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
        const env = toApiV1BlackBoxEnvironment(options, {
            DATABASE_URL: 'postgres://custom:custom@localhost:15432/customdb'
        });

        expect(env.RALLAR_SQL_BACKEND).toBe('postgres');
        expect(env.DATABASE_URL).toBe('postgres://custom:custom@localhost:15432/customdb');
    });

    it('preserves explicit API URLs in recipes-only mode', () => {
        const options = parseApiV1BlackBoxArgs(['--recipes-only']);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_API_BASE_URL: 'http://127.0.0.1:19999',
            RALLAR_WS_BASE_URL: 'ws://127.0.0.1:19999'
        });

        expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:19999');
        expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:19999');
    });

    it('builds a canonical pglite-memory validation environment without file settings', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=pglite-memory',
            '--port=19090',
            '--run-id=local-123'
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});
        const storageEnvironment = toManagedPGliteRunEnvironment(options, env, {
            dataDir: '/tmp/api-v1-bb/data',
            snapshotDir: '/tmp/api-v1-bb/snapshots'
        });
        const [plan] = toManagedApiServerPlans(options, storageEnvironment, '/tmp/api-v1-bb');

        expect(env.PORT).toBe('19090');
        expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:19090');
        expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:19090');
        expect(env.RALLAR_BB_RUN_ID).toBe('local-123');
        expect(plan?.env).toMatchObject({
            RALLAR_API_CONFIGURATION_PROFILE: 'prod-in-memory',
            RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR: '/tmp/api-v1-bb/snapshots'
        });
        expect(plan?.env).not.toHaveProperty('RALLAR_SQL_BACKEND');
        expect(plan?.env).not.toHaveProperty('RALLAR_PGLITE_DATA_DIR');
        expect(plan?.env).not.toHaveProperty('DATABASE_URL');
    });

    it('builds a canonical pglite-file validation environment with one run directory', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=pglite-file']);
        const env = toManagedPGliteRunEnvironment(
            options,
            toApiV1BlackBoxEnvironment(options, {}),
            {
                dataDir: '/tmp/api-v1-bb/data',
                snapshotDir: '/tmp/api-v1-bb/snapshots'
            }
        );
        const [plan] = toManagedApiServerPlans(options, env, '/tmp/api-v1-bb');

        expect(plan?.env).toMatchObject({
            RALLAR_API_CONFIGURATION_PROFILE: 'prod-in-memory',
            RALLAR_SQL_BACKEND: 'pglite-file',
            RALLAR_PGLITE_DATA_DIR: '/tmp/api-v1-bb/data',
            RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR: '/tmp/api-v1-bb/snapshots'
        });
        expect(plan?.env).not.toHaveProperty('RALLAR_PGLITE_SCHEMA_INIT');
        expect(plan?.env).not.toHaveProperty('RALLAR_DB_PUBSUB');
    });

    it('builds the api-v1 Deno server command', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);

        expect(toApiV1ServerCommand(options)).toEqual([
            'deno',
            'run',
            '--config',
            'apps/api-v1/deno.json',
            '--allow-net',
            '--allow-env',
            '--allow-read',
            'apps/api-v1/src/main.ts'
        ]);
    });

    it('runs every three-server cluster recipe through the cluster profile', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
            '--tertiary-port=18082'
        ]);

        expect(toClusterRecipeMatrixCommand(options, '/tmp/api-v1-bb')).toEqual([
            'deno',
            'run',
            '-A',
            'packages/shared-test/black-box-runner/recipe-matrix.mts',
            '--profile=api-v1-black-box-cluster',
            '--require-gates',
            '--artifact-dir=/tmp/api-v1-bb/cluster'
        ]);
    });

    it('plans only the selected cluster profile under the cluster artifact directory', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
            '--tertiary-port=18082',
            '--cluster-only',
            '--cluster-profile=api-v1-black-box-medium-scale'
        ]);

        expect(toRecipeMatrixCommands(options, '/tmp/api-v1-bb')).toEqual([
            [
                'deno',
                'run',
                '-A',
                'packages/shared-test/black-box-runner/recipe-matrix.mts',
                '--profile=api-v1-black-box-medium-scale',
                '--require-gates',
                '--artifact-dir=/tmp/api-v1-bb/cluster'
            ]
        ]);
    });

    it('preserves the ordinary profile before the default three-server cluster profile', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
            '--tertiary-port=18082'
        ]);

        expect(
            toRecipeMatrixCommands(options, '/tmp/api-v1-bb').map((command) => command.find((argument) => argument.startsWith('--profile=')))
        ).toEqual(['--profile=api-v1-black-box', '--profile=api-v1-black-box-cluster']);
    });
});
