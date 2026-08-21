import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(
    repoRoot,
    'scripts/hetzner/controller/13-configure-metered-turn.sh'
);

describe('configure Metered TURN Hetzner script', () => {
    it('writes Metered secrets to a root-only env file and keeps them out of output and systemd drop-ins', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-metered-turn-'));
        const etcDir = path.join(tmp, 'etc/rallar');
        const systemdDir = path.join(tmp, 'etc/systemd/system');
        const binDir = path.join(tmp, 'bin');
        const systemctlLog = path.join(tmp, 'systemctl.log');
        const fakeSystemctl = path.join(binDir, 'systemctl');

        await mkdir(binDir, { recursive: true });
        await writeFile(
            fakeSystemctl,
            '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n'
        );
        await chmod(fakeSystemctl, 0o755);

        const result = await runScript({
            RALLAR_REQUIRE_ROOT: '0',
            RALLAR_ETC_DIR: etcDir,
            RALLAR_SYSTEMD_DIR: systemdDir,
            RALLAR_SYSTEMCTL_BIN: fakeSystemctl,
            SYSTEMCTL_LOG: systemctlLog,
            METERED_APP_NAME: 'prod-metered-app',
            METERED_API_KEY: 'super-secret-metered-key'
        });

        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain('super-secret-metered-key');
        expect(result.stderr).not.toContain('super-secret-metered-key');

        const secretFile = path.join(etcDir, 'api-v1.secrets.env');
        await expect(readFile(secretFile, 'utf8')).resolves.toBe(
            [
                'RALLAR_ICE_MODE=metered',
                'METERED_APP_NAME=prod-metered-app',
                'METERED_API_KEY=super-secret-metered-key',
                ''
            ].join('\n')
        );

        const secretMode = (await stat(secretFile)).mode & 0o777;
        expect(secretMode).toBe(0o600);

        const dropInFile = path.join(
            systemdDir,
            'rallar-api-v1.service.d/10-metered-turn.conf'
        );
        const dropIn = await readFile(dropInFile, 'utf8');
        expect(dropIn).toContain(`[Service]\nEnvironmentFile=-${secretFile}\n`);
        expect(dropIn).not.toContain('super-secret-metered-key');

        const systemctlCalls = await readFile(systemctlLog, 'utf8');
        expect(systemctlCalls).toContain('daemon-reload\n');
        expect(systemctlCalls).toContain('restart rallar-api-v1.service\n');
    });

    it('keeps the optional Metered secret env file wired into future controller deployments', async () => {
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/02-deploy-controller.sh'),
            'utf8'
        );

        expect(deployScript).toContain('EnvironmentFile=-/etc/rallar/api-v1.secrets.env');
    });

    it('syncs optional Metered GitHub secrets before Hetzner rollout without requiring them', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/deploy-hetzner-controller.yml'),
            'utf8'
        );

        expect(workflow).toContain('name: Sync optional Metered TURN secrets');
        expect(workflow).toContain('METERED_APP_NAME: ${{ secrets.METERED_APP_NAME }}');
        expect(workflow).toContain('METERED_API_KEY: ${{ secrets.METERED_API_KEY }}');
        expect(workflow).toContain('Metered GitHub secrets are not set; keeping existing VM secrets if present.');
        expect(workflow).toContain('Set both METERED_APP_NAME and METERED_API_KEY, or leave both unset.');
        expect(workflow).toContain('./13-configure-metered-turn.sh --no-restart');
        expect(workflow.indexOf('name: Sync optional Metered TURN secrets')).toBeLessThan(
            workflow.indexOf('name: Run controlled rollout')
        );
    });
});

function runScript(env: Record<string, string>): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve) => {
        const child = spawn('bash', [scriptPath], {
            cwd: repoRoot,
            env: {
                ...process.env,
                ...env
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}
