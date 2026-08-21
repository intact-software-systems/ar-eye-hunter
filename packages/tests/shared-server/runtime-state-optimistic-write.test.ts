import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS,
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry
} from '@shared-server/mod.ts';
import { describe, expect, it } from 'vitest';

describe('optimistic runtime-state writes', () => {
    it('uses the fixed three-attempt backoff contract', async () => {
        expect(DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS).toBe(3);
        expect(DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS).toEqual([0, 2, 8]);

        const delays: number[] = [];
        const sleep = async (delayMs: number): Promise<void> => {
            delays.push(delayMs);
        };

        await expect(waitForRuntimeStateWriteRetry(0, { sleep })).resolves.toBe(0);
        expect(delays).toEqual([]);
        await expect(waitForRuntimeStateWriteRetry(1, { sleep })).resolves.toBe(2);
        await expect(waitForRuntimeStateWriteRetry(2, { sleep })).resolves.toBe(8);
        expect(delays).toEqual([2, 8]);
    });

    it('rejects attempts outside the runtime budget even when typing is bypassed', async () => {
        await expect(
            waitForRuntimeStateWriteRetry(3 as 0)
        ).rejects.toThrow(/runtime state write attempt/u);
    });

    it('throws only when a conditional write conflicts', () => {
        const appliedWrite = { status: 'applied', revision: 0 } as const;
        const appliedDelete = { status: 'applied' } as const;

        expect(requireConditionalWrite(appliedWrite)).toBe(appliedWrite);
        expect(requireConditionalWrite(appliedDelete)).toBe(appliedDelete);
        expect(() => requireConditionalWrite({ status: 'conflict' })).toThrow(
            RuntimeStateWriteConflictError
        );
    });

    it('rejects invalid runtime results as invariant violations, not conflicts', () => {
        const invalidResults: readonly unknown[] = [
            { status: 'invalid' },
            {},
            null,
            undefined
        ];

        for (const result of invalidResults) {
            let thrown: unknown;
            try {
                requireConditionalWrite(result as never);
            }
            catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(TypeError);
            expect(thrown).not.toBeInstanceOf(RuntimeStateWriteConflictError);
        }
    });

    it('reports retry exhaustion with the last conflict as its cause', () => {
        const lastConflict = new RuntimeStateWriteConflictError();
        const error = new RuntimeStateRetryExhaustedError(lastConflict);

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('RuntimeStateRetryExhaustedError');
        expect(error.status).toBe(503);
        expect(error.code).toBe('runtime-state-write-conflict');
        expect(error.attempts).toBe(3);
        expect(error.cause).toBe(lastConflict);
    });
});
