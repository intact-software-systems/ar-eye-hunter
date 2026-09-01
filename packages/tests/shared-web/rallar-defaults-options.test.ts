import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { shouldRetryRallarOperation, toRallarCommandOptions, toRallarWorkflowPolicies } from '@shared-web/browser/rallar-operation-options.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Rallar defaults and operation options', () => {
    it('builds command and workflow policies from operation options', () => {
        const signal = new AbortController().signal;
        const explicitRetry = vi.fn(() => false);

        expect(toRallarCommandOptions({ signal, timeoutMs: 250 })).toEqual({
            signal,
            timeoutMs: 250
        });
        const retryOptions = toRallarCommandOptions({ shouldRetry: explicitRetry });
        const failure = new Error('retry decision');
        expect(retryOptions.shouldRetry?.(failure, 2)).toBe(false);
        expect(explicitRetry).toHaveBeenCalledWith(failure, 2);
        expect(toRallarCommandOptions({ maxAttempts: 3 })).toEqual({
            maxAttempts: 3,
            shouldRetry: shouldRetryRallarOperation
        });
        expect(toRallarWorkflowPolicies({})).toEqual({});
        expect(toRallarWorkflowPolicies({ maxAttempts: 3 })).toEqual({
            command: {
                maxAttempts: 3,
                shouldRetry: shouldRetryRallarOperation
            }
        });
    });

    it('retries transient HTTP status failures by default', () => {
        expect(shouldRetryRallarOperation(apiHttpError(429))).toBe(true);
        expect(shouldRetryRallarOperation(apiHttpError(500))).toBe(true);
        expect(shouldRetryRallarOperation(apiHttpError(503))).toBe(true);
        expect(shouldRetryRallarOperation(apiHttpError(400))).toBe(false);
        expect(shouldRetryRallarOperation(apiHttpError(409, canonicalConflictBody()))).toBe(false);
        expect(shouldRetryRallarOperation(new Error('network'))).toBe(true);
    });
});

function apiHttpError(status: number, bodyText = ''): ApiHttpError {
    return new ApiHttpError('POST', '/api/state/mutation', status, bodyText);
}

function canonicalConflictBody(): string {
    return JSON.stringify({
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code: 'idempotency-conflict',
        status: 409,
        message: 'Request identity was already used for different semantic intent',
        issues: null,
        denial: null,
        retry: null
    });
}
