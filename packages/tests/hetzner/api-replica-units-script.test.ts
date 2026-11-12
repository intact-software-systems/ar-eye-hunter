import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
});
