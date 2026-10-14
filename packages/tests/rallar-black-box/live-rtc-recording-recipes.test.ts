import { execFileSync } from 'node:child_process';
import {
    describe,
    expect,
    it
} from 'vitest';

import packageConfig from '../../../package.json';

const scripts: Readonly<Record<string, string>> = packageConfig.scripts;
const matrixEntry = 'test:rallar:full-stack:memory:live-rtc-3';

// These shell ports capture launch commands without starting services or browsers.
const captureNpm =
    'npm() { printf "%s\n" "$RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS" "$RALLAR_BLACK_BOX_ALM_DIAGNOSTICS" "$RALLAR_BLACK_BOX_RTC_CAPTURE_MODE" "$@"; }; ';
const capturePlaywright =
    'playwright() { printf "%s\n" "$RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS" "$RALLAR_BLACK_BOX_ALM_DIAGNOSTICS" "$RALLAR_BLACK_BOX_RTC_CAPTURE_MODE" "$@"; }; ';

describe('live RTC recording recipe entries', () => {
    it.each(['enabled', 'disabled'])('selects %s through the shared matrix entry without changing ALM or capture', (mode) => {
        const script = scripts[`${matrixEntry}:routine-browser-diagnostics-${mode}`];
        expect(script).toBeTypeOf('string');
        const lines = execFileSync('bash', ['-c', captureNpm + script + ' --retries=0'], {
            env: { PATH: process.env.PATH, RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'false', RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'signaling' },
            encoding: 'utf8'
        }).trim().split('\n');
        expect(lines).toEqual([mode, 'false', 'signaling', 'run', matrixEntry, '--', '--retries=0']);
    });

    it('keeps the generic matrix independently configurable and invokes the existing spec', () => {
        const lines = execFileSync('bash', ['-c', capturePlaywright + scripts[matrixEntry]], {
            env: {
                PATH: process.env.PATH,
                RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: 'disabled',
                RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'true',
                RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'native'
            },
            encoding: 'utf8'
        }).trim().split('\n');
        expect(lines).toEqual([
            'disabled',
            'true',
            'native',
            'test',
            '--config',
            'apps/rallar-black-box/playwright.full-stack.config.ts',
            'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts'
        ]);
    });
});
