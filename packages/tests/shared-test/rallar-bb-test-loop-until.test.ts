import { describe, expect, it } from 'vitest';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema.ts';
import type { RallarBlackBoxTestLoopResultValue, RallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/types.ts';

function createPollingRuntime(): Readonly<{
    runtime: RallarBlackBoxTestRuntime;
    sleptDurations: number[];
}> {
    let now = 1_000;
    let sequence = 1;
    const sleptDurations: number[] = [];
    const runtime = createRallarBlackBoxTestRuntime({
        now: () => now++,
        idFactory: (prefix) => `${prefix}-${sequence++}`,
        sleep: async (ms) => {
            sleptDurations.push(ms);
            now += ms;
        }
    });
    return { runtime, sleptDurations };
}

describe('rallar-bb-test loop until first-success', () => {
    it('polls an http.request + assert pair to convergence and exits early', async () => {
        const { runtime } = createPollingRuntime();

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'poll-until-converged',
            until: 'first-success',
            count: 10,
            intervalMs: 10,
            commands: [
                {
                    kind: 'http.request',
                    commandId: 'poll-request',
                    request: { url: 'https://api.example.test/status' }
                },
                {
                    kind: 'assert',
                    commandId: 'poll-assert-converged',
                    source: 'state.commandHistory.length',
                    operator: 'gte',
                    expected: 5
                }
            ]
        });

        expect(result.ok).toBe(true);
        const value = result.value as RallarBlackBoxTestLoopResultValue;
        expect(value.iterations).toBe(3);
        expect(value.results.at(-1)?.result.ok).toBe(true);
        expect(value.pacing?.completedIterations).toBe(3);
    });

    it('stops an attempt at its first failing child and retries the whole iteration', async () => {
        const { runtime } = createPollingRuntime();

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'poll-until-first-child-gate',
            until: 'first-success',
            count: 4,
            commands: [
                {
                    kind: 'assert',
                    commandId: 'poll-gate',
                    source: 'state.commandHistory.length',
                    operator: 'gte',
                    expected: 2
                },
                {
                    kind: 'health',
                    commandId: 'poll-after-gate'
                }
            ]
        });

        expect(result.ok).toBe(true);
        const value = result.value as RallarBlackBoxTestLoopResultValue;
        const attemptChildCounts = value.pacing?.iterations.map((entry) => entry.commandCount);
        expect(attemptChildCounts).toEqual([1, 1, 2]);
    });

    it('exhausts the count bound with the last failing child in the error details', async () => {
        const { runtime } = createPollingRuntime();

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'poll-until-exhausted',
            until: 'first-success',
            count: 3,
            intervalMs: 5,
            commands: [
                {
                    kind: 'assert',
                    commandId: 'poll-never-converges',
                    source: 'state.commandHistory.length',
                    operator: 'lte',
                    expected: -1
                }
            ]
        });

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED');
        const details = result.error?.details as {
            attempts: number;
            lastFailedChildResult: { commandId: string; result: { ok: boolean; }; };
        };
        expect(details.attempts).toBe(3);
        expect(details.lastFailedChildResult.result.ok).toBe(false);
        expect(details.lastFailedChildResult.commandId).toContain('poll-never-converges');
        const value = result.value as RallarBlackBoxTestLoopResultValue;
        expect(value.iterations).toBe(3);
    });

    it('applies exponential backoff between failed attempts', async () => {
        const { runtime, sleptDurations } = createPollingRuntime();

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'poll-until-backoff',
            until: 'first-success',
            backoffMultiplier: 2,
            count: 4,
            intervalMs: 10,
            commands: [
                {
                    kind: 'assert',
                    commandId: 'poll-backoff-never',
                    source: 'state.commandHistory.length',
                    operator: 'lte',
                    expected: -1
                }
            ]
        });

        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED');
        expect(sleptDurations).toEqual([10, 20, 40]);
    });

    it('rejects continueOnFailure and lone backoffMultiplier in until mode at the runtime', async () => {
        const { runtime } = createPollingRuntime();

        const contradiction = await runtime.execute({
            kind: 'loop',
            commandId: 'until-continue-contradiction',
            until: 'first-success',
            continueOnFailure: true,
            commands: [{ kind: 'health', commandId: 'until-health' }]
        });
        expect(contradiction.status).toBe('failed');
        expect(contradiction.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_INVALID');

        const loneBackoff = await runtime.execute({
            kind: 'loop',
            commandId: 'lone-backoff',
            backoffMultiplier: 2,
            commands: [{ kind: 'health', commandId: 'lone-backoff-health' }]
        });
        expect(loneBackoff.status).toBe('failed');
        expect(loneBackoff.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_INVALID');
    });

    it('validates until mode at the control protocol and schema boundaries', () => {
        expect(validateRallarBlackBoxTestCommand({
            kind: 'loop',
            commandId: 'until-protocol-valid',
            until: 'first-success',
            backoffMultiplier: 1.5,
            count: 5,
            intervalMs: 10,
            commands: [{ kind: 'health', commandId: 'until-child' }]
        })).toEqual({ ok: true });

        expect(validateRallarBlackBoxTestCommand({
            kind: 'loop',
            commandId: 'until-protocol-contradiction',
            until: 'first-success',
            continueOnFailure: true,
            commands: [{ kind: 'health', commandId: 'until-child' }]
        })).toEqual({
            ok: false,
            error: 'loop.continueOnFailure contradicts until mode.'
        });

        expect(validateRallarBlackBoxTestCommand({
            kind: 'loop',
            commandId: 'until-protocol-lone-backoff',
            backoffMultiplier: 2,
            commands: [{ kind: 'health', commandId: 'until-child' }]
        })).toEqual({
            ok: false,
            error: 'loop.backoffMultiplier requires until mode.'
        });

        expect(validateRallarBlackBoxTestCommand({
            kind: 'loop',
            commandId: 'until-protocol-low-backoff',
            until: 'first-success',
            backoffMultiplier: 0.5,
            commands: [{ kind: 'health', commandId: 'until-child' }]
        })).toEqual({
            ok: false,
            error: 'loop.backoffMultiplier must be >= 1.'
        });

        expect(
            validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
                kind: 'loop',
                commandId: 'until-schema-valid',
                until: 'first-success',
                backoffMultiplier: 2,
                commands: [{ kind: 'health', commandId: 'until-child' }]
            }).ok
        ).toBe(true);

        expect(
            validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
                kind: 'loop',
                commandId: 'until-schema-invalid-mode',
                until: 'always',
                commands: [{ kind: 'health', commandId: 'until-child' }]
            }).ok
        ).toBe(false);

        expect(
            validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
                kind: 'loop',
                commandId: 'until-schema-invalid-backoff',
                until: 'first-success',
                backoffMultiplier: 0,
                commands: [{ kind: 'health', commandId: 'until-child' }]
            }).ok
        ).toBe(false);
    });
});
