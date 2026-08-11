import { describe, expect, it } from 'vitest';
import {
    evaluateAbsenceOutcomeParityRows,
    evaluateComparatorOutcomeParityRows,
    evaluateCompleteArrayOutcomeParityRows,
    evaluatePollingOutcomeParityRows,
    type AssertionOutcomeParityRow,
} from '../../shared-test/rallar-bb-test/conformance/assertion-outcome-parity.ts';
import {
    analyzeDistributedRunArtifactFiles,
} from '../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

function expectRowsHold(rows: readonly AssertionOutcomeParityRow[]): void {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
        expect(row.agree, `${row.fixtureId}: runner=${row.runnerVerdict} runtime=${row.runtimeVerdict}`).toBe(true);
        expect(row.matchesExpected, `${row.fixtureId}: expected=${row.expectedVerdict}`).toBe(true);
    }
}

function pollingFetch(succeedOnAttempt: number | undefined): typeof fetch {
    let attempt = 0;
    return (async () => {
        attempt += 1;
        const converged = succeedOnAttempt !== undefined && attempt >= succeedOnAttempt;
        return new Response(JSON.stringify({ attempt, converged }), {
            status: converged ? 200 : 503,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
}

function failingRunFiles(code: string, message: string): Record<string, string> {
    return {
        'distributed-run.json': JSON.stringify({
            distributedRunId: `dist-${code.toLowerCase()}`,
            controlRunId: 'run-assertions',
            state: 'failed',
            startedAtEpochMs: 1_000,
            completedAtEpochMs: 4_000,
            rollup: {
                ok: false,
                summary: {
                    participants: 1,
                    failedParticipants: 1,
                    blockingFailures: 1,
                },
            },
            manifest: {
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'bb-group',
                },
            },
        }),
        'results.jsonl': JSON.stringify({
            resultKey: `controller-01:${code}`,
            status: 'FAILURE',
            transport: 'realtime',
            action: 'wait',
            agentId: 'controller-01',
            commandId: 'assertion-command',
            actual: {
                code,
                message,
            },
        }),
    };
}

describe('rallar-bb-test assertion outcome parity', () => {
    it('agrees with the runner comparator verdicts on shared fixtures', () => {
        expectRowsHold(evaluateComparatorOutcomeParityRows());
    });

    it('agrees with the runner compatible-complete verdicts including unexpected array elements', () => {
        expectRowsHold(evaluateCompleteArrayOutcomeParityRows());
    });

    it('agrees with the runner absence verdicts on buffered and clean evidence', async () => {
        expectRowsHold(await evaluateAbsenceOutcomeParityRows());
    });

    it('agrees with the runner polling verdicts for convergence and exhaustion', async () => {
        expectRowsHold(await evaluatePollingOutcomeParityRows({ fetch: pollingFetch }));
    });

    it('names absence violations in analysis and fix proposals', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: failingRunFiles(
                'RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED',
                'Wait absence was violated: a runtime event matched before the window closed.',
            ),
        });

        expect(analysis.status).toBe('failed');
        expect(analysis.failure?.category).toBe('assertion-absence');
        expect(analysis.failure?.minimalFixArea).toBe('absence wait window or leaked traffic source');
        expect(analysis.fixProposalMarkdown).toContain('assertion-absence');
        expect(analysis.summaryMarkdown ?? '').not.toContain('RALLAR_CONTROL_ADMIN_TOKEN');
    });

    it('names until-loop exhaustion in analysis and fix proposals', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: failingRunFiles(
                'RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED',
                'Loop until mode exhausted 3 attempt(s) without a fully passing iteration.',
            ),
        });

        expect(analysis.status).toBe('failed');
        expect(analysis.failure?.category).toBe('convergence-polling');
        expect(analysis.failure?.minimalFixArea)
            .toBe('convergence polling bounds or backend convergence');
        expect(analysis.fixProposalMarkdown).toContain('convergence-polling');
    });
});
