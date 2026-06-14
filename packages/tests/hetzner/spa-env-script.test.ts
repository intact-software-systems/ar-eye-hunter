import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');

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

    it('keeps the headless browser workflow responsible for actual agent count and prefix', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8',
        );

        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_PREFIX: ${{ inputs.agent_prefix }}');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_COUNT: ${{ inputs.agent_count }}');
    });
});
