import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runOwnedTestProcess } from './owned-test-process.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const roleHelper = path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-controller-role.sh');

describe('Hetzner api replica units', () => {
    // The replicas share one executable, so only the identifier tells their raw journal lines apart.
    it('names each replica unit in the identifier of its journal lines', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-replica-units-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));

        const outcome = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                '-c',
                'set -euo pipefail; source "$1"; apply_rallar_controller_role; write_rallar_api_replica_units; rallar_api_replica_services',
                'api-replica-units',
                roleHelper
            ],
            options: {
                env: {
                    PATH: process.env.PATH,
                    RALLAR_CONTROLLER_ROLE: 'api',
                    RALLAR_SYSTEMD_UNIT_DIR: directory,
                    RALLAR_CHECKOUT_DIR: '/opt/rallar/ar-eye-hunter',
                    RALLAR_API_STORE_FAILURE_FILE: '/etc/rallar/api-v1.store-failure'
                }
            }
        });

        const services = outcome.stdout.trim().split('\n');
        expect(services).toEqual(['rallar-api-v1.service', 'rallar-api-v1-2.service', 'rallar-api-v1-3.service']);
        const units = await Promise.all(services.map(async (service) => await readFile(path.join(directory, service), 'utf8')));
        expect(units.map((unit) => unit.match(/^SyslogIdentifier=(.*)$/m)?.[1])).toEqual([
            'rallar-api-v1',
            'rallar-api-v1-2',
            'rallar-api-v1-3'
        ]);
        expect(units.map((unit) => unit.match(/PORT=(\d+)/)?.[1])).toEqual(['8080', '8081', '8082']);
    });

    // The store-failure fence keeps every replica of the shared store down, whatever the replica list names.
    it('resolves the API store-failure fence for every replica the role lists', async (context) => {
        const outcome = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                '-c',
                'set -euo pipefail; source "$1"; RALLAR_API_REPLICA_SERVICES=(rallar-api-v1.service rallar-api-v1-4.service); ' +
                'for service in $(rallar_api_replica_services); do printf "%s=%s\\n" "${service}" "$(rallar_role_service_failure_file "${service}")"; done',
                'api-replica-failure-file',
                roleHelper
            ],
            options: { env: { PATH: process.env.PATH, RALLAR_API_STORE_FAILURE_FILE: '/etc/rallar/api-v1.store-failure' } }
        });

        expect(outcome.stdout).toBe(
            'rallar-api-v1.service=/etc/rallar/api-v1.store-failure\nrallar-api-v1-4.service=/etc/rallar/api-v1.store-failure\n'
        );
    });

    // A rollback or a shorter replica list must not leave a replica running AppInbox work on a swapped checkout.
    it('disables, stops and removes every api replica unit outside the current list, idempotently', async (context) => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-api-replica-stale-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const unitDirectory = path.join(fixture, 'system');
        const binDirectory = path.join(fixture, 'bin');
        const systemctlLog = path.join(fixture, 'systemctl.log');
        await mkdir(unitDirectory);
        await mkdir(binDirectory);
        await writeFile(path.join(binDirectory, 'systemctl'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >>"$SYSTEMCTL_LOG"\n');
        await chmod(path.join(binDirectory, 'systemctl'), 0o755);
        for (const stale of ['rallar-api-v1-2.service', 'rallar-api-v1-3.service']) {
            await writeFile(path.join(unitDirectory, stale), '[Service]\n');
        }
        await writeFile(path.join(unitDirectory, 'rallar-black-box-control.service'), '[Service]\n');

        const writeShorterList = async () =>
            await runOwnedTestProcess(context, {
                executable: 'bash',
                args: [
                    '-c',
                    'set -euo pipefail; source "$1"; RALLAR_API_REPLICA_SERVICES=(rallar-api-v1.service rallar-api-v1-2.service); ' +
                    'RALLAR_API_REPLICA_PORTS=(8080 8081); apply_rallar_controller_role; write_rallar_api_replica_units',
                    'api-replica-stale-units',
                    roleHelper
                ],
                options: {
                    env: {
                        PATH: `${binDirectory}:${process.env.PATH}`,
                        SYSTEMCTL_LOG: systemctlLog,
                        RALLAR_CONTROLLER_ROLE: 'api',
                        RALLAR_SYSTEMD_UNIT_DIR: unitDirectory,
                        RALLAR_CHECKOUT_DIR: '/opt/rallar/ar-eye-hunter',
                        RALLAR_API_STORE_FAILURE_FILE: '/etc/rallar/api-v1.store-failure'
                    }
                }
            });
        await writeShorterList();
        await writeShorterList();

        expect((await readdir(unitDirectory)).sort()).toEqual([
            'rallar-api-v1-2.service',
            'rallar-api-v1.service',
            'rallar-black-box-control.service'
        ]);
        await expect(readFile(systemctlLog, 'utf8')).resolves.toBe('disable --now rallar-api-v1-3.service\n');
    });
});
