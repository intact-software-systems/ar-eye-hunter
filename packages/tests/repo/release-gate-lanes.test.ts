import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import vitestConfig from '../../../vitest.config.ts';

interface WorkflowStep {
    readonly run?: string;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}

interface MatrixShare {
    readonly id?: string;
    readonly scope?: string;
    readonly shard?: string;
}

interface WorkflowMatrix {
    readonly shard?: readonly string[];
    readonly include?: readonly MatrixShare[];
}

interface WorkflowService {
    readonly image: string;
}

interface WorkflowJob {
    readonly 'continue-on-error'?: boolean;
    readonly env?: Readonly<Record<string, string>>;
    readonly services?: Readonly<Record<string, WorkflowService>>;
    readonly steps: readonly WorkflowStep[];
    readonly strategy?: Readonly<{ matrix: WorkflowMatrix; }>;
}

interface WorkflowDocument {
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

interface PackageManifest {
    readonly scripts: Readonly<Record<string, string>>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const scripts = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageManifest).scripts;
const releaseGate = load(
    readFileSync(path.join(repoRoot, '.github/workflows/release-gate.yml'), 'utf8')
) as WorkflowDocument;
const blockingLanes = Object.values(releaseGate.jobs).filter((job) => job['continue-on-error'] !== true);
const laneScripts = blockingLanes.flatMap((job) => job.steps.flatMap(toNpmScripts));

describe('Release Gate lanes', () => {
    it('runs every suite that npm run test:ci composes', () => {
        const invoked = new Set(laneScripts.flatMap(toLeafScripts));
        // test:unit runs as one Vitest project per lane; the next test proves that split is complete.
        const required = toLeafScripts('test:ci').filter((leaf) => leaf !== 'test:unit');

        expect(required.length).toBeGreaterThan(0);
        expect(required.filter((leaf) => !invoked.has(leaf))).toEqual([]);
    });

    it('runs every Vitest project in exactly one lane', () => {
        const laneProjects = laneScripts.flatMap(
            (name) => [...(scripts[name] ?? '').matchAll(/vitest run --project (\S+)/gu)].map((match) => match[1])
        );

        expect(laneProjects.toSorted()).toEqual(toVitestProjectNames().toSorted());
    });

    it('keeps the static checks, builds and Postgres suites beside the test lanes', () => {
        const laneRuns = blockingLanes.flatMap((job) => job.steps.map((step) => step.run ?? '')).join('\n');

        expect(laneScripts).toEqual(expect.arrayContaining([
            'typecheck',
            'build:ar-eye-hunter-v1',
            'build:relic-hunters-v1',
            'build:rallar',
            'db:migrate',
            'test:postgres:integration',
            'test:rallar:full-stack:postgres:rest',
            'test:rallar:full-stack:postgres:control'
        ]));
        for (
            const denoCheck of [
                'npm --workspace @ar-eye-hunter/shared-test run check:deno',
                '(cd apps/api-v1 && deno task check)',
                '(cd apps/relic-hunter-server-v1 && deno task check)',
                '(cd apps/rallar-black-box-control-server && deno task check)'
            ]
        ) {
            expect(laneRuns).toContain(denoCheck);
        }
    });

    it('runs every blocking lane with the in-memory configuration profile and no credential secret', () => {
        for (const job of blockingLanes) {
            expect(job.env?.RALLAR_API_CONFIGURATION_PROFILE).toBe('prod-in-memory');
            expect(job.env).not.toHaveProperty('RALLAR_AUTH_CREDENTIAL_SECRET');
        }
    });

    it('runs every share of a sharded lane exactly once', () => {
        const shardedLanes = Object.entries(releaseGate.jobs).filter(([, job]) => toShares(job).length > 0);

        expect(shardedLanes.map(([laneName]) => laneName).toSorted()).toEqual(['black-box', 'e2e-recipe-console']);
        for (const [, job] of shardedLanes) {
            const shares = toShares(job).map((share) => share.split('/').map(Number));
            const count = shares[0][1];

            expect(count).toBeGreaterThan(1);
            expect(shares.map(([, shareCount]) => shareCount)).toEqual(shares.map(() => count));
            expect(shares.map(([index]) => index).toSorted()).toEqual(Array.from({ length: count }, (_, offset) => offset + 1));
        }
    });

    it('runs the standard black-box shares and the cluster profile in separate lanes', () => {
        const lane = releaseGate.jobs['black-box'];
        const includes = lane.strategy?.matrix.include ?? [];
        const [runStep] = lane.steps.filter((step) => step.uses === './.github/actions/api-v1-black-box-test');

        expect(includes.filter((share) => share.scope === 'cluster')).toHaveLength(1);
        expect(includes.filter((share) => share.scope === 'standard' && share.shard)).toHaveLength(includes.length - 1);
        expect(new Set(includes.map((share) => share.id)).size).toBe(includes.length);
        // Each lane needs its own database, artifact directory and upload name.
        expect(runStep.with?.scope).toBe('${{ matrix.scope }}');
        expect(runStep.with?.shard).toBe('${{ matrix.shard }}');
        expect(runStep.with?.['artifact-dir']).toContain('${{ matrix.id }}');
        expect(runStep.with?.['run-id']).toContain('${{ matrix.id }}');
    });

    it('keeps Postgres presence expiry last, and twice, in a lane with its own Postgres', () => {
        const postgresLanes = blockingLanes.filter((job) => job.steps.flatMap(toNpmScripts).includes('test:postgres:presence-expiry'));

        expect(postgresLanes).toHaveLength(1);
        const [lane] = postgresLanes;
        const commands = lane.steps.flatMap(toNpmScripts);

        expect(lane.services?.postgres?.image).toBe('postgres:16');
        expect(commands.slice(-2)).toEqual(['test:postgres:presence-expiry', 'test:postgres:presence-expiry']);
        expect(commands).toContain('test:postgres:integration');
    });
});

function toShares(job: WorkflowJob): string[] {
    const matrix = job.strategy?.matrix;
    return [...(matrix?.shard ?? []), ...(matrix?.include ?? []).map((share) => share.shard ?? '')].filter((share) => share !== '');
}

function toNpmScripts(step: WorkflowStep): string[] {
    return [...(step.run ?? '').matchAll(/npm run ([\w:-]+)/gu)].map((match) => match[1]);
}

// A script made only of chained `npm run` calls stands for its members; any other script is a leaf.
function toLeafScripts(name: string): string[] {
    const script = scripts[name] ?? '';
    const members = [...script.matchAll(/npm run ([\w:-]+)/gu)].map((match) => match[1]);
    const onlyChains = script.replaceAll(/npm run [\w:-]+/gu, '').replaceAll('&&', '').trim() === '';

    return onlyChains && members.length > 0 ? members.flatMap(toLeafScripts) : [name];
}

function toVitestProjectNames(): string[] {
    return (vitestConfig.test?.projects ?? []).map((project) => {
        if (typeof project !== 'object' || project instanceof Promise || typeof project.test?.name !== 'string') {
            throw new TypeError('Every Vitest project must be an inline configuration with a string name.');
        }
        return project.test.name;
    });
}
