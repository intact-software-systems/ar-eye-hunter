import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createValidationEvidence } from '../../../../scripts/validation-evidence/validation-evidence-record.mjs';
import { selectReusableValidationEvidence, selectValidationEvidence } from '../../../../scripts/validation-evidence/validation-evidence-selection.mjs';

const repository = 'intact-software-systems/ar-eye-hunter';
const workflowPath = '.github/workflows/branch-release-gate.yml';
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('same-PR validation reuse', () => {
    it('selects rtc-observation before reuse and keeps broad and reuse modes explicit', () => {
        const observationFixture = createFixture();
        const observationId = '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2';
        const archivePath = `performance-observations/rtc-b05/2026/08/27/${observationId}.zip`;
        const observationHead = commit(observationFixture.root, 'observation', {
            [archivePath]: 'zip-bytes',
            'performance-observations/rtc-b05/index.jsonl': `${
                JSON.stringify({
                    archive: { path: archivePath }
                })
            }\n`
        });
        expect(selectMode(observationFixture, observationHead)).toMatchObject({
            mode: 'rtc-observation',
            reuse: false,
            reason: 'rtc-observation-only'
        });

        const reuseFixture = createFixture();
        const reuseHead = commit(reuseFixture.root, 'docs', { 'docs/guide.md': 'clarified\n' });
        expect(selectMode(reuseFixture, reuseHead)).toMatchObject({
            mode: 'reuse',
            reuse: true,
            reason: 'reusable-validation-evidence'
        });

        const broadFixture = createFixture();
        const broadHead = commit(broadFixture.root, 'code', {
            'apps/example/main.ts': 'export const value = 2;\n'
        });
        expect(selectMode(broadFixture, broadHead)).toMatchObject({
            mode: 'broad',
            reuse: false,
            reason: 'build-tree-digest-mismatch'
        });
    });

    it('reuses a successful run from the same PR when only non-build content changed', () => {
        const fixture = createFixture();
        const candidateHead = commit(fixture.root, 'docs', { 'docs/guide.md': 'clarified\n' });

        const result = select(fixture, candidateHead);

        expect(result).toMatchObject({
            reuse: true,
            reason: 'reusable-validation-evidence',
            evidence: fixture.evidence
        });
    });

    it('reruns broad validation when build-affecting content changed', () => {
        const fixture = createFixture();
        const candidateHead = commit(fixture.root, 'code', {
            'apps/example/main.ts': 'export const value = 2;\n'
        });

        expect(select(fixture, candidateHead)).toMatchObject({
            reuse: false,
            reason: 'build-tree-digest-mismatch'
        });
    });

    it.each([
        ['another PR', { candidate: { pullRequestNumber: 223 } }, 'untrusted-workflow-run'],
        [
            'ambiguous PR association',
            { run: { pull_requests: [pullRequest(222), pullRequest(223)] } },
            'untrusted-workflow-run'
        ],
        ['another base', { candidate: { baseBranch: 'release' } }, 'untrusted-workflow-run'],
        [
            'another repository',
            { run: { repository: { full_name: 'other/repo' } } },
            'untrusted-workflow-run'
        ],
        ['failed run', { run: { conclusion: 'failure' } }, 'untrusted-workflow-run'],
        [
            'mismatched artifact PR',
            { evidence: { pullRequestNumber: 223 } },
            'untrusted-validation-evidence-identity'
        ],
        ['malformed artifact', { artifact: '{not json}\n' }, 'malformed-validation-evidence'],
        ['expired artifact', { now: '2026-08-21T10:01:00.000Z' }, 'expired-validation-evidence']
    ])('does not reuse evidence from %s', (_name, mutation, reason) => {
        const fixture = createFixture(mutation as Mutation);
        const candidateHead = commit(fixture.root, 'docs', { 'docs/guide.md': 'clarified\n' });

        expect(select(fixture, candidateHead, mutation as Mutation)).toMatchObject({
            reuse: false,
            reason
        });
    });
});

interface Mutation {
    readonly artifact?: string;
    readonly candidate?: Record<string, unknown>;
    readonly evidence?: Record<string, unknown>;
    readonly now?: string;
    readonly run?: Record<string, unknown>;
}

function createFixture(mutation: Mutation = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'validation-evidence-pr-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=feature', '--quiet']);
    runGit(root, ['config', 'user.name', 'Validation Evidence Test']);
    runGit(root, ['config', 'user.email', 'validation-evidence@example.invalid']);
    const evidenceHead = commit(root, 'base', {
        'package.json': '{"name":"fixture"}\n',
        'apps/example/main.ts': 'export const value = 1;\n'
    });
    const evidence = merge(
        createValidationEvidence({
            repoRoot: root,
            context: {
                repository,
                pullRequestNumber: 222,
                workflowPath,
                runId: 4123,
                runAttempt: 2,
                head: evidenceHead,
                completedAt: '2026-08-13T09:08:00.000Z'
            }
        }),
        mutation.evidence
    );
    const run = merge(
        {
            id: 4123,
            run_attempt: 2,
            head_sha: evidenceHead,
            head_branch: 'feature',
            path: workflowPath,
            event: 'pull_request',
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-08-13T09:00:00.000Z',
            updated_at: '2026-08-13T09:10:00.000Z',
            repository: { full_name: repository },
            pull_requests: [pullRequest(222)]
        },
        mutation.run
    );
    return { root, evidence, evidenceHead, run, artifact: mutation.artifact };
}

function select(
    fixture: ReturnType<typeof createFixture>,
    candidateHead: string,
    mutation: Mutation = {}
) {
    return selectReusableValidationEvidence({
        repoRoot: fixture.root,
        candidate: {
            repository,
            pullRequestNumber: 222,
            workflowPath,
            branch: 'feature',
            baseBranch: 'main',
            head: candidateHead,
            currentRunId: 5000,
            ...mutation.candidate
        },
        runs: [fixture.run],
        readArtifact: () => fixture.artifact ?? `${JSON.stringify(fixture.evidence)}\n`,
        now: mutation.now ?? '2026-08-13T10:00:00.000Z'
    });
}

function selectMode(fixture: ReturnType<typeof createFixture>, candidateHead: string) {
    return selectValidationEvidence({
        repoRoot: fixture.root,
        candidate: {
            repository,
            pullRequestNumber: 222,
            workflowPath,
            branch: 'feature',
            baseBranch: 'main',
            base: fixture.evidenceHead,
            head: candidateHead,
            currentRunId: 5000
        },
        runs: [fixture.run],
        readArtifact: () => `${JSON.stringify(fixture.evidence)}\n`,
        now: '2026-08-13T10:00:00.000Z'
    });
}

function pullRequest(number: number) {
    return { number, base: { ref: 'main' }, head: { ref: 'feature' } };
}

function merge<T extends Record<string, any>>(base: T, mutation: Record<string, unknown> = {}): T {
    return Object.fromEntries(
        Object.entries(base).map(([key, value]) => [
            key,
            isRecord(value) && isRecord(mutation[key])
                ? merge(value, mutation[key] as Record<string, unknown>)
                : (mutation[key] ?? value)
        ])
    ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commit(root: string, message: string, files: Readonly<Record<string, string>>): string {
    for (const [repositoryPath, source] of Object.entries(files)) {
        const filePath = path.join(root, repositoryPath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, source);
    }
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '--quiet', '-m', message]);
    return runGit(root, ['rev-parse', 'HEAD']).trim();
}

function runGit(root: string, arguments_: readonly string[]): string {
    return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
