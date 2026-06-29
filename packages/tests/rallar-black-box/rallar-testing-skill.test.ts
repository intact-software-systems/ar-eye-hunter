import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

describe('rallar-testing skill guidance', () => {
    it('requires human-operated Playwright coverage for changed UI behavior', () => {
        const skill = readFileSync(
            resolve(REPO_ROOT, 'skills/rallar-testing/SKILL.md'),
            'utf8',
        );
        const commands = readFileSync(
            resolve(REPO_ROOT, 'skills/rallar-testing/references/test-commands.md'),
            'utf8',
        );

        expect(skill).toContain('UI Behavior Rule');
        expect(skill).toContain('operates visible controls a human would use');
        expect(skill).toContain('cannot be the only proof for a human-facing workflow');
        expect(commands).toContain('UI Workflow Testing');
        expect(commands).toContain('Prefer role/label selectors');
        expect(commands).toContain(
            'npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts',
        );
        expect(
            existsSync(resolve(REPO_ROOT, 'playwright.config.ts')),
        ).toBe(false);
    });
});
