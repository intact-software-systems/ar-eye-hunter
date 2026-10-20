import { spawnSync } from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { createDefaultFullStackApiV1WebServer } from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import type { ApiJsonValue } from '../../shared/api/api-json-value.ts';

const API_LAUNCH_TIMEOUT_MS = 30_000;
const LAUNCH_DATABASE_URL = 'postgres://fixture-launch:fixture@127.0.0.1:1/fixture-launch';
const FILE_DATABASE_URL = 'postgres://fixture-file:fixture@127.0.0.1:1/fixture-file';
const METERED_ENVIRONMENT_NAMES = ['METERED_APP_NAME', 'METERED_API_KEY', 'METERED_REGION'];
const FIXTURE_METERED_LINES = ['METERED_APP_NAME=fixture-app', 'METERED_API_KEY=fixture-key', 'METERED_REGION=global'];
const API_DENO_CONFIG = 'apps/api-v1/deno.json';
const API_ENTRY_POINT = 'apps/api-v1/src/main.ts';
const repositoryRoot = new URL('../../../', import.meta.url);

interface IceSourceCase {
    readonly name: string;
    readonly envFileLines: readonly string[];
    readonly launchEnvironment: Readonly<Record<string, string>>;
    readonly expected: {
        readonly iceMode: 'local' | 'metered';
        readonly iceModeVariable: string | null;
        readonly receivedMeteredNames: readonly string[];
    };
}

interface PostgresApiLaunchInput {
    readonly envFileLines: readonly string[];
    readonly launchEnvironment: Readonly<Record<string, string>>;
}

interface PostgresApiLaunchObservation {
    readonly status: number | null;
    readonly stderr: string;
    readonly resolved: ApiJsonValue | null;
}

describe('rallar-black-box local Postgres full-stack API ICE source', () => {
    it.each<IceSourceCase>([
        {
            name: 'an unset launching ICE mode despite env files that select Metered ICE',
            envFileLines: ['RALLAR_ICE_MODE=metered', ...FIXTURE_METERED_LINES],
            launchEnvironment: {},
            expected: { iceMode: 'local', iceModeVariable: null, receivedMeteredNames: [] }
        },
        {
            name: 'an unset launching ICE mode despite env files that carry Metered keys',
            envFileLines: FIXTURE_METERED_LINES,
            launchEnvironment: {},
            expected: { iceMode: 'local', iceModeVariable: null, receivedMeteredNames: [] }
        },
        {
            name: 'a launching environment that exports Metered ICE and its settings',
            envFileLines: [],
            launchEnvironment: {
                RALLAR_ICE_MODE: 'metered',
                METERED_APP_NAME: 'fixture-app',
                METERED_API_KEY: 'fixture-key',
                METERED_REGION: 'global'
            },
            expected: { iceMode: 'metered', iceModeVariable: 'metered', receivedMeteredNames: METERED_ENVIRONMENT_NAMES }
        },
        {
            name: 'an explicit launching local ICE mode despite env files that carry Metered keys',
            envFileLines: FIXTURE_METERED_LINES,
            launchEnvironment: { RALLAR_ICE_MODE: 'local' },
            expected: { iceMode: 'local', iceModeVariable: 'local', receivedMeteredNames: [] }
        }
    ])('resolves $expected.iceMode ICE from $name', async ({ envFileLines, launchEnvironment, expected }) => {
        const observation = await readPostgresApiLaunchObservation({
            envFileLines: [...envFileLines, `DATABASE_URL=${FILE_DATABASE_URL}`],
            launchEnvironment: { ...launchEnvironment, DATABASE_URL: LAUNCH_DATABASE_URL }
        });

        expect(observation.resolved).toEqual({
            outcome: 'resolved',
            iceMode: expected.iceMode,
            databaseMode: 'postgres',
            databaseUrlFromLaunch: true,
            iceModeVariable: expected.iceModeVariable,
            receivedMeteredNames: expected.receivedMeteredNames
        });
        expect(observation.status).toBe(0);
    }, API_LAUNCH_TIMEOUT_MS);

    it('refuses to launch without a DATABASE_URL in the launching environment', async () => {
        const observation = await readPostgresApiLaunchObservation({
            envFileLines: [`DATABASE_URL=${FILE_DATABASE_URL}`],
            launchEnvironment: {}
        });

        expect(observation.status).not.toBe(0);
        expect(observation.resolved).toBeNull();
        expect(observation.stderr).toMatch(/DATABASE_URL.*launching environment/);
    }, API_LAUNCH_TIMEOUT_MS);
});

async function readPostgresApiLaunchObservation(input: PostgresApiLaunchInput): Promise<PostgresApiLaunchObservation> {
    const checkout = await mkdtemp(join(tmpdir(), 'rallar-postgres-api-env-'));
    onTestFinished(() => rm(checkout, { recursive: true, force: true }));
    await mkdir(join(checkout, 'apps', 'api-v1'), { recursive: true });
    await mkdir(join(checkout, 'apps', 'rallar-black-box'), { recursive: true });
    const envFile = `${input.envFileLines.join('\n')}\n`;
    await writeFile(join(checkout, 'apps', 'api-v1', '.env.local'), envFile);
    await writeFile(join(checkout, 'apps', 'api-v1', '.env'), envFile);
    await writeFile(join(checkout, '.env'), envFile);
    const probePath = join(checkout, 'probe-api-configuration.ts');
    await writeFile(probePath, toApiConfigurationProbe());

    const server = createDefaultFullStackApiV1WebServer({
        mode: 'postgres',
        apiBaseUrl: 'http://localhost:18999',
        spaBaseUrl: 'http://localhost:5999'
    });
    const command = toProbeCommand(server.command, probePath);
    const result = spawnSync('/bin/sh', ['-c', command], {
        cwd: join(checkout, 'apps', 'rallar-black-box'),
        encoding: 'utf8',
        env: { ...toInheritedEnvironment(), ...input.launchEnvironment },
        timeout: API_LAUNCH_TIMEOUT_MS
    });
    const stdout = result.stdout.trim();
    return {
        status: result.status,
        stderr: result.stderr.trim(),
        resolved: stdout.length === 0 ? null : JSON.parse(stdout)
    };
}

function toProbeCommand(command: string, probePath: string): string {
    expect(command).toContain(`--config ${API_DENO_CONFIG} `);
    expect(command.endsWith(` ${API_ENTRY_POINT}`)).toBe(true);
    return command
        .replace(`--config ${API_DENO_CONFIG} `, `--config ${fileURLToPath(new URL(API_DENO_CONFIG, repositoryRoot))} `)
        .replace(` ${API_ENTRY_POINT}`, ` ${probePath}`);
}

function toInheritedEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const name of [...METERED_ENVIRONMENT_NAMES, 'RALLAR_ICE_MODE', 'DATABASE_URL']) {
        delete environment[name];
    }
    return environment;
}

function toApiConfigurationProbe(): string {
    const configurationModule = new URL('apps/api-v1/src/configuration/read-api-v1-configuration.ts', repositoryRoot);
    const resources = new URL('apps/api-v1/resources/', repositoryRoot);
    return `
        import { readApiV1Configuration } from ${JSON.stringify(configurationModule.href)};
        const resource = (name: string) => new URL(name, ${JSON.stringify(resources.href)});
        const meteredNames = ${JSON.stringify(METERED_ENVIRONMENT_NAMES)};
        try {
            const configuration = await readApiV1Configuration({
                environment: { get: (name) => Deno.env.get(name) },
                hardwareConcurrency: 4,
                readTextFile: (url) => Deno.readTextFile(url),
                defaultsUrl: resource('configuration/defaults-config.json'),
                profileUrls: {
                    dev: resource('configuration/dev-config.json'),
                    prod: resource('configuration/prod-config.json'),
                    'prod-in-memory': resource('configuration/prod-in-memory-config.json'),
                    'prod-hardened': resource('configuration/prod-hardened-config.json')
                },
                staticClientsUrl: resource('authorised-clients.json')
            });
            console.log(JSON.stringify({
                outcome: 'resolved',
                iceMode: configuration.ice.mode,
                databaseMode: configuration.database.mode,
                databaseUrlFromLaunch: 'url' in configuration.database && configuration.database.url === ${JSON.stringify(LAUNCH_DATABASE_URL)},
                iceModeVariable: Deno.env.get('RALLAR_ICE_MODE') ?? null,
                receivedMeteredNames: meteredNames.filter((name) => Deno.env.get(name) !== undefined)
            }));
        } catch (error) {
            console.log(JSON.stringify({ outcome: 'rejected', message: String(error) }));
        }
    `;
}
