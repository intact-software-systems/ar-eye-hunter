import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';

import { runOwnedTestProcess, type OwnedTestProcessOutcome } from './owned-test-process.ts';

interface ScriptRunInput {
    readonly scriptPath: string;
    readonly stubDirectory: string;
    readonly environment: NodeJS.ProcessEnv;
}

const repoRoot = path.resolve(__dirname, '../../..');
const controllerDirectory = path.join(repoRoot, 'scripts/hosted-rallar/controller');
const helperScriptPath = path.join(controllerDirectory, 'rallar-api-prod-profile.sh');
const deployScriptPath = path.join(controllerDirectory, '02-deploy-controller.sh');
const statusScriptPath = path.join(controllerDirectory, '07-status-controller.sh');
const rolloutScriptPath = path.join(controllerDirectory, '08-rollout-controller.sh');
const controllerDatabaseUrlPattern = /^postgres:\/\/rallar:[0-9a-f]{64}@127\.0\.0\.1:5432\/rallar_api_v1$/u;

// Every stub appends its argv, and runuser also its stdin and the DATABASE_URL it inherited, to one ordered log.
const recordingStub = '#!/usr/bin/env bash\nprintf "%s %s\\n" "$(basename "$0")" "$*" >> "$STUB_LOG"\n';
const runuserStub = [
    '#!/usr/bin/env bash',
    'printf "runuser %s database_url_env=%s\\n" "$*" "${DATABASE_URL:-}" >> "$STUB_LOG"',
    'if [[ "$4" == psql ]]; then cat >> "$STUB_LOG"; fi',
    'if [[ -n "${STUB_FAIL_ON:-}" && "$*" == *"${STUB_FAIL_ON}"* ]]; then exit 1; fi',
    ''
].join('\n');

async function createStubDirectory(context: TestContext, stubs: Readonly<Record<string, string>>): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-prod-profile-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const binDirectory = path.join(directory, 'bin');
    await mkdir(binDirectory);
    for (const [name, body] of Object.entries(stubs)) {
        await writeFile(path.join(binDirectory, name), body);
        await chmod(path.join(binDirectory, name), 0o755);
    }
    return directory;
}

async function runScript(context: TestContext, input: ScriptRunInput): Promise<OwnedTestProcessOutcome> {
    return await runOwnedTestProcess(context, {
        executable: 'bash',
        args: [input.scriptPath],
        options: {
            env: {
                PATH: `${path.join(input.stubDirectory, 'bin')}:${process.env.PATH}`,
                LANG: 'C',
                LC_ALL: 'C',
                STUB_LOG: path.join(input.stubDirectory, 'stub.log'),
                ...input.environment
            }
        }
    });
}

async function readStubLog(stubDirectory: string): Promise<string> {
    return await readFile(path.join(stubDirectory, 'stub.log'), 'utf8').catch(() => '');
}

async function readEnvValue(envFile: string, key: string): Promise<string | undefined> {
    const lines = (await readFile(envFile, 'utf8')).split('\n');
    return lines.filter((line) => line.startsWith(`${key}=`)).at(-1)?.slice(key.length + 1);
}

describe('Hetzner controller API prod profile on the VM Postgres', () => {
    it.for([
        { installed: false, expectedAptInstall: true },
        { installed: true, expectedAptInstall: false }
    ])(
        'installs the distro PostgreSQL server only when it is absent (installed: $installed) and keeps it enabled',
        async ({ installed, expectedAptInstall }, context) => {
            const stubDirectory = await createStubDirectory(context, {
                'dpkg-query': installed ? '#!/usr/bin/env bash\nprintf installed\n' : '#!/usr/bin/env bash\nexit 1\n',
                apt: recordingStub,
                systemctl: recordingStub
            });
            const ubuntuSources = path.join(stubDirectory, 'ubuntu.sources');
            await writeFile(ubuntuSources, 'Types: deb\n');

            const { stdout } = await runScript(context, {
                scriptPath: helperScriptPath,
                stubDirectory,
                environment: {
                    RALLAR_API_PROD_PROFILE_SELF_TEST: 'install-server',
                    RALLAR_APT_UBUNTU_SOURCES_FILE: ubuntuSources,
                    TMPDIR: stubDirectory
                }
            });

            expect(stdout).toContain('installedApiPostgresServer=true');
            const calls = (await readStubLog(stubDirectory)).trim().split('\n');
            expect(calls.includes('apt install -y postgresql')).toBe(expectedAptInstall);
            expect(calls.at(-1)).toBe('systemctl enable --now postgresql.service');
        }
    );

    it('wipes the hosted API database and applies the Prisma migrations as the service user', async (context) => {
        const stubDirectory = await createStubDirectory(context, { runuser: runuserStub });
        const password = 'a'.repeat(64);
        const databaseUrl = `postgres://rallar:${password}@127.0.0.1:5432/rallar_api_v1`;
        const envFile = path.join(stubDirectory, 'api-v1.env');
        await writeFile(envFile, `PORT=8080\nDATABASE_URL=${databaseUrl}\n`);
        const checkoutDir = path.join(stubDirectory, 'checkout');

        const { stdout, stderr } = await runScript(context, {
            scriptPath: helperScriptPath,
            stubDirectory,
            environment: {
                RALLAR_API_PROD_PROFILE_SELF_TEST: 'reset-store',
                RALLAR_API_ENV_FILE: envFile,
                RALLAR_API_STORE_FAILURE_FILE: path.join(stubDirectory, 'api-v1.store-failure'),
                RALLAR_CHECKOUT_DIR: checkoutDir
            }
        });

        expect(stdout).toContain('resetApiPostgresStore=true');
        expect(`${stdout}${stderr}`).not.toContain(password);
        const log = await readStubLog(stubDirectory);
        const roleAt = log.indexOf(`ALTER ROLE rallar WITH LOGIN PASSWORD '${password}';`);
        const dropAt = log.indexOf('DROP DATABASE IF EXISTS rallar_api_v1 WITH (FORCE);');
        const createAt = log.indexOf('CREATE DATABASE rallar_api_v1 OWNER rallar;');
        const migrateLine = [
            'runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno deno task',
            `--config ${checkoutDir}/apps/api-v1/deno.json prisma migrate deploy`,
            `database_url_env=${databaseUrl}`
        ].join(' ');
        const migrateAt = log.indexOf(migrateLine);
        expect(log).toContain('runuser -u postgres -- psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -d postgres');
        expect(roleAt).toBeGreaterThan(-1);
        expect(dropAt).toBeGreaterThan(roleAt);
        expect(createAt).toBeGreaterThan(dropAt);
        expect(migrateAt).toBeGreaterThan(createAt);
        // The password reaches psql on stdin and Prisma through the environment, never through an argv.
        for (const line of log.split('\n').filter((entry) => entry.startsWith('runuser '))) {
            expect(line.replace(/ database_url_env=.*$/u, '')).not.toContain(password);
        }
    });

    it('refuses to wipe a store without the controller-owned loopback DATABASE_URL', async (context) => {
        const stubDirectory = await createStubDirectory(context, { runuser: runuserStub });
        const envFile = path.join(stubDirectory, 'api-v1.env');
        await writeFile(envFile, 'DATABASE_URL=postgres://someone:else@db.example.test:5432/other?schema=public\n');

        await expect(runScript(context, {
            scriptPath: helperScriptPath,
            stubDirectory,
            environment: {
                RALLAR_API_PROD_PROFILE_SELF_TEST: 'reset-store',
                RALLAR_API_ENV_FILE: envFile,
                RALLAR_CHECKOUT_DIR: path.join(stubDirectory, 'checkout')
            }
        })).rejects.toMatchObject({ stderr: expect.stringContaining('Missing the controller DATABASE_URL') });
        expect(await readStubLog(stubDirectory)).toBe('');
    });

    it('writes one generated loopback DATABASE_URL without a schema parameter and keeps it across rollouts', async (context) => {
        const stubDirectory = await createStubDirectory(context, {});
        const envFile = path.join(stubDirectory, 'api-v1.env');
        await writeFile(envFile, 'PORT=8080\nRALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS=operations-admin\n');
        const environment = { RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'write-api-prod-environment', RALLAR_API_ENV_FILE: envFile };

        const first = await runScript(context, { scriptPath: rolloutScriptPath, stubDirectory, environment });
        const databaseUrl = await readEnvValue(envFile, 'DATABASE_URL');
        await runScript(context, { scriptPath: rolloutScriptPath, stubDirectory, environment });

        expect(first.stdout).toContain('wroteApiProdEnvironment=true');
        expect(databaseUrl).toMatch(controllerDatabaseUrlPattern);
        expect(`${first.stdout}${first.stderr}`).not.toContain(databaseUrl);
        expect(await readEnvValue(envFile, 'DATABASE_URL')).toBe(databaseUrl);
        expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    });

    it.for([
        { label: 'the rollout input', requested: 'operations-admin', current: 'kept-operator', expected: /^operations-admin$/u },
        { label: 'the VM value', requested: '', current: 'kept-operator', expected: /^kept-operator$/u },
        { label: 'a generated non-demo id', requested: undefined, current: undefined, expected: /^hosted-operator-[0-9a-f]{16}$/u }
    ])('keeps the operator allowlist the prod profile requires from $label', async ({ requested, current, expected }, context) => {
        const stubDirectory = await createStubDirectory(context, {});
        const envFile = path.join(stubDirectory, 'api-v1.env');
        await writeFile(envFile, current === undefined ? 'PORT=8080\n' : `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS=${current}\n`);

        await runScript(context, {
            scriptPath: rolloutScriptPath,
            stubDirectory,
            environment: {
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'write-api-prod-environment',
                RALLAR_API_ENV_FILE: envFile,
                ...(requested === undefined ? {} : { RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS: requested })
            }
        });
        const operatorClientIds = await readEnvValue(envFile, 'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS');
        await runScript(context, {
            scriptPath: rolloutScriptPath,
            stubDirectory,
            environment: { RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'write-api-prod-environment', RALLAR_API_ENV_FILE: envFile }
        });

        expect(operatorClientIds).toMatch(expected);
        expect(await readEnvValue(envFile, 'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS')).toBe(operatorClientIds);
    });

    it('rolls out and deploys by wiping the store after the API stops and before it starts again', async () => {
        const rolloutScript = await readFile(rolloutScriptPath, 'utf8');
        const deployScript = await readFile(deployScriptPath, 'utf8');

        expect(rolloutScript).toMatch(
            /install_rallar_api_postgres_server\n[\s\S]*systemctl stop "\$\{service\}"[\s\S]*write_api_prod_profile_environment\n[\s\S]*reset_rallar_api_postgres_store "\$\{RALLAR_CHECKOUT_DIR\}"[\s\S]*systemctl start rallar-api-v1\.service/u
        );
        expect(deployScript).toMatch(
            /install_rallar_api_postgres_server\n[\s\S]*cat >\/etc\/rallar\/api-v1\.env[\s\S]*systemctl stop rallar-api-v1\.service[\s\S]*reset_rallar_api_postgres_store "\$\{RALLAR_CHECKOUT_DIR\}" "\$\{RALLAR_API_DATABASE_URL\}"\n[\s\S]*systemctl enable --now rallar-api-v1\.service/u
        );
        expect(deployScript).toContain('After=network-online.target postgresql.service');
        expect(deployScript).toContain('Wants=network-online.target postgresql.service');
    });

    it.for([
        { profile: 'prod-in-memory', warns: true },
        { profile: 'prod', warns: false }
    ])('reports the API profile $profile and warns unless it is the controller prod profile', async ({ profile, warns }, context) => {
        const stubDirectory = await createStubDirectory(context, {
            systemctl: recordingStub,
            journalctl: recordingStub,
            free: recordingStub
        });
        const envFile = path.join(stubDirectory, 'api-v1.env');
        await writeFile(envFile, `RALLAR_API_CONFIGURATION_PROFILE=${profile}\n`);

        const { stdout } = await runScript(context, {
            scriptPath: statusScriptPath,
            stubDirectory,
            environment: { RALLAR_API_ENV_FILE: envFile }
        });

        expect(stdout).toContain(`RALLAR_API_CONFIGURATION_PROFILE=${profile}`);
        expect(stdout.includes('WARNING:')).toBe(warns);
        expect(await readStubLog(stubDirectory)).toContain('systemctl status postgresql.service --no-pager');
    });

    it.for([
        { stage: 'wipe', failOn: 'psql' },
        { stage: 'migrations', failOn: 'prisma migrate deploy' }
    ])('marks the store unusable with an ::error:: when the $stage fails', async ({ stage, failOn }, context) => {
        const stubDirectory = await createStubDirectory(context, { runuser: runuserStub });
        const envFile = path.join(stubDirectory, 'api-v1.env');
        await writeFile(envFile, `DATABASE_URL=postgres://rallar:${'a'.repeat(64)}@127.0.0.1:5432/rallar_api_v1\n`);
        const failureFile = path.join(stubDirectory, 'api-v1.store-failure');

        await expect(runScript(context, {
            scriptPath: helperScriptPath,
            stubDirectory,
            environment: {
                RALLAR_API_PROD_PROFILE_SELF_TEST: 'reset-store',
                RALLAR_API_ENV_FILE: envFile,
                RALLAR_API_STORE_FAILURE_FILE: failureFile,
                RALLAR_CHECKOUT_DIR: path.join(stubDirectory, 'checkout'),
                STUB_FAIL_ON: failOn
            }
        })).rejects.toMatchObject({ stderr: expect.stringMatching(new RegExp(`^::error::.*${stage}`, 'mu')) });
        expect(await readFile(failureFile, 'utf8')).toContain(stage);
    });

    it('clears the unusable-store mark once the wipe and migrations succeed', async (context) => {
        const stubDirectory = await createStubDirectory(context, { runuser: runuserStub });
        const envFile = path.join(stubDirectory, 'api-v1.env');
        await writeFile(envFile, `DATABASE_URL=postgres://rallar:${'a'.repeat(64)}@127.0.0.1:5432/rallar_api_v1\n`);
        const failureFile = path.join(stubDirectory, 'api-v1.store-failure');
        await writeFile(failureFile, 'The migrations of the API-v1 Postgres store failed.\n');

        await runScript(context, {
            scriptPath: helperScriptPath,
            stubDirectory,
            environment: {
                RALLAR_API_PROD_PROFILE_SELF_TEST: 'reset-store',
                RALLAR_API_ENV_FILE: envFile,
                RALLAR_API_STORE_FAILURE_FILE: failureFile,
                RALLAR_CHECKOUT_DIR: path.join(stubDirectory, 'checkout')
            }
        });

        await expect(stat(failureFile)).rejects.toThrow();
    });

    it.for([
        { storeFailed: true, startsApi: false },
        { storeFailed: false, startsApi: true }
    ])('the rollout error handler starts the API again only on a usable store (store failed: $storeFailed)', async ({ storeFailed, startsApi }, context) => {
        const stubDirectory = await createStubDirectory(context, { systemctl: recordingStub });
        const failureFile = path.join(stubDirectory, 'api-v1.store-failure');
        if (storeFailed) {
            await writeFile(failureFile, 'The migrations of the API-v1 Postgres store failed.\n');
        }

        const { stderr } = await runScript(context, {
            scriptPath: rolloutScriptPath,
            stubDirectory,
            environment: {
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'restart-after-failure',
                RALLAR_API_STORE_FAILURE_FILE: failureFile
            }
        });

        const calls = (await readStubLog(stubDirectory)).trim().split('\n');
        expect(calls.includes('systemctl start rallar-api-v1.service')).toBe(startsApi);
        expect(calls).toContain('systemctl start rallar-black-box-control.service');
        expect(stderr.includes('::error::')).toBe(storeFailed);
    });

    it('reports an unusable store in the status', async (context) => {
        const stubDirectory = await createStubDirectory(context, {
            systemctl: recordingStub,
            journalctl: recordingStub,
            free: recordingStub
        });
        const envFile = path.join(stubDirectory, 'api-v1.env');
        await writeFile(envFile, 'RALLAR_API_CONFIGURATION_PROFILE=prod\n');
        const failureFile = path.join(stubDirectory, 'api-v1.store-failure');
        await writeFile(failureFile, 'The migrations of the API-v1 Postgres store failed.\n');

        const { stdout } = await runScript(context, {
            scriptPath: statusScriptPath,
            stubDirectory,
            environment: { RALLAR_API_ENV_FILE: envFile, RALLAR_API_STORE_FAILURE_FILE: failureFile }
        });

        expect(stdout).toContain('ERROR: The migrations of the API-v1 Postgres store failed.');
    });
});
