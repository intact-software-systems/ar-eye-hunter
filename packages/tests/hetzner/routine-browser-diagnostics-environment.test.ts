import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { readHeadlessWorkerConfig } from '../../../apps/rallar-black-box/src/headless-worker/headless-worker-config.ts';

const writer = path.resolve(__dirname, '../../../scripts/hosted-rallar/controller/rallar-headless-worker-env.sh');
const workerEnvironment = {
    RALLAR_BLACK_BOX_SPA_URL: 'https://fixture.test',
    RALLAR_BLACK_BOX_CONTROL_URL: 'wss://control.fixture.test/control',
    RALLAR_API_BASE_URL: 'https://api.fixture.test',
    RALLAR_BLACK_BOX_RUN_ID: 'fixture-run',
    RALLAR_BLACK_BOX_ROOM_ID: 'fixture-room',
    RALLAR_BLACK_BOX_USERNAME: 'fixture-user',
    RALLAR_BLACK_BOX_PASSWORD: 'fixture-password'
};

describe('hosted worker routine recording environment', () => {
    it.each([
        { selection: undefined, presence: 'absent', mode: 'enabled' },
        { selection: '', presence: 'present', mode: undefined },
        { selection: 'enabled', presence: 'present', mode: 'enabled' },
        { selection: 'disabled', presence: 'present', mode: 'disabled' },
        { selection: 'off', presence: 'present', mode: undefined }
    ])('transports $selection to the canonical host decoder, preserving absence separately from empty', ({ selection, presence, mode }) => {
        const directory = mkdtempSync(path.join(tmpdir(), 'routine-recording-env-'));
        const destination = path.join(directory, 'worker.env');
        try {
            const environment = {
                PATH: '/usr/bin:/bin',
                ...(selection === undefined ? {} : { RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: selection }),
                RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS_EXTRA: 'enabled',
                RALLAR_BLACK_BOX_STATS_INTERVAL_MS: ''
            };
            execFileSync('bash', ['-c', 'source "$1"; write_rallar_headless_worker_env_file "$2"', 'bash', writer, destination], { env: environment });
            const transported = execFileSync('bash', [
                '-c',
                'source "$1"; printf "%s\n%s\n%s\n%s" "${RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS+present}" "${RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS-}" "${RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS_EXTRA+present}" "${RALLAR_BLACK_BOX_STATS_INTERVAL_MS+present}"',
                'bash',
                destination
            ], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).split('\n');
            expect(transported).toEqual([presence === 'present' ? 'present' : '', selection ?? '', '', '']);
            const hostEnvironment = {
                ...workerEnvironment,
                ...(transported[0] === 'present' ? { RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: transported[1] } : {})
            };
            if (mode === undefined) {
                expect(() => readHeadlessWorkerConfig({ env: hostEnvironment })).toThrow(/routine browser diagnostics/i);
            }
            else {
                const config = readHeadlessWorkerConfig({ env: hostEnvironment });
                expect(config).toHaveProperty('routineBrowserDiagnostics', mode);
                expect(new URL(config.agents[0].url).searchParams.get('routineBrowserDiagnostics')).toBe(mode);
            }
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
