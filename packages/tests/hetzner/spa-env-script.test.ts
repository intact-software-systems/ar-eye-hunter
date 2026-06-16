import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const controlServerConfigPath = path.join(repoRoot, 'apps/rallar-black-box-control-server/deno.json');

describe('Hetzner SPA public env wiring', () => {
    it('provides a shared helper that maps public Rallar env to Vite SPA env', async () => {
        const helper = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/rallar-public-spa-env.sh'),
            'utf8',
        );

        expect(helper).toContain('apply_rallar_public_spa_defaults');
        expect(helper).toContain('VITE_RALLAR_PROVIDER=browser-rallar');
        expect(helper).toContain('VITE_RALLAR_API_BASE_URL="${RALLAR_API_BASE_URL}"');
        expect(helper).toContain('VITE_RALLAR_CONTROL_URL="${RALLAR_BLACK_BOX_CONTROL_URL}"');
        expect(helper).toContain('VITE_RALLAR_ROOM_ID="${RALLAR_BLACK_BOX_ROOM_ID}"');
        expect(helper).toContain('VITE_RALLAR_RUNNER_AGENT_PREFIX="${RALLAR_BLACK_BOX_AGENT_PREFIX}"');
        expect(helper).toContain('VITE_RALLAR_RUNNER_AGENT_COUNT="${RALLAR_BLACK_BOX_AGENT_COUNT}"');
        expect(helper).toContain('/etc/rallar/black-box-spa.env');
    });

    it('uses the shared helper for initial deploy and controlled rollout builds', async () => {
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/02-deploy-controller.sh'),
            'utf8',
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/08-rollout-controller.sh'),
            'utf8',
        );

        for (const script of [deployScript, rolloutScript]) {
            expect(script).toContain('source "${SCRIPT_DIR}/rallar-public-spa-env.sh"');
            expect(script).toContain('build_rallar_black_box_spa "${RALLAR_CHECKOUT_DIR}"');
            expect(script).toContain('write_rallar_black_box_spa_env_file');
        }
    });

    it('uses the control-server Deno config for Hetzner cache warming and systemd start', async () => {
        const controlConfig = JSON.parse(await readFile(controlServerConfigPath, 'utf8')) as {
            nodeModulesDir?: unknown;
        };
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/02-deploy-controller.sh'),
            'utf8',
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/08-rollout-controller.sh'),
            'utf8',
        );

        expect(controlConfig.nodeModulesDir).toBe('auto');
        for (const script of [deployScript, rolloutScript]) {
            expect(script).toContain(
                'deno cache --config "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json"',
            );
        }
        expect(deployScript).toContain(
            'deno run --config ${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json',
        );
    });

    it('keeps the headless browser workflow responsible for actual agent count and prefix', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8',
        );
        const startScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/09-start-headless-workers.sh'),
            'utf8',
        );

        expect(workflow).toContain('default: controller');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_PREFIX: ${{ inputs.agent_prefix }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_COUNT: ${{ inputs.agent_count }}');
        expect(workflow).toContain('application_id:');
        expect(workflow).toContain('workspace_id:');
        expect(workflow).toContain('register_before_login:');
        expect(workflow).toContain('RALLAR_BLACK_BOX_APPLICATION_ID: ${{ inputs.application_id }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_WORKSPACE_ID: ${{ inputs.workspace_id }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_REGISTER: ${{ inputs.register_before_login }}');
        expect(workflow).toContain('printf \'RALLAR_BLACK_BOX_REGISTER=%s\\n\'');
        expect(startScript).toContain(
            'RALLAR_BLACK_BOX_APPLICATION_ID="${RALLAR_BLACK_BOX_APPLICATION_ID:-${RALLAR_APPLICATION_ID:-rallar-server}}"',
        );
        expect(startScript).toContain(
            'RALLAR_BLACK_BOX_WORKSPACE_ID="${RALLAR_BLACK_BOX_WORKSPACE_ID:-${RALLAR_WORKSPACE_ID:-default}}"',
        );
    });

    it('lets the headless browser workflow roll out the selected ref before starting agents', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8',
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
            workflow.indexOf('RALLAR_WRITE_HEADLESS_ENV=1 ./09-start-headless-workers.sh'),
        );
    });

    it('keeps public SPA origin allowed for API CORS and control-server browser requests', async () => {
        const helper = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/rallar-public-spa-env.sh'),
            'utf8',
        );
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/02-deploy-controller.sh'),
            'utf8',
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/08-rollout-controller.sh'),
            'utf8',
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
            'utf8',
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
        expect(workflow).toContain('RALLAR_BLACK_BOX_SPA_URL="$4"');
        expect(workflow).toContain('RALLAR_BLACK_BOX_WORKSPACE_ID="${11}"');
    });
});
