import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseApiV1BlackBoxArgs,
  toApiV1BlackBoxEnvironment,
  toClusterRecipeMatrixCommand,
  toManagedApiServerPlans,
  toRecipeMatrixCommands,
  toApiV1ServerCommand,
} from '@shared-test/black-box-runner/api-v1-black-box-run.mts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('API-v1 runner options and process plans', () => {
  it('starts three API servers for every managed Postgres cluster command', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, 'packages/shared-test/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    for (const scriptName of [
      'bb:api-v1:postgres',
      'bb:api-v1:postgres:crdt',
      'bb:api-v1:postgres:medium-scale',
    ]) {
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
      recipesOnly: false,
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
        '--tertiary-port=18082',
      ]),
    ).toMatchObject({
      backend: 'postgres',
      port: 18080,
      secondaryPort: 18081,
      tertiaryPort: 18082,
    });
  });

  it('selects the opt-in medium-scale cluster profile without the ordinary profile', () => {
    expect(
      parseApiV1BlackBoxArgs([
        '--backend=postgres',
        '--secondary-port=18081',
        '--tertiary-port=18082',
        '--cluster-only',
        '--cluster-profile=api-v1-black-box-medium-scale',
      ]),
    ).toMatchObject({
      backend: 'postgres',
      secondaryPort: 18081,
      tertiaryPort: 18082,
      clusterOnly: true,
      clusterProfile: 'api-v1-black-box-medium-scale',
    });

    expect(() => parseApiV1BlackBoxArgs(['--cluster-only'])).toThrow(
      /cluster-only.*secondary-port.*tertiary-port/i,
    );
  });

  it.each([
    ['same as the primary port', ['--port=18080', '--secondary-port=18080']],
    ['outside the port range', ['--secondary-port=65536']],
    ['with pglite-memory', ['--backend=pglite-memory', '--secondary-port=18081']],
    ['in recipes-only mode', ['--recipes-only', '--secondary-port=18081']],
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
      ['--backend=pglite-memory', '--secondary-port=18081', '--tertiary-port=18082'],
    ],
    ['in recipes-only mode', ['--recipes-only', '--secondary-port=18081', '--tertiary-port=18082']],
  ])('rejects an invalid managed three-server topology %s', (_label, args) => {
    expect(() => parseApiV1BlackBoxArgs(args)).toThrow(/secondary|tertiary/i);
  });

  it('keeps recipes-only mode free of server and migration side effects', () => {
    expect(parseApiV1BlackBoxArgs(['--recipes-only'])).toMatchObject({
      backend: 'postgres',
      profile: 'api-v1-black-box-recipes',
      requireGates: true,
      runMigrations: false,
      recipesOnly: true,
    });
  });

  it('allows recipes-only mode to opt into the full managed API-v1 profile', () => {
    expect(parseApiV1BlackBoxArgs(['--recipes-only', '--profile=api-v1-black-box'])).toMatchObject({
      profile: 'api-v1-black-box',
      recipesOnly: true,
    });
  });

  it('builds Postgres server environment with a local DATABASE_URL default', () => {
    const options = parseApiV1BlackBoxArgs(['--backend=postgres', '--port=18080']);
    const env = toApiV1BlackBoxEnvironment(options, {});

    expect(env.PORT).toBe('18080');
    expect(env.RALLAR_SQL_BACKEND).toBe('postgres');
    expect(env.DATABASE_URL).toBe('postgres://app:app@localhost:5432/appdb');
    expect(env.RALLAR_STATE_STRICT_READ_AUTH).toBe('1');
    expect(env.RALLAR_LOGIN_IP_RATE_LIMIT).toBe('100');
    expect(env.RALLAR_LOGIN_USER_RATE_LIMIT).toBe('100');
    expect(env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET).toBe(
      'local-api-v1-black-box-operator-secret',
    );
    expect(env.AUTH_STATIC_CLIENTS_MODE).toBe('demo');
    expect(env.AUTH_REGISTRATION_MODE).toBe('public');
    expect(env.RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON).toBe(
      '[{"documentType":"black-box-map","rollout":"production"}]',
    );
  });

  it('preserves an explicit managed API CRDT document policy', () => {
    const options = parseApiV1BlackBoxArgs(['--backend=pglite-memory']);
    const policy = '[{"documentType":"custom-map","rollout":"development"}]';
    const env = toApiV1BlackBoxEnvironment(options, {
      RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON: policy,
    });

    expect(env.RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON).toBe(policy);
  });

  it('preserves explicit managed API login rate limits', () => {
    const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
    const env = toApiV1BlackBoxEnvironment(options, {
      RALLAR_LOGIN_IP_RATE_LIMIT: '41',
      RALLAR_LOGIN_USER_RATE_LIMIT: '17',
    });

    expect(env.RALLAR_LOGIN_IP_RATE_LIMIT).toBe('41');
    expect(env.RALLAR_LOGIN_USER_RATE_LIMIT).toBe('17');
  });

  it('exposes secondary and tertiary URLs only for a managed cluster run', () => {
    const options = parseApiV1BlackBoxArgs([
      '--backend=postgres',
      '--port=18080',
      '--secondary-port=18081',
      '--tertiary-port=18082',
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
      '--tertiary-port=18082',
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
          RALLAR_WS_BASE_URL: 'ws://127.0.0.1:18080',
        }),
      }),
      expect.objectContaining({
        port: 18081,
        baseUrl: 'http://127.0.0.1:18081',
        logPath: '/tmp/api-v1-bb/api-v1-server-secondary.log',
        env: expect.objectContaining({
          PORT: '18081',
          RALLAR_API_BASE_URL: 'http://127.0.0.1:18081',
          RALLAR_WS_BASE_URL: 'ws://127.0.0.1:18081',
        }),
      }),
      expect.objectContaining({
        port: 18082,
        baseUrl: 'http://127.0.0.1:18082',
        logPath: '/tmp/api-v1-bb/api-v1-server-tertiary.log',
        env: expect.objectContaining({
          PORT: '18082',
          RALLAR_API_BASE_URL: 'http://127.0.0.1:18082',
          RALLAR_WS_BASE_URL: 'ws://127.0.0.1:18082',
        }),
      }),
    ]);
  });

  it('preserves explicit black-box operator token secret values', () => {
    const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
    const env = toApiV1BlackBoxEnvironment(options, {
      RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'custom-operator-secret',
    });

    expect(env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET).toBe('custom-operator-secret');
  });

  it('preserves explicit Postgres DATABASE_URL values', () => {
    const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
    const env = toApiV1BlackBoxEnvironment(options, {
      DATABASE_URL: 'postgres://custom:custom@localhost:15432/customdb',
    });

    expect(env.RALLAR_SQL_BACKEND).toBe('postgres');
    expect(env.DATABASE_URL).toBe('postgres://custom:custom@localhost:15432/customdb');
  });

  it('preserves explicit API URLs in recipes-only mode', () => {
    const options = parseApiV1BlackBoxArgs(['--recipes-only']);
    const env = toApiV1BlackBoxEnvironment(options, {
      RALLAR_API_BASE_URL: 'http://127.0.0.1:19999',
      RALLAR_WS_BASE_URL: 'ws://127.0.0.1:19999',
    });

    expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:19999');
    expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:19999');
  });

  it('builds pglite-memory server environment without Postgres settings', () => {
    const options = parseApiV1BlackBoxArgs([
      '--backend=pglite-memory',
      '--port=19090',
      '--run-id=local-123',
    ]);
    const env = toApiV1BlackBoxEnvironment(options, {});

    expect(env.PORT).toBe('19090');
    expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:19090');
    expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:19090');
    expect(env.RALLAR_BB_RUN_ID).toBe('local-123');
    expect(env.RALLAR_SQL_BACKEND).toBe('pglite-memory');
    expect(env.RALLAR_PGLITE_DATA_DIR).toBe('memory://');
    expect(env.RALLAR_PGLITE_SCHEMA_INIT).toBe('auto');
    expect(env.RALLAR_DB_PUBSUB).toBe('local');
    expect(env.RALLAR_STATE_STRICT_READ_AUTH).toBe('1');
    expect(env.AUTH_STATIC_CLIENTS_MODE).toBe('demo');
    expect(env.AUTH_REGISTRATION_MODE).toBe('public');
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
      'apps/api-v1/src/main.ts',
    ]);
  });

  it('runs every three-server cluster recipe through the cluster profile', () => {
    const options = parseApiV1BlackBoxArgs([
      '--backend=postgres',
      '--secondary-port=18081',
      '--tertiary-port=18082',
    ]);

    expect(toClusterRecipeMatrixCommand(options, '/tmp/api-v1-bb')).toEqual([
      'deno',
      'run',
      '-A',
      'packages/shared-test/black-box-runner/recipe-matrix.mts',
      '--profile=api-v1-black-box-cluster',
      '--require-gates',
      '--artifact-dir=/tmp/api-v1-bb/cluster',
    ]);
  });

  it('plans only the selected cluster profile under the cluster artifact directory', () => {
    const options = parseApiV1BlackBoxArgs([
      '--backend=postgres',
      '--secondary-port=18081',
      '--tertiary-port=18082',
      '--cluster-only',
      '--cluster-profile=api-v1-black-box-medium-scale',
    ]);

    expect(toRecipeMatrixCommands(options, '/tmp/api-v1-bb')).toEqual([
      [
        'deno',
        'run',
        '-A',
        'packages/shared-test/black-box-runner/recipe-matrix.mts',
        '--profile=api-v1-black-box-medium-scale',
        '--require-gates',
        '--artifact-dir=/tmp/api-v1-bb/cluster',
      ],
    ]);
  });

  it('preserves the ordinary profile before the default three-server cluster profile', () => {
    const options = parseApiV1BlackBoxArgs([
      '--backend=postgres',
      '--secondary-port=18081',
      '--tertiary-port=18082',
    ]);

    expect(
      toRecipeMatrixCommands(options, '/tmp/api-v1-bb').map((command) =>
        command.find((argument) => argument.startsWith('--profile=')),
      ),
    ).toEqual(['--profile=api-v1-black-box', '--profile=api-v1-black-box-cluster']);
  });
});
