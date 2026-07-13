import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, '.agents/skills');
const expectedSkills = [
    'building-rallar-apps',
    'performance-analysis',
    'rallar-ai',
    'rallar-code-writing',
    'rallar-games',
    'rallar-hetzner-ops',
    'rallar-platform',
    'rallar-realtime',
    'rallar-testing',
] as const;

describe('Rallar repo skill and documentation integrity', () => {
    it('uses one directly discoverable skill tree for the plugin', () => {
        const plugin = readJson('.codex-plugin/plugin.json') as {
            skills?: string;
            interface?: { defaultPrompt?: readonly string[] };
        };
        const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();

        expect(plugin.skills).toBe('./.agents/skills/');
        expect(plugin.interface?.defaultPrompt?.length).toBeLessThanOrEqual(3);
        expect(skillDirectories).toEqual([...expectedSkills].sort());
        expect(existsSync(path.join(repoRoot, 'skills'))).toBe(false);
    });

    it('keeps skill frontmatter and local references valid', () => {
        for (const skillName of expectedSkills) {
            const skillPath = path.join(skillsRoot, skillName, 'SKILL.md');
            const source = readAbsolute(skillPath);
            const frontmatter = readFrontmatter(source, skillPath);

            expect(frontmatter.name, skillPath).toBe(skillName);
            expect(frontmatter.description.length, skillPath).toBeGreaterThan(20);

            for (const reference of source.matchAll(/`(references\/[a-z0-9./-]+\.md)`/g)) {
                expect(
                    existsSync(path.join(skillsRoot, skillName, reference[1])),
                    `${skillPath} -> ${reference[1]}`,
                ).toBe(true);
            }
        }
    });

    it('provides the greenfield app workflow and audited evidence map', () => {
        const skill = readRepo('.agents/skills/building-rallar-apps/SKILL.md');
        const scaffolding = readRepo(
            '.agents/skills/building-rallar-apps/references/app-scaffolding.md',
        );
        const architecture = readRepo(
            '.agents/skills/building-rallar-apps/references/react-3d-architecture.md',
        );
        const exampleMap = readRepo(
            '.agents/skills/building-rallar-apps/references/example-map.md',
        );

        expectAll(skill, [
            '`references/app-scaffolding.md`',
            '`references/react-3d-architecture.md`',
            '`references/example-map.md`',
            'rallar.setup',
            'roomRef',
        ]);
        expectAll(scaffolding, [
            'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
            'rallar.rooms.enter',
            'rallar.rooms.createAndSwitch',
            'AbortController',
        ]);
        expectAll(architecture, [
            'Direct Three.js',
            'React Three Fiber',
            'no per-frame React state',
            'Rallar Motion',
            'dispose',
        ]);
        expectAll(exampleMap, [
            'examples/browser-startup-room',
            'examples/room-message-channel',
            'examples/room-realtime-channel',
            'examples/motion-smoothing',
            'apps/ar-eye-hunter-v1',
            'apps/relic-hunters-v1',
            'projects/cash-chase-arena',
        ]);
    });

    it('routes composition and validation from the specialist skills', () => {
        const platform = readRepo('.agents/skills/rallar-platform/SKILL.md');
        const games = readRepo('.agents/skills/rallar-games/SKILL.md');
        const realtime = readRepo('.agents/skills/rallar-realtime/SKILL.md');
        const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const testCommands = readRepo(
            '.agents/skills/rallar-testing/references/test-commands.md',
        );

        expect(platform).toContain('building-rallar-apps');
        expect(games).toContain('building-rallar-apps');
        expect(games).toContain('Use the `rallar-testing` skill');
        expect(realtime).toContain('building-rallar-apps');
        expect(testing).toContain('rallar-skill-integrity.test.ts');
        expect(testCommands).toContain(
            'npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts',
        );
    });

    it('routes active repo guidance through the canonical skill location', () => {
        for (const filePath of [
            'AGENTS.md',
            'docs/README.md',
            'projects/cash-chase-arena/Cash_Chase_Arena_Codex_Prompt_Pack.md',
        ]) {
            const source = readRepo(filePath);
            expect(source, filePath).toContain('.agents/skills');
            expect(source, filePath).not.toMatch(/(?<!\.agents\/)skills\/\*\*/);
        }

        expect(readRepo('AGENTS.md')).not.toContain('  - `...`');
    });

    it('keeps current startup and recipe documentation internally consistent', () => {
        const aiSkill = readRepo('docs/rallar-ai-skill.md');
        const prompting = readRepo('docs/rallar-ai-prompting-guide.md');
        const troubleshooting = readRepo('docs/rallar-troubleshooting-checklist.md');
        const quickstart = readRepo('docs/rallar-quickstart-and-recipes.md');
        const aiExample = readRepo('examples/rallar-ai-game-event/README.md');
        const docsIndex = readRepo('docs/README.md');

        expectAll(aiSkill, ['initial app boot', '`rallar.setup(...)`', '`rallar.start(...)`']);
        expectAll(prompting, ['rallar.setup({', 'After login, call rallar.start']);
        expect(troubleshooting).toContain('`rallar.setup(...)`');
        expect(quickstart).not.toContain('motionLane.send(');
        expectAll(quickstart, [
            "const motionUpdates = room.realtime<PoseUpdate>",
            'await motionUpdates.send(nextPose)',
        ]);
        expect(aiExample).toContain(
            "import { rallar } from '@shared-web/browser/rallar.ts';",
        );
        expect(docsIndex).toContain(
            '../iterations/completed/rallar-api-v1-in-memory-sql-performance-mode.md',
        );
        expect(
            existsSync(
                path.join(
                    repoRoot,
                    'iterations/completed/rallar-api-v1-in-memory-sql-performance-mode.md',
                ),
            ),
        ).toBe(true);
    });

    it('does not expose root commands or project references for removed apps', () => {
        const packageJson = readJson('package.json') as { scripts?: Record<string, string> };
        const tsconfig = readJson('tsconfig.json') as {
            references?: readonly { path?: string }[];
        };

        expect(packageJson.scripts).not.toHaveProperty('dev:web');
        expect(packageJson.scripts).not.toHaveProperty('build:web');
        expect(packageJson.scripts).not.toHaveProperty('dev:api');
        for (const command of Object.values(packageJson.scripts ?? {})) {
            expect(command).not.toContain('apps/web');
            expect(command).not.toMatch(/\bapps\/api(?:\s|$)/);
        }
        expect(tsconfig.references?.map((reference) => reference.path)).not.toContain(
            'apps/web',
        );
    });
});

function readRepo(filePath: string): string {
    return readAbsolute(path.join(repoRoot, filePath));
}

function readAbsolute(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function readJson(filePath: string): unknown {
    return JSON.parse(readRepo(filePath));
}

function readFrontmatter(
    source: string,
    filePath: string,
): Readonly<{ name: string; description: string }> {
    const block = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
    expect(block, filePath).toBeDefined();
    const name = block?.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const description = block?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    return { name, description };
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}
