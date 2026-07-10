import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const wrapperPath =
    'tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts';
const executePath =
    'tests/playwright/rallar-black-box/recipe-console-execute.spec.ts';
const fullStackConfigPath =
    'apps/rallar-black-box/playwright.full-stack.config.ts';
const exactTestName =
    'completes the configured live distributed run lifecycle and exports its artifact';
const exactSkipReason =
    'Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.';

function source(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

describe('Recipe Console configured full-stack Monitor acceptance discovery', () => {
    test('owns the live lifecycle proof in a configured full-stack wrapper', () => {
        expect(existsSync(resolve(repositoryRoot, wrapperPath))).toBe(true);
        if (!existsSync(resolve(repositoryRoot, wrapperPath))) return;

        const wrapper = source(wrapperPath);
        expect(wrapper).toContain(`test('${exactTestName}'`);
        expect(wrapper).toContain(exactSkipReason);
        expect(wrapper).toContain('CONFIGURED_POSTGRES_MODE');
        expect(wrapper).toContain('CONFIGURED_FRESH_POSTGRES_API');
        expect(wrapper).toContain('!CONFIGURED_FRESH_POSTGRES_API');
        expect(wrapper).toContain('Promise.allSettled');
        expect(wrapper).toContain('evaluateFullStackConfiguredServiceEvidence');
        expect(wrapper).toContain("api: configuredServiceProbe(apiProbe, 'API configuration')");
        expect(wrapper).toContain("control: configuredServiceProbe(controlProbe, 'control health')");
        expect(wrapper).not.toContain('if (!apiResponse.ok() || !controlResponse.ok()) return false');
        expect(wrapper).toContain(
            "(process.env.RALLAR_BLACK_BOX_API_MODE?.trim() ?? 'postgres') ===",
        );
        expect(wrapper).toContain("view: 'execute'");
        expect(wrapper).toContain("name: 'Monitor'");
        expect(wrapper).toContain('view=monitor');
        expect(wrapper).toContain("name: 'Export artifact'");
        expect(wrapper).toContain("name: 'Arm Cancel'");
        expect(wrapper).toContain("name: 'Cancel run'");
        expect(wrapper).toContain("name: 'Cancel distributed run?'");
        expect(wrapper).toContain("kind: 'recipe.cancel'");
        expect(wrapper).toContain('dispatchedAtEpochMs');
        expect(wrapper).toContain('completedAtEpochMs');
        expect(wrapper).toContain('finally {');
        expect(wrapper).toContain('cleanupRallarPage(page)');
        expect(wrapper).toContain('agent.context.close()');
    });

    test('removes the configured-only proof from the mocked Execute suite', () => {
        const execute = source(executePath);
        expect(execute).not.toContain(`test('${exactTestName}'`);
        expect(execute).not.toContain('readExhaustivePostgresConfig');
        expect(execute).not.toContain('expectFullStackApiReady');
        expect(execute).not.toContain('openBrowserControlAgent');
        expect(execute).not.toContain('waitForControlRunAgent');
    });

    test('includes both distributed proofs in the canonical Postgres command', () => {
        const rootPackage = JSON.parse(source('package.json')) as {
            scripts?: Record<string, string>;
        };
        const command = rootPackage.scripts?.[
            'test:rallar:full-stack:postgres:distributed'
        ];

        expect(command).toContain(
            'tests/playwright/rallar-black-box/full-stack-distributed-recipes.spec.ts',
        );
        expect(command).toContain(wrapperPath);
        expect(command).not.toContain(executePath);
        expect(command).toContain(
            'RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API=1',
        );

        const fullStackConfig = source(fullStackConfigPath);
        expect(fullStackConfig).toContain(
            'RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API',
        );
        expect(fullStackConfig).toContain('requireFreshPostgres');
    });
});
