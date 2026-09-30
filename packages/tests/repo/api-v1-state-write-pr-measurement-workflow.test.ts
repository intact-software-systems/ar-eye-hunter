import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
    readonly name?: string;
    readonly run?: string;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string | number>>;
}

interface WorkflowJob {
    readonly if: string;
    readonly env: Readonly<Record<string, string>>;
    readonly steps: readonly WorkflowStep[];
}

interface WorkflowDocument {
    readonly on: Readonly<{
        pull_request: Readonly<{ types: readonly string[]; }>;
        workflow_dispatch: Readonly<{ inputs: Readonly<Record<string, Readonly<{ required: boolean; type: string; }>>>; }>;
    }>;
    readonly concurrency: Readonly<Record<string, string | boolean>>;
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const WORKFLOW_PATH = '.github/workflows/api-v1-state-write-pr-measurement.yml';
const PERF_DIRECTORY = 'apps/api-v1/scripts/perf';
const COMPARATOR = `${PERF_DIRECTORY}/compare-api-v1-state-write-results.mjs`;

describe('API v1 state-write PR measurement workflow', () => {
    it('runs for any labelled pull request or dispatched ref, pinned to no pull request or commit', () => {
        const source = readFileSync(path.join(repoRoot, WORKFLOW_PATH), 'utf8');
        const workflow = readWorkflow();

        expect(workflow.on.pull_request.types).toEqual(['labeled']);
        expect(workflow.on.workflow_dispatch.inputs.ref).toMatchObject({
            required: true,
            type: 'string'
        });
        expect(workflow.jobs.compare.if).toContain(
            'github.event.label.name == \'measure-state-write\''
        );
        expect(workflow.jobs.compare.if).toContain('github.event_name == \'workflow_dispatch\'');
        expect(source).not.toMatch(/\b[0-9a-f]{40}\b/u);
        expect(source).not.toMatch(/pull_request\.number\s*==/u);
        expect(source).not.toContain('measure-state-write-566');
    });

    it('lets a newer measurement of the same pull request and label cancel the older one', () => {
        expect(readWorkflow().concurrency).toEqual({
            group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}-${{ github.event.label.name || inputs.ref }}',
            'cancel-in-progress': true
        });
    });

    it('refuses a candidate that changes the comparator or any module it imports', () => {
        const declared = readWorkflow().jobs.compare.env.COMPARATOR_FILES.split(/\s+/u).filter(
            Boolean
        ).sort();

        expect(declared).toEqual([...readRelativeImportClosure(COMPARATOR)].sort());
        expect(readStepRun('Resolve the merge base and validate the runner')).toContain(
            'git diff --exit-code "$base_commit" "$candidate_commit" -- $COMPARATOR_FILES'
        );
    });

    it('measures the merge base against the candidate in A-B-B-A order and compares them unchanged', () => {
        expect(readStepRun('Resolve the merge base and validate the runner')).toContain(
            'node scripts/resolve-changed-review-range.mjs origin/main HEAD'
        );
        expect(readStepRun('Capture A-B-B-A on the same runner')).toContain(
            'for source_commit in "$BASE_MEASUREMENT_COMMIT" "$CANDIDATE_COMMIT" "$CANDIDATE_COMMIT" "$BASE_MEASUREMENT_COMMIT"; do'
        );
        expect(readStepRun('Capture A-B-B-A on the same runner')).toContain(
            '--backend=postgres --warmup=1 --runs=9 --concurrency=10'
        );
        const compare = readStepRun('Pool and compare with the unchanged comparator');
        expect(toCommandTokens(compare)).toContain(
            `node --max-old-space-size=12288 ${COMPARATOR} "$output/approved-base.json" "$output/candidate.json"`
        );
        expect(compare).not.toMatch(/regression-reason/u);
    });

    it('retains the captures under the artifact name later readers download', () => {
        const upload = readWorkflow().jobs.compare.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));

        expect(upload?.with?.name).toBe(
            'state-write-comparison-${{ github.run_id }}-${{ github.run_attempt }}'
        );
    });
});

function readWorkflow(): WorkflowDocument {
    return load(readFileSync(path.join(repoRoot, WORKFLOW_PATH), 'utf8')) as WorkflowDocument;
}

function readStepRun(name: string): string {
    const step = readWorkflow().jobs.compare.steps.find((candidate) => candidate.name === name);
    if (step?.run === undefined) {
        throw new Error(`Expected a run step named ${name}`);
    }
    return step.run;
}

function toCommandTokens(script: string): string {
    return script.replace(/\\\n/gu, ' ').split(/\s+/u).filter(Boolean).join(' ');
}

function readRelativeImportClosure(entry: string): ReadonlySet<string> {
    const closure = new Set<string>();
    const pending = [entry];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
        if (closure.has(file)) {
            continue;
        }
        closure.add(file);
        const source = readFileSync(path.join(repoRoot, file), 'utf8');
        for (const match of source.matchAll(/from '(\.\/[^']+)'/gu)) {
            pending.push(path.posix.join(path.posix.dirname(file), match[1]));
        }
    }
    return closure;
}
