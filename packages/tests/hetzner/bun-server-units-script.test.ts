import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';

import { runOwnedTestProcess } from './owned-test-process.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const rolloutScriptPath = path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh');
const checkoutDir = '/opt/rallar/ar-eye-hunter';
const controlStateDir = '/var/lib/rallar-black-box-control';

// The systemd sandbox that replaces Deno's --allow-net/--allow-env/--allow-read flags on every Bun server.
const bunServerHardening = [
    'Environment=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'PrivateDevices=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    'CapabilityBoundingSet='
];

interface RenderedUnit {
    readonly name: string;
    readonly serviceLines: readonly string[];
}

async function renderRoleUnits(context: TestContext, role: string): Promise<readonly RenderedUnit[]> {
    const unitDir = await mkdtemp(path.join(tmpdir(), `rallar-bun-units-${role}-`));
    context.onTestFinished(() => rm(unitDir, { recursive: true, force: true }));
    const { stdout } = await runOwnedTestProcess(context, {
        executable: 'bash',
        args: [rolloutScriptPath],
        options: {
            env: {
                PATH: process.env.PATH,
                LANG: 'C',
                LC_ALL: 'C',
                RALLAR_CONTROLLER_ROLE: role,
                RALLAR_CHECKOUT_DIR: checkoutDir,
                RALLAR_SYSTEMD_UNIT_DIR: unitDir,
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'write-role-units'
            }
        }
    });
    expect(stdout).toContain('wroteRoleUnits=true');
    const names = (await readdir(unitDir)).toSorted();
    return await Promise.all(names.map(async (name) => ({
        name,
        serviceLines: toServiceSectionLines(await readFile(path.join(unitDir, name), 'utf8'))
    })));
}

function toServiceSectionLines(unit: string): readonly string[] {
    const lines = unit.split('\n');
    const start = lines.indexOf('[Service]');
    const end = lines.findIndex((line, index) => index > start && line.startsWith('['));
    return lines.slice(start + 1, end).filter((line) => line !== '');
}

describe('Bun server systemd units', () => {
    it.for([
        {
            role: 'api',
            units: [
                { name: 'rallar-api-v1-2.service', port: 8081 },
                { name: 'rallar-api-v1-3.service', port: 8082 },
                { name: 'rallar-api-v1.service', port: 8080 }
            ].map(({ name, port }) => ({
                name,
                app: 'apps/api-v1',
                execStart: `ExecStart=/usr/bin/env PORT=${port} /usr/local/bin/bun run src/main.ts`,
                // Caddy fronts the replicas, so none of them is reachable around it.
                bind: ['Environment=RALLAR_HTTP_HOSTNAME=127.0.0.1'],
                // The optional secrets file carries the Metered TURN credentials 13-configure-metered-turn.sh writes.
                environment: ['EnvironmentFile=/etc/rallar/api-v1.env', 'EnvironmentFile=-/etc/rallar/api-v1.secrets.env'],
                writes: []
            }))
        },
        {
            role: 'control',
            units: [{
                name: 'rallar-black-box-control.service',
                app: 'apps/rallar-black-box-control-server',
                bind: [],
                execStart: 'ExecStart=/usr/local/bin/bun run src/main.ts',
                environment: ['EnvironmentFile=/etc/rallar/control-server.env'],
                writes: [`ReadWritePaths=${controlStateDir}`]
            }]
        },
        {
            role: 'games',
            units: [
                {
                    name: 'rallar-ar-eye-hunter-server-v1.service',
                    app: 'apps/ar-eye-hunter-server-v1',
                    bind: [],
                    execStart: 'ExecStart=/usr/local/bin/bun run src/main.ts',
                    environment: ['EnvironmentFile=/etc/rallar/ar-eye-hunter-server-v1.env'],
                    writes: []
                },
                {
                    name: 'rallar-relic-hunter-server-v1.service',
                    app: 'apps/relic-hunter-server-v1',
                    bind: [],
                    execStart: 'ExecStart=/usr/local/bin/bun run src/main.ts',
                    environment: ['EnvironmentFile=/etc/rallar/relic-hunter-server-v1.env'],
                    writes: []
                }
            ]
        }
    ])('runs the $role role sandboxed, writing only its own state', async ({ role, units }, context) => {
        const rendered = await renderRoleUnits(context, role);

        expect(rendered.map((unit) => unit.name)).toEqual(units.map((unit) => unit.name));
        for (const [index, unit] of rendered.entries()) {
            const expected = units[index]!;
            expect(unit.serviceLines).toContain(`WorkingDirectory=${checkoutDir}/${expected.app}`);
            expect(unit.serviceLines).toContain(expected.execStart);
            expect(unit.serviceLines.filter((line) => line.startsWith('Environment=RALLAR_HTTP_HOSTNAME='))).toEqual(expected.bind);
            expect(unit.serviceLines.filter((line) => line.startsWith('EnvironmentFile='))).toEqual(expected.environment);
            expect(unit.serviceLines.filter((line) => bunServerHardening.includes(line))).toEqual(bunServerHardening);
            expect(unit.serviceLines.filter((line) => line.startsWith('ReadWritePaths='))).toEqual(expected.writes);
            expect(readStopBounds(unit.serviceLines)).toEqual({ serverDeadlineSeconds: 60, systemdStopSeconds: 70 });
        }
    });
});

/** The server's own graceful-stop deadline and systemd's SIGKILL bound, which must come after it. */
function readStopBounds(serviceLines: readonly string[]): Readonly<Record<string, number | undefined>> {
    const deadline = serviceLines.find((line) => line.startsWith('Environment=RALLAR_SHUTDOWN_DEADLINE_MS='));
    const timeout = serviceLines.find((line) => line.startsWith('TimeoutStopSec='));
    return {
        serverDeadlineSeconds: deadline === undefined ? undefined : Number(deadline.split('=').at(-1)) / 1000,
        systemdStopSeconds: timeout === undefined ? undefined : Number(timeout.split('=').at(-1))
    };
}
