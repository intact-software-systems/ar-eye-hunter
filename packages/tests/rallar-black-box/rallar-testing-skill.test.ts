import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const skillPath = '.agents/skills/rallar-testing/SKILL.md';

describe('rallar-testing skill discovery', () => {
    it('publishes test-design triggers through the repo plugin', () => {
        const plugin = readJson<{
            readonly skills?: string;
        }>('.codex-plugin/plugin.json');
        const frontmatter = readFrontmatter(readRepo(skillPath));

        expect(plugin.skills).toBe('./.agents/skills/');
        expect(frontmatter.name).toBe('rallar-testing');
        expect(frontmatter.description).toMatch(/tests?|mocks?|fixtures?/iu);
        expect(frontmatter.description).toMatch(/creat|modif|review|diagnos|replac|delet/iu);
    });

    it('uses a small existing visible-control spec as its canonical UI command', () => {
        const commands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');
        const uiSection = commands.split('## UI Workflow Testing')[1]?.split('\n## ')[0] ?? '';
        const commandPath = uiSection.match(/tests\/playwright\/[^\s`]+\.spec\.ts/u)?.[0];

        expect(commandPath).toBeDefined();
        if (!commandPath) {
            throw new Error('UI workflow section does not contain a Playwright spec path');
        }
        expect(existsSync(path.join(repoRoot, commandPath))).toBe(true);
        expect(readRepo(commandPath).split('\n').length).toBeLessThanOrEqual(100);
    });

    it('keeps skill and evaluation validation in the repo-governance entry point', () => {
        const packageJson = readJson<{
            readonly scripts?: Readonly<Record<string, string>>;
        }>('package.json');
        const governanceCommand = packageJson.scripts?.['test:repo-governance'] ?? '';

        expect(governanceCommand).toContain(
            'packages/tests/rallar-black-box/rallar-testing-skill.test.ts'
        );
        expect(governanceCommand).toContain(
            'packages/tests/repo/rallar-testing-evaluation-contract.test.ts'
        );
    });
});

function readRepo(repositoryPath: string): string {
    return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

function readJson<Shape>(repositoryPath: string): Shape {
    return JSON.parse(readRepo(repositoryPath)) as Shape;
}

function readFrontmatter(source: string): Readonly<Record<string, string>> {
    const match = source.match(/^---\n([\s\S]*?)\n---/u);
    if (!match) {
        return {};
    }
    return Object.fromEntries(
        match[1]
            .split('\n')
            .map((line) => line.match(/^([^:]+):\s*(.+)$/u))
            .filter((entry): entry is RegExpMatchArray => entry !== null)
            .map((entry) => [entry[1].trim(), entry[2].trim()])
    );
}
