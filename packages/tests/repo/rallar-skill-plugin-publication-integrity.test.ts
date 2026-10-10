import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface RallarSkillPluginMetadata {
    readonly skills: string;
    readonly keywords: readonly string[];
    readonly interface: {
        readonly defaultPrompt: readonly string[];
        readonly longDescription: string;
    };
}

interface SkillFrontmatter {
    readonly name: string;
    readonly description: string;
}

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, '.agents/skills');
const expectedSkills = [
    'adaptive-plan-execution',
    'building-rallar-apps',
    'organizing-repository-structure',
    'performance-analysis',
    'rallar-ai',
    'rallar-code-writing',
    'rallar-games',
    'rallar-hetzner-ops',
    'rallar-platform',
    'publishing-plan-progress',
    'rallar-realtime',
    'rallar-testing'
] as const;

describe('Rallar skill plugin and publication integrity', () => {
    it('uses one directly discoverable skill tree for the plugin', () => {
        const plugin = decodeRallarSkillPluginMetadata(JSON.parse(readRepo('.codex-plugin/plugin.json')));
        const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();

        expect(plugin.skills).toBe('./.agents/skills/');
        expect(plugin.interface.defaultPrompt.length).toBeLessThanOrEqual(3);
        expect(skillDirectories).toEqual([...expectedSkills].sort());
        expect(existsSync(path.join(repoRoot, 'skills'))).toBe(false);
    });

    it('exposes each canonical skill to Claude Code as a directory symlink', () => {
        const claudeSkillsRoot = path.join(repoRoot, '.claude/skills');
        const linkNames = readdirSync(claudeSkillsRoot).sort();

        expect(linkNames).toEqual([...expectedSkills].sort());
        expect(readCopiedClaudeSkillMarkdown(repoRoot)).toEqual([]);
        for (const skillName of expectedSkills) {
            const linkPath = path.join(claudeSkillsRoot, skillName);
            expect(lstatSync(linkPath).isSymbolicLink(), skillName).toBe(true);
            expect(readlinkSync(linkPath), skillName).toBe(`../../.agents/skills/${skillName}`);
            expect(existsSync(path.join(linkPath, 'SKILL.md')), skillName).toBe(true);
        }
    });

    it('ignores sibling worktree skills while detecting copies in the Claude discovery tree', () => {
        const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rallar-skill-publication-'));
        try {
            const canonicalSkill = path.join(fixtureRoot, '.agents/skills/canonical');
            const claudeSkills = path.join(fixtureRoot, '.claude/skills');
            const worktreeSkill = path.join(
                fixtureRoot,
                '.claude/worktrees/task/.agents/skills/canonical'
            );
            mkdirSync(canonicalSkill, { recursive: true });
            mkdirSync(claudeSkills, { recursive: true });
            mkdirSync(worktreeSkill, { recursive: true });
            writeFileSync(path.join(canonicalSkill, 'SKILL.md'), '# Canonical skill\n');
            writeFileSync(path.join(worktreeSkill, 'SKILL.md'), '# Worktree canonical skill\n');
            symlinkSync('../../.agents/skills/canonical', path.join(claudeSkills, 'canonical'), 'dir');

            expect(readCopiedClaudeSkillMarkdown(fixtureRoot)).toEqual([]);

            const copiedSkill = path.join(claudeSkills, 'copied');
            const copiedMarkdown = path.join(copiedSkill, 'SKILL.md');
            mkdirSync(copiedSkill);
            writeFileSync(copiedMarkdown, '# Copied skill\n');

            expect(readCopiedClaudeSkillMarkdown(fixtureRoot)).toEqual([copiedMarkdown]);
        }
        finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    it.each([
        null,
        { skills: './.agents/skills/', keywords: [] },
        {
            skills: './.agents/skills/',
            keywords: [1],
            interface: { defaultPrompt: [], longDescription: 'Skill guidance' }
        },
        {
            skills: './.agents/skills/',
            keywords: [],
            interface: { defaultPrompt: [1], longDescription: 'Skill guidance' }
        }
    ])('rejects malformed published plugin metadata (%#)', (pluginMetadata) => {
        expect(() => decodeRallarSkillPluginMetadata(pluginMetadata)).toThrow(
            'Invalid Rallar skill plugin metadata'
        );
    });

    it('keeps skill frontmatter and local references valid', () => {
        for (const skillName of expectedSkills) {
            const skillPath = path.join(skillsRoot, skillName, 'SKILL.md');
            const source = readFileSync(skillPath, 'utf8');
            const frontmatter = readFrontmatter(source, skillPath);

            expect(frontmatter.name, skillPath).toBe(skillName);
            expect(frontmatter.description.length, skillPath).toBeGreaterThan(20);
            expect(frontmatter.description.length, skillPath).toBeLessThanOrEqual(1024);
            const capabilityEnd = frontmatter.description.indexOf('Use when');
            expect(capabilityEnd, skillPath).toBeGreaterThan(0);
            expect(frontmatter.description.slice(0, capabilityEnd).trim().endsWith('.'), skillPath).toBe(
                true
            );

            for (const reference of source.matchAll(/`(references\/[a-z0-9./-]+\.md)`/g)) {
                expect(
                    existsSync(path.join(skillsRoot, skillName, reference[1])),
                    `${skillPath} -> ${reference[1]}`
                ).toBe(true);
            }
        }
    });

    it('routes long-running written-plan execution to observable published progress', () => {
        const agents = readRepo('AGENTS.md');
        const progressSkill = readRepo('.agents/skills/publishing-plan-progress/SKILL.md');
        const normalizedAgents = normalizeWhitespace(agents);
        const normalizedProgressSkill = normalizeWhitespace(progressSkill);
        const plugin = decodeRallarSkillPluginMetadata(JSON.parse(readRepo('.codex-plugin/plugin.json')));

        expectAll(agents, ['adaptive-plan-execution', 'publishing-plan-progress', 'publication']);
        expect(normalizedAgents).toContain(
            'Use `adaptive-plan-execution` for written or multi-slice plans, ' +
                '`organizing-repository-structure` for repository shape, `rallar-testing` for ' +
                'surface-specific commands, and `publishing-plan-progress` for publication.'
        );
        expectAll(normalizedAgents, [
            'No AI or agent may create or place a commit on `main`, `master`, or the local default branch',
            'permission immediately before the commit',
            'Each default-branch commit requires a new permission request and approval',
            'No AI or agent may push `main`, `master`, or the remote default branch',
            'the push is forced',
            'permission immediately before the push',
            'Each default-branch push requires a new permission request and approval',
            'Commit and push permissions are independent'
        ]);
        expectAll(normalizedProgressSkill, [
            '`codex/<topic>`',
            'draft pull request',
            'Work on a non-default',
            'coherent reviewed slices',
            'without waiting for review',
            'The GitHub pull request is the remote delivery entity',
            'current diff, checks, reviews, conversations, mergeability, and merged state are authoritative',
            '`BEHIND` but still reports the PR mergeable',
            'Do not update the branch, merge `main`, or rebase merely to follow base movement',
            '`AWAIT_REVIEW_OR_ADMIN_MERGE`',
            'authorized administrator may intentionally merge through GitHub',
            '`DONE` permits no post-merge governance work',
            'Default branch commit and push permission',
            'Before every default-branch commit',
            'staged diff summary',
            'staged Git tree ID',
            '`git write-tree`',
            'full commit IDs',
            'proposed message',
            'Ask for permission immediately before that exact operation',
            'changed content, message, input, target, or conflict resolution invalidates approval',
            'separate just-in-time permission',
            'exact remote, destination ref and refspec',
            'resolved full old and new commit IDs',
            'Recheck immediately after approval and push only that range',
            'Commit and push approvals are independent',
            'These gates do not apply to a non-default destination ref'
        ]);
        expect(plugin.keywords).toEqual(
            expect.arrayContaining([
                'implementation-plans',
                'observable-plan-progress',
                'draft-pull-requests'
            ])
        );
        expect(plugin.interface.longDescription).toContain('observable plan progress');
        expect(plugin.interface.defaultPrompt).toHaveLength(3);
        expect(plugin.interface.defaultPrompt).toContain(
            'Execute a long-running Rallar implementation plan with observable GitHub checkpoints.'
        );
    });

    it('keeps validation scope and completion publication with their canonical owners', () => {
        const agents = readRepo('AGENTS.md');
        const progressSkill = readRepo('.agents/skills/publishing-plan-progress/SKILL.md');
        const testingSkill = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const testCommands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');
        const codeWritingSkill = readRepo('.agents/skills/rallar-code-writing/SKILL.md');

        expectAllNormalized(progressSkill, [
            'draft pull request',
            'Branch Release Gate',
            'Run Hetzner Supported Distributed Manifests',
            'Do not copy workflow run identities or content digests into the branch or PR body as governance inputs',
            'Report the exact commands that passed, failed, or were skipped and the current GitHub check state',
            '`DONE` permits no post-merge governance work'
        ]);
        expectAllNormalized(testingSkill, [
            'adaptive-plan-execution',
            'working-plan and proportional-validation judgment',
            'test:api-v1:black-box:postgres:medium-scale',
            'test:api-v1:black-box:postgres:topology-replay',
            'perf:api-v1:state-write'
        ]);
        expectAllNormalized(testCommands, [
            'Working-Plan Validation Routing',
            'adaptive-plan-execution',
            'explicitly required high-risk proofs'
        ]);
        expectAllNormalized(codeWritingSkill, [
            'rallar-testing',
            'adaptive-plan-execution',
            'working-plan and proportional-validation judgment'
        ]);
        for (const source of [agents, progressSkill, testingSkill, testCommands]) {
            expect(source).not.toContain('npm run test:unit');
            expect(source).not.toContain('npm run test:ci');
            expect(source).not.toContain('npm run build');
        }
    });

    it('runs release validation in isolated pull-request workflows', () => {
        const branchWorkflow = readRepo('.github/workflows/branch-release-gate.yml');
        const reusableWorkflow = readRepo('.github/workflows/release-gate.yml');
        const agents = readRepo('AGENTS.md');
        const progressSkill = readRepo('.agents/skills/publishing-plan-progress/SKILL.md');
        const testingSkill = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const testCommands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');

        expectAllNormalized(branchWorkflow, [
            'pull_request:',
            '- synchronize',
            'group: branch-release-pr-${{ github.event.pull_request.number }}',
            'cancel-in-progress: true'
        ]);
        expect(branchWorkflow).not.toContain('branches-ignore:');
        expect(branchWorkflow).not.toContain('paths-ignore:');
        expect(reusableWorkflow).not.toContain('paths-ignore:');

        expectAllNormalized(progressSkill, [
            'The GitHub pull request is the remote delivery entity',
            'Run `npm run pr:delivery -- status` before broad final validation',
            '`DONE` permits no post-merge governance work'
        ]);
        for (const source of [agents, testingSkill, testCommands]) {
            expect(source).not.toContain('Plan-only branches do not wait for');
            expect(source).not.toContain('Branch Release Gate remains required');
        }
    });

    it('requires a Markdown learning-oriented command summary in every final handoff', () => {
        const agents = readRepo('AGENTS.md');

        expectAllNormalized(agents, [
            'Every final handoff ends with a Markdown `### Commands executed and what they taught us` section',
            'When commands or tool actions ran, include a concise grouped bullet for each repeated or consequential action',
            'If no commands or tool actions ran, write `No commands or tool actions were run.` in that section',
            'Group repeated or equivalent commands',
            'why the command or action was chosen',
            'what its result means',
            'useful lesson or reusable troubleshooting insight',
            'Never expose secrets, tokens, credentials, authorization headers'
        ]);
    });
});

function readCopiedClaudeSkillMarkdown(repositoryRoot: string): readonly string[] {
    const copied: string[] = [];
    const directories = [path.join(repositoryRoot, '.claude/skills')];
    for (const directory of directories) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const child = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                continue;
            }
            if (entry.isDirectory()) {
                directories.push(child);
            }
            else if (entry.name === 'SKILL.md') {
                copied.push(child);
            }
        }
    }
    return copied;
}

function readRepo(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
    const normalized = normalizeWhitespace(haystack);
    for (const needle of needles) {
        expect(normalized, needle).toContain(normalizeWhitespace(needle));
    }
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function readFrontmatter(
    source: string,
    filePath: string
): SkillFrontmatter {
    const block = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
    expect(block, filePath).toBeDefined();
    const name = block?.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const description = block?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    return { name, description };
}

function decodeRallarSkillPluginMetadata(pluginMetadata: unknown): RallarSkillPluginMetadata {
    if (
        typeof pluginMetadata !== 'object' || pluginMetadata === null ||
        !('skills' in pluginMetadata) || typeof pluginMetadata.skills !== 'string' ||
        !('keywords' in pluginMetadata) || !Array.isArray(pluginMetadata.keywords) ||
        !pluginMetadata.keywords.every((keyword) => typeof keyword === 'string') ||
        !('interface' in pluginMetadata) || typeof pluginMetadata.interface !== 'object' ||
        pluginMetadata.interface === null
    ) {
        throw new Error('Invalid Rallar skill plugin metadata');
    }

    const pluginInterface = pluginMetadata.interface;
    if (
        !('defaultPrompt' in pluginInterface) || !Array.isArray(pluginInterface.defaultPrompt) ||
        !pluginInterface.defaultPrompt.every((prompt) => typeof prompt === 'string') ||
        !('longDescription' in pluginInterface) || typeof pluginInterface.longDescription !== 'string'
    ) {
        throw new Error('Invalid Rallar skill plugin metadata');
    }

    return {
        skills: pluginMetadata.skills,
        keywords: pluginMetadata.keywords,
        interface: {
            defaultPrompt: pluginInterface.defaultPrompt,
            longDescription: pluginInterface.longDescription
        }
    };
}
