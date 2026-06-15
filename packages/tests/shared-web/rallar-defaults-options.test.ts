import { describe, expect, it, vi } from 'vitest';
import {
    shouldRetryRallarOperation,
    toRallarCommandOptions,
    toRallarWorkflowPolicies,
} from '@shared-web/browser/rallar-operation-options.ts';

describe('Rallar defaults and operation options', () => {
    it('builds command and workflow policies from operation options', () => {
        const signal = new AbortController().signal;
        const explicitRetry = vi.fn(() => false);

        expect(toRallarCommandOptions({ signal, timeoutMs: 250 })).toEqual({
            signal,
            timeoutMs: 250,
        });
        expect(toRallarCommandOptions({ shouldRetry: explicitRetry })).toEqual({
            shouldRetry: explicitRetry,
        });
        expect(toRallarCommandOptions({ maxAttempts: 3 })).toEqual({
            maxAttempts: 3,
            shouldRetry: shouldRetryRallarOperation,
        });
        expect(toRallarWorkflowPolicies({})).toEqual({});
        expect(toRallarWorkflowPolicies({ maxAttempts: 3 })).toEqual({
            command: {
                maxAttempts: 3,
                shouldRetry: shouldRetryRallarOperation,
            },
        });
    });

    it('retries transient HTTP status failures by default', () => {
        expect(shouldRetryRallarOperation({ status: 429 })).toBe(true);
        expect(shouldRetryRallarOperation({ status: 500 })).toBe(true);
        expect(shouldRetryRallarOperation({ status: 503 })).toBe(true);
        expect(shouldRetryRallarOperation({ status: 400 })).toBe(false);
        expect(shouldRetryRallarOperation({ status: Number.NaN })).toBe(true);
        expect(shouldRetryRallarOperation(new Error('network'))).toBe(true);
    });
});
