import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const githubAutomationRoots = ['.github/actions', '.github/workflows'] as const;
const requiredActionReferences = {
    cache: 'actions/cache@v6',
    checkout: 'actions/checkout@v7',
    'setup-node': 'actions/setup-node@v7',
    'upload-artifact': 'actions/upload-artifact@v7'
} as const;

type GovernedActionName = keyof typeof requiredActionReferences;

async function findYamlFiles(relativeDirectory: string): Promise<string[]> {
    const entries = await readdir(path.join(repoRoot, relativeDirectory), {
        withFileTypes: true
    });
    const files: string[] = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const relativePath = path.join(relativeDirectory, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await findYamlFiles(relativePath)));
            continue;
        }

        if (/\.ya?ml$/u.test(entry.name)) {
            files.push(relativePath);
        }
    }

    return files;
}

function sourceLine(source: string, offset: number): number {
    return source.slice(0, offset).split('\n').length;
}

describe('GitHub Actions runtime governance', () => {
    it('resolves an immutable merge-base range and invokes both changed checkers directly', async () => {
        const releaseGate = await readFile(
            path.join(repoRoot, '.github/workflows/release-gate.yml'),
            'utf8'
        );

        expect(releaseGate).toContain('node scripts/resolve-changed-review-range.mjs');
        expect(releaseGate).toContain('tee -a "$GITHUB_OUTPUT"');
        expect(releaseGate).toContain('steps.changed_review_range.outputs.base');
        expect(releaseGate).toContain('steps.changed_review_range.outputs.head');
        expect(releaseGate).toContain('node scripts/check-changed-repo-style.mjs');
        expect(releaseGate).toContain('node scripts/check-test-structure-coupling.mjs --changed');
        expect(releaseGate).not.toContain('npm run check:test-structure-coupling');
    });

    it('observes IDE navigation after dependency installation without weakening failures', async () => {
        const releaseGate = await readFile(
            path.join(repoRoot, '.github/workflows/release-gate.yml'),
            'utf8'
        );
        const installIndex = releaseGate.indexOf('run: npm ci');
        const navigationIndex = releaseGate.indexOf(
            'run: npm run check:repo-style:navigation-details'
        );
        const changedStyleIndex = releaseGate.indexOf(
            'node scripts/check-changed-repo-style.mjs'
        );

        expect(installIndex).toBeGreaterThan(-1);
        expect(navigationIndex).toBeGreaterThan(installIndex);
        expect(changedStyleIndex).toBeGreaterThan(navigationIndex);
        expect(releaseGate.slice(navigationIndex - 120, navigationIndex + 120)).not.toContain(
            'continue-on-error'
        );
    });

    it('restores Deno caches without saving unless the exact main push is checked out', async () => {
        const releaseGate = await readFile(
            path.join(repoRoot, '.github/workflows/release-gate.yml'),
            'utf8'
        );
        const restoreOnlyCacheStep = getWorkflowStep(
            releaseGate,
            'Restore Deno cache without save permission'
        );
        const trustedCacheStep = getWorkflowStep(releaseGate, 'Cache Deno for trusted runs');

        expect(restoreOnlyCacheStep).toContain(
            'if: ${{ github.event_name != \'push\' || github.ref != \'refs/heads/main\' || inputs.candidate_ref != github.sha }}'
        );
        expect(restoreOnlyCacheStep).toContain('uses: actions/cache/restore@v6');
        expect(restoreOnlyCacheStep).not.toContain('uses: actions/cache@v6');
        expect(trustedCacheStep).toContain(
            'if: ${{ github.event_name == \'push\' && github.ref == \'refs/heads/main\' && inputs.candidate_ref == github.sha }}'
        );
        expect(trustedCacheStep).toContain('uses: actions/cache@v6');
        expect(releaseGate).not.toContain('lookup-only:');
        expect(releaseGate).toContain(
            'ref: ${{ github.event_name == \'workflow_dispatch\' && github.sha || inputs.candidate_ref }}'
        );
    });

    it('uses the exact merge base when the trusted base tip has diverged', async () => {
        const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rallar-changed-review-range-'));
        try {
            runGit(fixtureRoot, ['init']);
            runGit(fixtureRoot, ['config', 'user.email', 'test@example.com']);
            runGit(fixtureRoot, ['config', 'user.name', 'Test User']);
            mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
            writeFileSync(path.join(fixtureRoot, 'contract.txt'), 'common\n');
            runGit(fixtureRoot, ['add', '.']);
            runGit(fixtureRoot, ['commit', '-m', 'common']);
            const common = runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();
            runGit(fixtureRoot, ['branch', 'feature']);
            writeFileSync(path.join(fixtureRoot, 'base.txt'), 'advanced base\n');
            runGit(fixtureRoot, ['add', '.']);
            runGit(fixtureRoot, ['commit', '-m', 'advance trusted base']);
            const trustedBaseTip = runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();
            runGit(fixtureRoot, ['switch', 'feature']);
            writeFileSync(path.join(fixtureRoot, 'feature.txt'), 'candidate\n');
            runGit(fixtureRoot, ['add', '.']);
            runGit(fixtureRoot, ['commit', '-m', 'candidate']);
            const candidateHead = runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();

            const output = execFileSync(
                process.execPath,
                [
                    path.join(repoRoot, 'scripts/resolve-changed-review-range.mjs'),
                    trustedBaseTip,
                    candidateHead
                ],
                { cwd: fixtureRoot, encoding: 'utf8' }
            );

            expect(output).toContain(`trusted_base_tip=${trustedBaseTip}`);
            expect(output).toContain(`base=${common}`);
            expect(output).toContain(`head=${candidateHead}`);
            expect(output).not.toContain(`base=${trustedBaseTip}`);
        }
        finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });

    it('cannot bypass structure review by replacing the package script with a no-op', async () => {
        const releaseGate = await readFile(
            path.join(repoRoot, '.github/workflows/release-gate.yml'),
            'utf8'
        );
        const structureCommand = releaseGate.match(
            /node scripts\/check-test-structure-coupling\.mjs\s+--changed/u
        )?.[0];

        expect(structureCommand).toBeDefined();
        expect(structureCommand).not.toContain('npm run');
        expect(structureCommand).not.toContain('check:test-structure-coupling');
    });

    it('uses the Node 24 action releases throughout executable automation', async () => {
        const yamlFiles = (await Promise.all(githubAutomationRoots.map(findYamlFiles))).flat();
        const observedActions = new Set<GovernedActionName>();
        const violations: string[] = [];
        const actionReference = /uses:\s*actions\/(cache|checkout|setup-node|upload-artifact)@([^\s#'"]+)/gu;

        for (const relativePath of yamlFiles) {
            const source = await readFile(path.join(repoRoot, relativePath), 'utf8');

            for (const match of source.matchAll(actionReference)) {
                const actionName = match[1] as GovernedActionName;
                const actualReference = `actions/${actionName}@${match[2]}`;
                const expectedReference = requiredActionReferences[actionName];

                observedActions.add(actionName);

                if (actualReference !== expectedReference) {
                    violations.push(
                        `${relativePath}:${sourceLine(source, match.index)} uses ${actualReference}; expected ${expectedReference}`
                    );
                }
            }
        }

        expect([...observedActions].sort()).toEqual(Object.keys(requiredActionReferences).sort());
        expect(violations).toEqual([]);
    });
});

function runGit(root: string, args: readonly string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function getWorkflowStep(source: string, stepName: string): string {
    const marker = `      - name: ${stepName}`;
    const start = source.indexOf(marker);
    if (start === -1) {
        return '';
    }

    const nextStep = source.indexOf('\n      - name:', start + marker.length);
    return source.slice(start, nextStep === -1 ? undefined : nextStep);
}
