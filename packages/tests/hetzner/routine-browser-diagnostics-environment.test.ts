import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

const writer = path.resolve(__dirname, '../../../scripts/hosted-rallar/controller/rallar-headless-worker-env.sh');

describe('hosted worker routine recording environment', () => {
    it('preserves the exact recording key and excludes a similarly named unapproved key', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'routine-recording-env-'));
        const destination = path.join(directory, 'worker.env');
        try {
            execFileSync('bash', ['-c', 'source "$1"; write_rallar_headless_worker_env_file "$2"', 'bash', writer, destination], {
                env: {
                    PATH: '/usr/bin:/bin',
                    RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: 'disabled',
                    RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS_EXTRA: 'enabled'
                }
            });
            expect(readFileSync(destination, 'utf8').split('\n').filter((line) => !line.startsWith('#') && line)).toEqual([
                'RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS="disabled"'
            ]);
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
