import { execFileSync, spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

interface SelectionRun {
    readonly status: number | null;
    readonly stdout: string;
    /** The GITHUB_OUTPUT file's text, or `undefined` when the command wrote none. */
    readonly githubOutput: string | undefined;
}

interface SelectionRunInput {
    readonly root: string;
    readonly base: string;
    readonly head: string;
    readonly githubOutput: boolean;
}

const repoRoot = path.resolve(__dirname, '../../../..');
const commandPath = path.join(repoRoot, 'scripts/alm-lane-selection.mjs');
const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('ALM lane selection command', () => {
    it('writes run_full_scope=false when every path changed since the merge base cannot change the lane', () => {
        const root = createRepository();
        const head = commitOnTopic(root, { 'docs/topic.md': 'topic\n' });

        const run = runSelection({ root, base: 'main', head, githubOutput: true });

        expect(run.status).toBe(0);
        expect(run.githubOutput).toBe('run_full_scope=false\n');
        expect(run.stdout).toBe('SKIPPED: every changed path cannot change the ALM lane\n');
    });

    it('writes run_full_scope=true and names a changed path that can change the lane', () => {
        const root = createRepository();
        const head = commitOnTopic(root, { 'scripts/lane-tool.mjs': 'export {};\n' });

        const run = runSelection({ root, base: 'main', head, githubOutput: true });

        expect(run.githubOutput).toBe('run_full_scope=true\n');
        expect(run.stdout).toBe('SELECTED: full ALM scope for scripts/lane-tool.mjs\n');
    });

    it('counts the old path of a file renamed out of a lane path', () => {
        const root = createRepository();
        runGit(root, ['checkout', '--quiet', '-b', 'topic']);
        mkdirSync(path.join(root, 'docs/moved'), { recursive: true });
        runGit(root, ['mv', 'scripts/existing-tool.mjs', 'docs/moved/existing-tool.mjs']);
        runGit(root, ['commit', '--quiet', '-m', 'move the tool']);

        const run = runSelection({ root, base: 'main', head: 'topic', githubOutput: true });

        expect(run.githubOutput).toBe('run_full_scope=true\n');
        expect(run.stdout).toBe('SELECTED: full ALM scope for scripts/existing-tool.mjs\n');
    });

    it('does not count a path changed only on the base branch after the branch point', () => {
        const root = createRepository();
        const head = commitOnTopic(root, { 'docs/topic.md': 'topic\n' });
        runGit(root, ['checkout', '--quiet', 'main']);
        commitFiles(root, { 'scripts/base-only-tool.mjs': 'export {};\n' });

        const run = runSelection({ root, base: 'main', head, githubOutput: true });

        expect(run.githubOutput).toBe('run_full_scope=false\n');
    });

    it.each([
        { label: 'a missing revision', head: '0'.repeat(40) },
        { label: 'no merge base', head: 'unrelated' }
    ])('exits non-zero and writes no output for $label', ({ head }) => {
        const root = createRepository();
        runGit(root, ['checkout', '--quiet', '--orphan', 'unrelated']);
        commitFiles(root, { 'docs/unrelated.md': 'unrelated\n' });

        const run = runSelection({ root, base: 'main', head, githubOutput: true });

        expect(run.status).not.toBe(0);
        expect(run.githubOutput).toBeUndefined();
    });

    it('prints the selection without writing an output when GITHUB_OUTPUT is not set', () => {
        const root = createRepository();
        const head = commitOnTopic(root, { 'docs/topic.md': 'topic\n' });

        const run = runSelection({ root, base: 'main', head, githubOutput: false });

        expect(run.status).toBe(0);
        expect(run.stdout).toBe('SKIPPED: every changed path cannot change the ALM lane\n');
        expect(run.githubOutput).toBeUndefined();
    });
});

function runSelection(input: SelectionRunInput): SelectionRun {
    const outputDirectory = createTemporaryRoot('alm-lane-selection-output-');
    const githubOutputPath = path.join(outputDirectory, 'github-output');
    const { GITHUB_OUTPUT: _inherited, ...environment } = process.env;
    const result = spawnSync(process.execPath, [commandPath, '--base', input.base, '--head', input.head], {
        cwd: input.root,
        encoding: 'utf8',
        env: input.githubOutput ? { ...environment, GITHUB_OUTPUT: githubOutputPath } : environment
    });
    return {
        status: result.status,
        stdout: result.stdout,
        githubOutput: existsSync(githubOutputPath) ? readFileSync(githubOutputPath, 'utf8') : undefined
    };
}

/** A repository on `main` with one lane path and one document, committed. */
function createRepository(): string {
    const root = createTemporaryRoot('alm-lane-selection-repository-');
    runGit(root, ['init', '--quiet', '--initial-branch', 'main']);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    runGit(root, ['config', 'user.name', 'Test User']);
    commitFiles(root, {
        'docs/guide.md': 'guide\n',
        'scripts/existing-tool.mjs': 'export const existingTool = true;\n'
    });
    return root;
}

/** Commits the files on a new `topic` branch from the current commit and returns that branch's head. */
function commitOnTopic(root: string, files: Readonly<Record<string, string>>): string {
    runGit(root, ['checkout', '--quiet', '-b', 'topic']);
    commitFiles(root, files);
    return runGit(root, ['rev-parse', 'HEAD']).trim();
}

function commitFiles(root: string, files: Readonly<Record<string, string>>): void {
    for (const [relativePath, contents] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, contents);
    }
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '--quiet', '-m', 'commit files']);
}

function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
}

function runGit(root: string, args: readonly string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
