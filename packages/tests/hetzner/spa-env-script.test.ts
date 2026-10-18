import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const controlServerConfigPath = path.join(repoRoot, 'apps/rallar-black-box-control-server/deno.json');
const execFileAsync = promisify(execFile);

async function createEnvironmentFixture(context: TestContext): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-env-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

describe('Hetzner SPA public env wiring', () => {
    it('provides a shared helper that maps public Rallar env to Vite SPA env', async () => {
        const helper = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-public-spa-env.sh'),
            'utf8'
        );

        expect(helper).toContain('apply_rallar_public_spa_defaults');
        expect(helper).toContain('VITE_RALLAR_PROVIDER=browser-rallar');
        expect(helper).toContain('VITE_RALLAR_API_BASE_URL="${RALLAR_API_BASE_URL}"');
        expect(helper).toContain('VITE_RALLAR_CONTROL_URL="${RALLAR_BLACK_BOX_CONTROL_URL}"');
        expect(helper).toContain('VITE_RALLAR_ROOM_ID="${RALLAR_BLACK_BOX_ROOM_ID}"');
        expect(helper).toContain('VITE_RALLAR_RUNNER_AGENT_PREFIX="${RALLAR_BLACK_BOX_AGENT_PREFIX}"');
        expect(helper).toContain('VITE_RALLAR_RUNNER_AGENT_COUNT="${RALLAR_BLACK_BOX_AGENT_COUNT}"');
        expect(helper).toContain('npm --prefix "${checkout_dir}" --workspace rallar-black-box run build');
        expect(helper).toContain('npm --prefix "${checkout_dir}" --workspace rallar-black-box-headless run build');
        expect(helper).toContain('/etc/rallar/black-box-spa.env');
    });

    it('uses the shared helper for initial deploy and controlled rollout builds', async () => {
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
            'utf8'
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh'),
            'utf8'
        );

        for (const script of [deployScript, rolloutScript]) {
            expect(script).toContain('source "${SCRIPT_DIR}/rallar-public-spa-env.sh"');
            expect(script).toContain('build_rallar_black_box_spa "${RALLAR_CHECKOUT_DIR}"');
            expect(script).toContain('"${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-headless/dist/"');
            expect(script).toContain('/var/www/rallar-black-box/headless/');
            expect(script).toContain('write_rallar_black_box_spa_env_file');
        }
    });

    it('writes and preserves only the canonical API-v1 controller profile and allowlist', async () => {
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
            'utf8'
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh'),
            'utf8'
        );
        const statusScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/07-status-controller.sh'),
            'utf8'
        );

        expect(deployScript).toContain('\nRALLAR_API_CONFIGURATION_PROFILE=prod\n');
        expect(deployScript).toContain('\nDATABASE_URL=${RALLAR_API_DATABASE_URL}\n');
        // The prod profile owns Metered ICE; the controller keeps local ICE unless the Metered secret file overrides it.
        expect(deployScript).toContain('\nRALLAR_ICE_MODE=local\n');
        expect(deployScript).toContain('chmod 0600 /etc/rallar/api-v1.env');
        expect(rolloutScript).toContain('normalize_api_environment_allowlist');
        expect(rolloutScript).toContain(
            'printf \'RALLAR_API_CONFIGURATION_PROFILE=prod\\nRALLAR_ICE_MODE=local\\n\''
        );
        expect(rolloutScript).toContain('install -m 0600 -o root -g root');
        expect(statusScript).toContain('RALLAR_API_CONFIGURATION_PROFILE');
        expect(`${deployScript}${rolloutScript}${statusScript}`).not.toContain('prod-in-memory');

        for (
            const removedSettingName of [
                'ENVIRONMENT',
                'API_BASE_URL',
                'RALLAR_SQL_BACKEND',
                'RALLAR_PGLITE_DATA_DIR',
                'RALLAR_PGLITE_SCHEMA_INIT',
                'RALLAR_DB_PUBSUB',
                'AUTH_REGISTRATION_MODE',
                'AUTH_STATIC_CLIENTS_MODE'
            ]
        ) {
            expect(deployScript).not.toMatch(
                new RegExp(`^${removedSettingName}=`, 'mu')
            );
        }
    });

    it('normalizes an existing API env file without logging secrets and keeps mode 0600', async (context) => {
        const temporaryDirectory = await createEnvironmentFixture(context);
        const apiEnvironmentFile = path.join(temporaryDirectory, 'api-v1.env');
        const authSecret = 'auth-secret-that-must-not-be-logged';
        const databaseUrl = `postgres://rallar:${'d'.repeat(64)}@127.0.0.1:5432/rallar_api_v1`;
        await writeFile(
            apiEnvironmentFile,
            [
                'ENVIRONMENT=production',
                'RALLAR_SQL_BACKEND=pglite-memory',
                'RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory',
                'RALLAR_ICE_MODE=metered',
                'UNKNOWN_SETTING=removed',
                `RALLAR_AUTH_CREDENTIAL_SECRET=${authSecret}`,
                `DATABASE_URL=${databaseUrl}`,
                'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE=32',
                ''
            ].join('\n')
        );
        await chmod(apiEnvironmentFile, 0o644);

        const result = await execFileAsync(
            'bash',
            [path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh')],
            {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'normalize-api-environment',
                    RALLAR_API_ENV_FILE: apiEnvironmentFile
                }
            }
        );
        const normalized = await readFile(apiEnvironmentFile, 'utf8');

        expect(normalized).toBe([
            `RALLAR_AUTH_CREDENTIAL_SECRET=${authSecret}`,
            `DATABASE_URL=${databaseUrl}`,
            'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE=32',
            'RALLAR_API_CONFIGURATION_PROFILE=prod',
            'RALLAR_ICE_MODE=local',
            ''
        ].join('\n'));
        expect((await stat(apiEnvironmentFile)).mode & 0o777).toBe(0o600);
        for (const secret of [authSecret, databaseUrl]) {
            expect(result.stdout).not.toContain(secret);
            expect(result.stderr).not.toContain(secret);
        }
    });

    it('admits the largest co-located agent cohort through the controller per-IP auth limits', async (context) => {
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
            'utf8'
        );
        const coLocatedLimit = /^CO_LOCATED_AUTH_IP_RATE_LIMIT=(\d+)$/mu.exec(deployScript);
        expect(Number(coLocatedLimit?.[1])).toBeGreaterThanOrEqual(50);
        expect(deployScript).toMatch(/^RALLAR_REGISTRATION_IP_RATE_LIMIT=\$\{CO_LOCATED_AUTH_IP_RATE_LIMIT\}$/mu);
        expect(deployScript).toMatch(/^RALLAR_LOGIN_IP_RATE_LIMIT=\$\{CO_LOCATED_AUTH_IP_RATE_LIMIT\}$/mu);

        const temporaryDirectory = await createEnvironmentFixture(context);
        const apiEnvironmentFile = path.join(temporaryDirectory, 'api-v1.env');
        await writeFile(
            apiEnvironmentFile,
            'RALLAR_REGISTRATION_IP_RATE_LIMIT=200\nRALLAR_LOGIN_IP_RATE_LIMIT=200\n'
        );

        await execFileAsync(
            'bash',
            [path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh')],
            {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'normalize-api-environment',
                    RALLAR_API_ENV_FILE: apiEnvironmentFile
                }
            }
        );

        expect(await readFile(apiEnvironmentFile, 'utf8')).toBe([
            'RALLAR_REGISTRATION_IP_RATE_LIMIT=200',
            'RALLAR_LOGIN_IP_RATE_LIMIT=200',
            'RALLAR_API_CONFIGURATION_PROFILE=prod',
            'RALLAR_ICE_MODE=local',
            ''
        ].join('\n'));
    });

    it('writes non-empty optional API overrides and removes them when rollout inputs are blank', async (context) => {
        const temporaryDirectory = await createEnvironmentFixture(context);
        const apiEnvironmentFile = path.join(temporaryDirectory, 'api-v1.env');
        const rolloutScript = path.join(
            repoRoot,
            'scripts/hosted-rallar/controller/08-rollout-controller.sh'
        );
        const optionalOverrides = {
            RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '7',
            RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '6',
            RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '24',
            RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '3'
        };
        await writeFile(apiEnvironmentFile, 'PORT=8080\n');

        await execFileAsync('bash', [rolloutScript], {
            cwd: repoRoot,
            env: {
                ...process.env,
                ...optionalOverrides,
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'write-api-optional-environment',
                RALLAR_API_ENV_FILE: apiEnvironmentFile
            }
        });

        expect(await readFile(apiEnvironmentFile, 'utf8')).toBe([
            'PORT=8080',
            ...Object.entries(optionalOverrides).map(([name, value]) => `${name}=${value}`),
            ''
        ].join('\n'));

        await execFileAsync('bash', [rolloutScript], {
            cwd: repoRoot,
            env: {
                ...process.env,
                ...Object.fromEntries(Object.keys(optionalOverrides).map((name) => [name, ''])),
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'write-api-optional-environment',
                RALLAR_API_ENV_FILE: apiEnvironmentFile
            }
        });

        expect(await readFile(apiEnvironmentFile, 'utf8')).toBe('PORT=8080\n');
        expect((await stat(apiEnvironmentFile)).mode & 0o777).toBe(0o600);
    });

    it('serves nested SPA entry points before falling back to the operator index', async () => {
        const helper = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-public-spa-env.sh'),
            'utf8'
        );

        expect(helper).toContain('try_files {path} {path}/index.html /index.html');
    });

    it('uses the control-server Deno config for Hetzner cache warming and systemd start', async () => {
        const controlConfig = await readFile(controlServerConfigPath, 'utf8');
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
            'utf8'
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh'),
            'utf8'
        );

        expect(controlConfig).toContain('"nodeModulesDir": "auto"');
        for (const script of [deployScript, rolloutScript]) {
            expect(script).toContain(
                'deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json"'
            );
        }
        expect(deployScript).toContain(
            'deno run --config ${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json'
        );
    });

    it('keeps the headless browser workflow responsible for actual agent count and prefix', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );
        const startScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/09-start-headless-workers.sh'),
            'utf8'
        );

        expect(workflow).toContain('default: controller');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_PREFIX: ${{ inputs.agent_prefix }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_COUNT: ${{ inputs.agent_count }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_START_INDEX: ${{ vars.RALLAR_BLACK_BOX_AGENT_START_INDEX || \'1\' }}');
        expect(workflow).toContain('application_id:');
        expect(workflow).toContain('workspace_id:');
        expect(workflow).toContain('rallar_black_box_username:');
        expect(workflow).toContain('rallar_black_box_password:');
        expect(workflow).toContain('register_before_login:');
        expect(workflow).toContain('RALLAR_BLACK_BOX_APPLICATION_ID: ${{ inputs.application_id }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_WORKSPACE_ID: ${{ inputs.workspace_id }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_REGISTER: ${{ inputs.register_before_login }}');
        expect(workflow).toContain('printf \'RALLAR_BLACK_BOX_AGENT_START_INDEX=%s\\n\'');
        expect(workflow).toContain('printf \'RALLAR_BLACK_BOX_REGISTER=%s\\n\'');
        expect(startScript).toContain(
            'RALLAR_BLACK_BOX_APPLICATION_ID="${RALLAR_BLACK_BOX_APPLICATION_ID:-${RALLAR_APPLICATION_ID:-rallar-server}}"'
        );
        expect(startScript).toContain(
            'RALLAR_BLACK_BOX_WORKSPACE_ID="${RALLAR_BLACK_BOX_WORKSPACE_ID:-${RALLAR_WORKSPACE_ID:-default}}"'
        );
        expect(startScript).toContain(
            'RALLAR_BLACK_BOX_AGENT_START_INDEX="${RALLAR_BLACK_BOX_AGENT_START_INDEX:-1}"'
        );
    });

    it('resolves headless browser credentials from workflow inputs before falling back to secrets', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );

        expect(workflow).toContain('name: Resolve headless credentials');
        expect(workflow.indexOf('name: Resolve headless credentials')).toBeLessThan(
            workflow.indexOf('name: Configure SSH')
        );
        expect(workflow).toContain('RALLAR_BLACK_BOX_USERNAME_SECRET: ${{ secrets.RALLAR_BLACK_BOX_USERNAME }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_PASSWORD_SECRET: ${{ secrets.RALLAR_BLACK_BOX_PASSWORD }}');
        expect(workflow).toContain('jq -r --arg key "$key"');
        expect(workflow).toContain('input_value rallar_black_box_username');
        expect(workflow).toContain('input_value rallar_black_box_password');
        expect(workflow).toContain('RALLAR_BLACK_BOX_USERNAME_SECRET');
        expect(workflow).toContain('RALLAR_BLACK_BOX_PASSWORD_SECRET');
        expect(workflow).toContain('Missing RALLAR_BLACK_BOX_USERNAME/RALLAR_BLACK_BOX_PASSWORD for action=start.');
        expect(workflow).toContain('source "${credentials_file}"');
        expect(workflow).not.toContain('RALLAR_BLACK_BOX_USERNAME: ${{ secrets.RALLAR_BLACK_BOX_USERNAME }}');
        expect(workflow).not.toContain('RALLAR_BLACK_BOX_PASSWORD: ${{ secrets.RALLAR_BLACK_BOX_PASSWORD }}');
    });

    it('lets the headless browser workflow roll out the selected ref before starting agents', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );

        expect(workflow).toContain('ref:');
        expect(workflow).toContain('rollout_before_start:');
        expect(workflow).toContain('RALLAR_REPO_REF: ${{ inputs.ref }}');
        expect(workflow).toContain('RALLAR_ROLLOUT_BEFORE_HEADLESS_START: ${{ inputs.rollout_before_start }}');
        expect(workflow).toContain('RALLAR_API_CORS_ORIGINS: ${{ inputs.api_cors_origins }}');
        expect(workflow).toContain('if should_rollout; then');
        expect(workflow).toContain('./10-stop-headless-workers.sh');
        expect(workflow).toContain('./08-rollout-controller.sh');
        expect(workflow.indexOf('./08-rollout-controller.sh')).toBeLessThan(
            workflow.indexOf('RALLAR_WRITE_HEADLESS_ENV=1 ./09-start-headless-workers.sh')
        );
    });

    it('keeps public SPA origin allowed for API CORS and control-server browser requests', async () => {
        const helper = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-public-spa-env.sh'),
            'utf8'
        );
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
            'utf8'
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh'),
            'utf8'
        );

        expect(helper).toContain('apply_rallar_public_cors_defaults');
        expect(helper).toContain('rallar_public_url_origin "${RALLAR_BLACK_BOX_SPA_URL}"');
        expect(helper).toContain('RALLAR_API_CORS_ORIGINS=');
        expect(helper).toContain('RALLAR_BLACK_BOX_ALLOWED_ORIGINS=');
        expect(deployScript).toContain('apply_rallar_public_cors_defaults');
        expect(deployScript).toContain('CORS_ORIGINS=${RALLAR_API_CORS_ORIGINS}');
        expect(deployScript).toContain('RALLAR_BLACK_BOX_ALLOWED_ORIGINS=${RALLAR_BLACK_BOX_ALLOWED_ORIGINS}');
        expect(rolloutScript).toContain('update_api_cors_origins');
        expect(rolloutScript).toContain('update_control_allowed_origins');
        expect(rolloutScript).toContain('RALLAR_BLACK_BOX_ALLOWED_ORIGINS');
    });

    it('lets the controller deploy action configure SPA public defaults during rollout', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/deploy-hetzner-controller.yml'),
            'utf8'
        );

        expect(workflow).toContain('spa_url:');
        expect(workflow).toContain('control_url:');
        expect(workflow).toContain('api_base_url:');
        expect(workflow).toContain('room_id:');
        expect(workflow).toContain('runner_agent_prefix:');
        expect(workflow).toContain('runner_agent_count:');
        expect(workflow).toContain('application_id:');
        expect(workflow).toContain('workspace_id:');
        expect(workflow).toContain('RALLAR_BLACK_BOX_SPA_URL: ${{ inputs.spa_url }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_CONTROL_URL: ${{ inputs.control_url }}');
        expect(workflow).toContain('RALLAR_API_BASE_URL: ${{ inputs.api_base_url }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_ROOM_ID: ${{ inputs.room_id }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_PREFIX: ${{ inputs.runner_agent_prefix }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_COUNT: ${{ inputs.runner_agent_count }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_APPLICATION_ID: ${{ inputs.application_id }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_WORKSPACE_ID: ${{ inputs.workspace_id }}');
        expect(workflow).toContain('quote() { printf \'%q\' "$1"; }');
        expect(workflow).toContain('rollout_env="${RUNNER_TEMP}/rallar-controller-rollout.env"');
        expect(workflow).toContain(
            'printf \'RALLAR_BLACK_BOX_SPA_URL=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_SPA_URL}")"'
        );
        expect(workflow).toContain(
            'printf \'RALLAR_BLACK_BOX_WORKSPACE_ID=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_WORKSPACE_ID}")"'
        );
        expect(workflow).toContain(
            '"${HETZNER_USER}@${HETZNER_HOST}:/tmp/rallar-controller-rollout.env"'
        );
        expect(workflow).toContain('source /tmp/rallar-controller-rollout.env');
        expect(workflow).toContain('./08-rollout-controller.sh');
    });
});
