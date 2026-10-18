import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { runOwnedTestProcess } from './owned-test-process.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(
    repoRoot,
    'scripts/hosted-rallar/controller/13-configure-metered-turn.sh'
);

describe('configure Metered TURN Hetzner script', () => {
    it('writes Metered secrets to a root-only env file and keeps them out of output and systemd drop-ins', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-metered-turn-'));
        context.onTestFinished(() => rm(tmp, { recursive: true, force: true }));
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

        const result = await runScript(context, {
            RALLAR_REQUIRE_ROOT: '0',
            RALLAR_ETC_DIR: etcDir,
            RALLAR_SYSTEMD_DIR: systemdDir,
            RALLAR_SYSTEMCTL_BIN: fakeSystemctl,
            SYSTEMCTL_LOG: systemctlLog,
            METERED_APP_NAME: 'prod-metered-app',
            METERED_API_KEY: 'super-secret-metered-key'
        });

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

    it('keeps prompted values on one assignment line without exposing the key in output', async (context) => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-metered-prompt-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const etcDir = path.join(fixture, 'etc/rallar');
        const result = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: ['-c', 'printf "%s\\n%s\\n" "$PROMPT_APP" "$PROMPT_KEY" | bash "$METERED_SCRIPT" --no-restart'],
            options: {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    RALLAR_REQUIRE_ROOT: '0',
                    RALLAR_ETC_DIR: etcDir,
                    RALLAR_SYSTEMD_DIR: path.join(fixture, 'etc/systemd/system'),
                    METERED_APP_NAME: '',
                    METERED_API_KEY: '',
                    PROMPT_APP: 'prompted-app',
                    PROMPT_KEY: 'synthetic-prompted-key',
                    METERED_SCRIPT: scriptPath
                }
            }
        });

        expect(await readFile(path.join(etcDir, 'api-v1.secrets.env'), 'utf8')).toBe(
            'RALLAR_ICE_MODE=metered\nMETERED_APP_NAME=prompted-app\nMETERED_API_KEY=synthetic-prompted-key\n'
        );
        expect(result.stdout).not.toContain('synthetic-prompted-key');
        expect(result.stderr).not.toContain('synthetic-prompted-key');
    });

    it('rejects an unsupported prompted key before replacing the secret file', async (context) => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-metered-prompt-invalid-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const etcDir = path.join(fixture, 'etc/rallar');
        const secretFile = path.join(etcDir, 'api-v1.secrets.env');
        const original = 'RALLAR_AUTH_CREDENTIAL_SECRET=prior-secret\n';
        await mkdir(etcDir, { recursive: true });
        await writeFile(secretFile, original);

        await expect(runOwnedTestProcess(context, {
            executable: 'bash',
            args: ['-c', 'printf "%s\\n" "$PROMPT_KEY" | bash "$METERED_SCRIPT" --no-restart'],
            options: {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    RALLAR_REQUIRE_ROOT: '0',
                    RALLAR_ETC_DIR: etcDir,
                    RALLAR_SYSTEMD_DIR: path.join(fixture, 'etc/systemd/system'),
                    METERED_APP_NAME: 'prompted-app',
                    METERED_API_KEY: '',
                    PROMPT_KEY: 'invalid prompted key',
                    METERED_SCRIPT: scriptPath
                }
            }
        })).rejects.toMatchObject({ stderr: expect.stringContaining('simple unquoted environment value') });

        expect(await readFile(secretFile, 'utf8')).toBe(original);
    });

    it('rejects unsupported existing secret assignments without replacing the file', async (context) => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-metered-preserve-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const etcDir = path.join(fixture, 'etc/rallar');
        const secretFile = path.join(etcDir, 'api-v1.secrets.env');
        await mkdir(etcDir, { recursive: true });
        const original = 'RALLAR_AUTH_CREDENTIAL_SECRET="unsupported-quoted-secret"\nRALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=4\n';
        await writeFile(secretFile, original);

        await expect(runScript(context, {
            RALLAR_REQUIRE_ROOT: '0',
            RALLAR_RESTART_SERVICE: '0',
            RALLAR_ETC_DIR: etcDir,
            RALLAR_SYSTEMD_DIR: path.join(fixture, 'etc/systemd/system'),
            METERED_APP_NAME: 'replacement-app',
            METERED_API_KEY: 'replacement-key'
        })).rejects.toMatchObject({ stderr: expect.stringContaining('Unsupported assignment') });

        expect(await readFile(secretFile, 'utf8')).toBe(original);
    });

    it('refuses an unreadable secret path before writing the systemd drop-in', async (context) => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-metered-unreadable-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const etcDir = path.join(fixture, 'etc/rallar');
        const secretFile = path.join(etcDir, 'api-v1.secrets.env');
        const systemdDir = path.join(fixture, 'etc/systemd/system');
        await mkdir(secretFile, { recursive: true });

        await expect(runScript(context, {
            RALLAR_REQUIRE_ROOT: '0',
            RALLAR_RESTART_SERVICE: '0',
            RALLAR_ETC_DIR: etcDir,
            RALLAR_SYSTEMD_DIR: systemdDir,
            METERED_APP_NAME: 'replacement-app',
            METERED_API_KEY: 'replacement-key'
        })).rejects.toThrow();

        expect((await stat(secretFile)).isDirectory()).toBe(true);
        expect(await readdir(etcDir)).toEqual(['api-v1.secrets.env']);
        await expect(access(path.join(systemdDir, 'rallar-api-v1.service.d/10-metered-turn.conf'))).rejects.toThrow();
    });

    it('does not replace a valid secret file with an unsupported new Metered assignment', async (context) => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-metered-input-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const etcDir = path.join(fixture, 'etc/rallar');
        const secretFile = path.join(etcDir, 'api-v1.secrets.env');
        await mkdir(etcDir, { recursive: true });
        const original = 'RALLAR_AUTH_CREDENTIAL_SECRET=prior-secret\n';
        await writeFile(secretFile, original);

        await expect(runScript(context, {
            RALLAR_REQUIRE_ROOT: '0',
            RALLAR_RESTART_SERVICE: '0',
            RALLAR_ETC_DIR: etcDir,
            RALLAR_SYSTEMD_DIR: path.join(fixture, 'etc/systemd/system'),
            METERED_APP_NAME: 'unsupported app name',
            METERED_API_KEY: 'replacement-key'
        })).rejects.toThrow();

        expect(await readFile(secretFile, 'utf8')).toBe(original);
    });

    it('keeps the optional Metered secret env file wired into future controller deployments', async () => {
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
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

async function runScript(context: TestContext, env: Record<string, string>) {
    return await runOwnedTestProcess(context, {
        executable: 'bash',
        args: [scriptPath],
        options: {
            cwd: repoRoot,
            env: {
                ...process.env,
                ...env
            }
        }
    });
}
