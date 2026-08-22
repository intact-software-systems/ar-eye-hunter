import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageManifest = Readonly<{
    scripts?: Readonly<Record<string, string>>;
}>;

const repoRoot = process.cwd();
const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
) as PackageManifest;

const REQUIRED_LIVE_RTC_GATE_ENV = [
    'RALLAR_BLACK_BOX_FULL_STACK=1',
    'RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1',
    'VITE_RALLAR_ROOM_ID=${VITE_RALLAR_ROOM_ID:-',
    'VITE_RALLAR_AGENT_A_USERNAME=${VITE_RALLAR_AGENT_A_USERNAME:-alice}',
    'VITE_RALLAR_AGENT_A_PASSWORD=${VITE_RALLAR_AGENT_A_PASSWORD:-secret}',
    'VITE_RALLAR_AGENT_B_USERNAME=${VITE_RALLAR_AGENT_B_USERNAME:-bob}',
    'VITE_RALLAR_AGENT_B_PASSWORD=${VITE_RALLAR_AGENT_B_PASSWORD:-secret}',
    'VITE_RALLAR_AGENT_C_USERNAME=${VITE_RALLAR_AGENT_C_USERNAME:-charlie}',
    'VITE_RALLAR_AGENT_C_PASSWORD=${VITE_RALLAR_AGENT_C_PASSWORD:-secret}'
] as const;

describe('live three-browser RTC npm script gates', () => {
    it.each([
        [
            'test:rallar:full-stack:memory:live-rtc-3',
            'VITE_RALLAR_API_BASE_URL=${VITE_RALLAR_API_BASE_URL:-http://localhost:18080}',
            'VITE_RALLAR_SPA_BASE_URL=${VITE_RALLAR_SPA_BASE_URL:-http://localhost:5177}'
        ],
        [
            'test:rallar:full-stack:postgres:live-rtc-3',
            'VITE_RALLAR_API_BASE_URL=${VITE_RALLAR_API_BASE_URL:-http://localhost:18081}',
            'VITE_RALLAR_SPA_BASE_URL=${VITE_RALLAR_SPA_BASE_URL:-http://localhost:5178}'
        ]
    ])('%s sets every env value required for a non-skipped baseline', (
        scriptName,
        apiBaseUrl,
        spaBaseUrl
    ) => {
        const script = packageJson.scripts?.[scriptName] ?? '';

        expect(script).toContain(apiBaseUrl);
        expect(script).toContain(spaBaseUrl);
        if (scriptName.includes(':postgres:')) {
            expect(script).toContain(
                'DATABASE_URL=${DATABASE_URL:-postgres://app:app@localhost:5432/appdb}'
            );
        }
        for (const requiredEnv of REQUIRED_LIVE_RTC_GATE_ENV) {
            expect(script).toContain(requiredEnv);
        }
    });
});
