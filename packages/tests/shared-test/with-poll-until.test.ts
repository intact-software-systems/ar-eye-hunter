import { describe, expect, it } from 'vitest';

import { withPollUntil } from '../../shared-test/black-box-runner/execution/with-poll-until.ts';

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function toAttempts(statuses: readonly string[]): () => Promise<{ status: string; }> {
    let index = 0;
    return () => {
        const status = statuses[Math.min(index, statuses.length - 1)];
        index += 1;
        return Promise.resolve({ status });
    };
}

describe('withPollUntil', () => {
    it('runs once and returns when the first attempt succeeds', async () => {
        const execute = toAttempts([SUCCESS]);
        const status: any = await withPollUntil({ request: { poll: { backoffMs: 0 } }, execute });

        expect(status.status).toBe(SUCCESS);
        expect(status.pollAttempts).toBe(1);
        expect(status.pollExhausted).toBe(false);
    });

    it('retries until the condition holds', async () => {
        const execute = toAttempts([FAILURE, FAILURE, SUCCESS]);
        const status: any = await withPollUntil({
            request: { poll: { maxAttempts: 5, backoffMs: 0 } },
            execute
        });

        expect(status.status).toBe(SUCCESS);
        expect(status.pollAttempts).toBe(3);
    });

    // Exhaustion carries the last attempt's status rather than inventing one,
    // so the failure a recipe reads is the real one.
    it('returns the last failing status when attempts are exhausted', async () => {
        const execute = toAttempts([FAILURE]);
        const status: any = await withPollUntil({
            request: { poll: { maxAttempts: 3, backoffMs: 0 } },
            execute
        });

        expect(status.status).toBe(FAILURE);
        expect(status.pollAttempts).toBe(3);
        expect(status.pollExhausted).toBe(true);
    });

    it('executes exactly once when no poll policy is declared', async () => {
        let calls = 0;
        const status: any = await withPollUntil({
            request: {},
            execute: () => {
                calls += 1;
                return Promise.resolve({ status: FAILURE });
            }
        });

        expect(calls).toBe(1);
        expect(status.status).toBe(FAILURE);
        expect(status.pollAttempts).toBeUndefined();
    });

    // stableForMs is what separates "converged" from "passed through the right
    // value on its way somewhere else".
    it('requires the condition to hold for stableForMs before returning', async () => {
        let calls = 0;
        const status: any = await withPollUntil({
            request: { poll: { maxAttempts: 20, backoffMs: 5, backoffMultiplier: 1, stableForMs: 30 } },
            execute: () => {
                calls += 1;
                return Promise.resolve({ status: SUCCESS });
            }
        });

        expect(status.status).toBe(SUCCESS);
        expect(calls).toBeGreaterThan(1);
    });

    it('restarts the stability window when the condition lapses', async () => {
        const statuses = [SUCCESS, FAILURE, SUCCESS, SUCCESS, SUCCESS, SUCCESS, SUCCESS, SUCCESS];
        const execute = toAttempts(statuses);
        const status: any = await withPollUntil({
            request: { poll: { maxAttempts: 20, backoffMs: 5, backoffMultiplier: 1, stableForMs: 20 } },
            execute
        });

        expect(status.status).toBe(SUCCESS);
        expect(status.pollAttempts).toBeGreaterThan(2);
    });

    it('fails when the condition never holds long enough', async () => {
        const execute = toAttempts([SUCCESS, FAILURE]);
        const status: any = await withPollUntil({
            request: { poll: { maxAttempts: 4, backoffMs: 0, stableForMs: 10_000 } },
            execute
        });

        expect(status.status).toBe(FAILURE);
        expect(status.pollExhausted).toBe(true);
    });

    // A policy that parses to zero attempts or to NaN would otherwise skip the
    // loop and return a result carrying no `status` at all — a step that never
    // ran and never failed.
    it('fails a policy that names zero attempts instead of skipping the step', async () => {
        let calls = 0;
        const status = await withPollUntil({
            request: { poll: { maxAttempts: 0 } },
            execute: () => {
                calls += 1;
                return Promise.resolve({ status: 'SUCCESS' });
            }
        });

        expect(calls).toBe(1);
        expect(status.status).toBe('FAILURE');
        expect(status.result).toContain('at least one attempt');
    });

    it('fails a policy whose bounds do not parse', async () => {
        const status = await withPollUntil({
            request: { poll: { backoffMultiplier: '2x' } },
            execute: () => Promise.resolve({ status: 'SUCCESS' })
        });

        expect(status.status).toBe('FAILURE');
        expect(status.result).toContain('finite');
    });

    // `action: 'poll-until'` predates the block and has to keep polling with
    // the defaults, or a step that reads as supported quietly runs once.
    it('polls an action-only poll-until request with the defaults', async () => {
        let calls = 0;
        await withPollUntil({
            request: { action: 'poll-until' },
            execute: () => {
                calls += 1;
                return Promise.resolve(calls >= 3 ? { status: 'SUCCESS' } : { status: 'FAILURE' });
            }
        });

        expect(calls).toBe(3);
    });
});
