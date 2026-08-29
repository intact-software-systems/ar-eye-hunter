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
const liveMatrixSpec =
    'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts';

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
        expect(script).toContain(liveMatrixSpec);
    });

    it('keeps exhaustive and retention selectors owned by the invoking attempt', () => {
        const memory = packageJson.scripts?.[
            'test:rallar:full-stack:memory:live-rtc-3'
        ] ?? '';
        const postgres = packageJson.scripts?.[
            'test:rallar:full-stack:postgres:live-rtc-3'
        ] ?? '';
        const postgresAll = packageJson.scripts?.[
            'test:rallar:full-stack:postgres:live-rtc-3:all'
        ] ?? '';

        expect(memory).not.toContain('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=');
        expect(postgres).not.toContain('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=');
        expect(postgresAll).toContain('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1');
        expect(memory).not.toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=');
        expect(postgres).not.toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=');
    });

    it('keeps benchmark ownership out of application and reusable product sources', () => {
        const productRoots = [path.join(repoRoot, 'apps'), path.join(repoRoot, 'packages')];
        const forbiddenImports: string[] = [];

        for (const root of productRoots) {
            for (const file of sourceFiles(root)) {
                if (
                    file.includes(`${path.sep}shared-rtc-bench${path.sep}`) ||
                    file.includes(`${path.sep}tests${path.sep}`)
                ) {
                    continue;
                }
                const source = fs.readFileSync(file, 'utf8');
                if (
                    /(?:from|import\s*\(|require\s*\()\s*['"][^'"]*shared-rtc-bench/.test(
                        source
                    )
                ) {
                    forbiddenImports.push(path.relative(repoRoot, file));
                }
            }
        }

        expect(forbiddenImports).toEqual([]);
    });
});

function sourceFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const absolutePath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(absolutePath));
        }
        else if (entry.isFile() && /\.(?:c|m)?(?:j|t)sx?$/.test(entry.name)) {
            files.push(absolutePath);
        }
    }
    return files;
}
