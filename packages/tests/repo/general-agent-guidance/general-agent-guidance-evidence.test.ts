import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeFullWorktreeTree, readGitObject, resolveTreeIdentity, validateEvidenceLedger } from './evaluation-evidence.mjs';

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('general agent guidance evidence ledger', () => {
    it('reads baseline automatic guidance from an immutable Git object', () => {
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: process.cwd(),
            encoding: 'utf8'
        }).trim();

        expect(readGitObject(process.cwd(), { revision, path: 'AGENTS.md' })).toBe(
            execFileSync('git', ['show', `${revision}:AGENTS.md`], {
                cwd: process.cwd(),
                encoding: 'utf8'
            })
        );
    });

    it('resolves the immutable baseline and complete current worktree trees', () => {
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: process.cwd(),
            encoding: 'utf8'
        }).trim();
        const baselineTree = execFileSync('git', ['rev-parse', `${revision}^{tree}`], {
            cwd: process.cwd(),
            encoding: 'utf8'
        }).trim();
        const candidateTree = computeFullWorktreeTree(process.cwd());

        expect(resolveTreeIdentity(process.cwd(), { kind: 'immutable-head-tree', revision })).toBe(
            `git-tree:${baselineTree}`
        );
        expect(resolveTreeIdentity(process.cwd(), { kind: 'full-worktree-git-tree' })).toBe(
            `git-tree:${candidateTree}`
        );
        expect(candidateTree).toMatch(/^[a-f0-9]{40}$/u);
    });

    it('accepts one provenance-bound frozen 5+5 campaign', () => {
        const fixture = createFixture();

        expect(validateEvidenceLedger(fixture)).toEqual([]);
    });

    it.each([
        ['missing per-run identity', (ledger: EvidenceLedger) => delete ledger.runs[0].freshAgentId],
        [
            'raw output digest drift',
            (ledger: EvidenceLedger, root: string) => writeFileSync(path.join(root, ledger.runs[0].rawOutputArtifact), 'changed', 'utf8')
        ],
        [
            'runtime preamble digest drift',
            (ledger: EvidenceLedger, root: string) => writeFileSync(path.join(root, ledger.runs[0].runtimePreambleArtifact), 'changed', 'utf8')
        ],
        [
            'undeclared automatic input',
            (ledger: EvidenceLedger) =>
                ledger.runs[0].automaticInputs.push({
                    id: 'undeclared',
                    source: 'mystery',
                    artifact: 'AGENTS.md',
                    digest: sha256('mystery')
                })
        ],
        ['absent canonical run ID', (ledger: EvidenceLedger) => ledger.runs.splice(0, 1)]
    ])('rejects %s', (_name, mutate) => {
        const fixture = createFixture();
        const ledger = readJson(path.join(fixture.repoRoot, fixture.ledgerPath)) as EvidenceLedger;
        mutate(ledger, fixture.repoRoot);
        writeFileSync(
            path.join(fixture.repoRoot, fixture.ledgerPath),
            JSON.stringify(ledger, null, 2),
            'utf8'
        );

        expect(validateEvidenceLedger(fixture)).not.toEqual([]);
    });
});

function createFixture(): ValidationInput {
    const root = mkdtempSync(path.join(os.tmpdir(), 'general-agent-guidance-evidence-'));
    temporaryRoots.push(root);
    const contractPath = 'evaluation.json';
    const ledgerPath = 'ledger.json';
    const prompt = 'Decide how to continue.';
    const contract = {
        schemaVersion: 'general-agent-guidance-evaluation-v2',
        repetitionsPerVariant: 5,
        execution: {
            model: 'gpt-5.6-terra',
            reasoningEffort: 'medium',
            forkTurns: 'none',
            singleShot: true
        },
        automaticInputs: [
            { id: 'repository-guide', source: 'AGENTS.md' },
            { id: 'codex-runtime-guidance', source: 'runtime-injected-system-and-developer' }
        ],
        scenario: { prompt },
        variants: [
            { id: 'no-skill', explicitInputs: [] },
            { id: 'with-canonical-skills', explicitInputs: ['skill.md'] }
        ],
        requiredDimensions: [
            { id: 'routing.working-plan' },
            { id: 'routing.repository-structure' },
            { id: 'delivery.pr-state-first' },
            { id: 'delivery.base-movement-noop' },
            { id: 'validation.proportional-local-scope' },
            { id: 'publication.pr-authority' }
        ],
        evidenceContract: {
            schemaVersion: 'general-agent-guidance-evidence-ledger-v2',
            requiredPerRunFields: requiredPerRunFields
        }
    };
    writeFileSync(path.join(root, contractPath), JSON.stringify(contract, null, 2), 'utf8');
    writeFileSync(path.join(root, 'AGENTS.md'), 'candidate agents\n', 'utf8');
    writeFileSync(path.join(root, 'baseline-agents.md'), 'baseline agents\n', 'utf8');
    writeFileSync(path.join(root, 'skill.md'), 'candidate skill\n', 'utf8');
    writeFileSync(path.join(root, 'runtime.json'), '{"runtime":"codex"}\n', 'utf8');

    const variants = [
        createVariant(
            'no-skill',
            'git-tree:1111111111111111111111111111111111111111',
            sha256('baseline agents\n'),
            'baseline-agents.md',
            []
        ),
        createVariant(
            'with-canonical-skills',
            `git-tree:${'2'.repeat(40)}`,
            sha256('candidate agents\n'),
            'AGENTS.md',
            [
                {
                    id: 'skill.md',
                    source: 'skill.md',
                    artifact: 'skill.md',
                    digest: sha256('candidate skill\n')
                }
            ]
        )
    ];
    const runs: EvidenceRun[] = [];
    for (const variant of variants) {
        for (let repetition = 1; repetition <= 5; repetition += 1) {
            const runId = `${variant.id}-${repetition}`;
            const preamble = `run ${runId}`;
            const runtimePreambleArtifact = `${runId}.preamble.md`;
            const rawOutputArtifact = `${runId}.raw.md`;
            const scoreArtifact = `${runId}.score.json`;
            const raw = `answer ${runId}\n`;
            const score = JSON.stringify({
                runId,
                dimensions: Object.fromEntries(
                    contract.requiredDimensions.map(({ id }) => [id, variant.id !== 'no-skill'])
                )
            });
            writeFileSync(path.join(root, rawOutputArtifact), raw, 'utf8');
            writeFileSync(path.join(root, scoreArtifact), score, 'utf8');
            writeFileSync(path.join(root, runtimePreambleArtifact), preamble, 'utf8');
            const runtimePreambleDigest = sha256(preamble);
            runs.push({
                runId,
                variant: variant.id,
                status: 'completed',
                treeIdentity: variant.treeIdentity,
                automaticInputs: structuredClone(variant.automaticInputs),
                explicitInputs: structuredClone(variant.explicitInputs),
                inputBundleDigest: variant.inputBundleDigest,
                promptDigest: sha256(prompt),
                runtimePreambleArtifact,
                runtimePreambleDigest,
                exactInvocationDigest: digestCanonical({
                    inputBundleDigest: variant.inputBundleDigest,
                    promptDigest: sha256(prompt),
                    runtimePreambleDigest,
                    treeIdentity: variant.treeIdentity,
                    model: contract.execution.model,
                    reasoningEffort: contract.execution.reasoningEffort,
                    forkTurns: contract.execution.forkTurns,
                    singleShot: contract.execution.singleShot,
                    freshAgentId: `/root/evaluation/${runId}`
                }),
                model: contract.execution.model,
                reasoningEffort: contract.execution.reasoningEffort,
                forkTurns: contract.execution.forkTurns,
                singleShot: contract.execution.singleShot,
                freshAgentId: `/root/evaluation/${runId}`,
                startedAt: '2026-08-12T20:00:00.000Z',
                completedAt: '2026-08-12T20:01:00.000Z',
                rawOutputArtifact,
                rawOutputDigest: sha256(raw),
                scoreArtifact,
                scoreDigest: sha256(score)
            });
        }
    }
    const ledger = {
        schemaVersion: 'general-agent-guidance-evidence-ledger-v2',
        campaignId: 'fixture',
        contractDigest: sha256(readFileSync(path.join(root, contractPath))),
        runtimeGuidance: {
            artifact: 'runtime.json',
            digest: sha256(readFileSync(path.join(root, 'runtime.json')))
        },
        variants,
        runs
    };
    writeFileSync(path.join(root, ledgerPath), JSON.stringify(ledger, null, 2), 'utf8');
    return { repoRoot: root, contractPath, ledgerPath };
}

function createVariant(
    id: string,
    treeIdentity: string,
    agentsDigest: string,
    agentsArtifact: string,
    explicitInputs: EvidenceInput[]
): EvidenceVariant {
    const automaticInputs = [
        {
            id: 'repository-guide',
            source: 'AGENTS.md',
            artifact: agentsArtifact,
            digest: agentsDigest
        },
        {
            id: 'codex-runtime-guidance',
            source: 'runtime-injected-system-and-developer',
            artifact: 'runtime.json',
            digest: sha256('{"runtime":"codex"}\n')
        }
    ];
    return {
        id,
        treeIdentity,
        automaticInputs,
        explicitInputs,
        inputBundleDigest: digestCanonical({ automaticInputs, explicitInputs })
    };
}

function readJson(filePath: string): unknown {
    return JSON.parse(readFileSync(filePath, 'utf8'));
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
    return createHash('sha256').update(value).digest('hex');
}

function digestCanonical(value: unknown): string {
    return sha256(JSON.stringify(sortValue(value)));
}

function sortValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortValue);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, sortValue(child)])
        );
    }
    return value;
}

const requiredPerRunFields = [
    'runId',
    'variant',
    'status',
    'treeIdentity',
    'automaticInputs',
    'explicitInputs',
    'inputBundleDigest',
    'promptDigest',
    'runtimePreambleArtifact',
    'runtimePreambleDigest',
    'exactInvocationDigest',
    'model',
    'reasoningEffort',
    'forkTurns',
    'singleShot',
    'freshAgentId',
    'startedAt',
    'completedAt',
    'rawOutputArtifact',
    'rawOutputDigest',
    'scoreArtifact',
    'scoreDigest'
] as const;

interface ValidationInput {
    readonly repoRoot: string;
    readonly contractPath: string;
    readonly ledgerPath: string;
}

interface EvidenceInput {
    readonly id: string;
    readonly source: string;
    readonly artifact: string;
    readonly digest: string;
}

interface EvidenceVariant {
    readonly id: string;
    readonly treeIdentity: string;
    readonly automaticInputs: EvidenceInput[];
    readonly explicitInputs: EvidenceInput[];
    readonly inputBundleDigest: string;
}

interface EvidenceRun extends Omit<EvidenceVariant, 'id'> {
    status: string;
    variant: string;
    runId: string;
    promptDigest: string;
    runtimePreambleDigest: string;
    runtimePreambleArtifact: string;
    exactInvocationDigest: string;
    model: string;
    reasoningEffort: string;
    forkTurns: string;
    singleShot: boolean;
    freshAgentId?: string;
    startedAt: string;
    completedAt: string;
    rawOutputArtifact: string;
    rawOutputDigest: string;
    scoreArtifact: string;
    scoreDigest: string;
}

interface EvidenceLedger {
    runs: EvidenceRun[];
}
