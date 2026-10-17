import { describe, expect, it } from 'vitest';

import { toErrorSummary } from '@shared/resilience/to-error.ts';

class DetailedError extends Error {
    readonly code = 'detailed';
    readonly inner: Error;

    constructor(message: string, inner: Error, cause?: Error) {
        super(message, { cause });
        this.name = 'DetailedError';
        this.inner = inner;
    }
}

describe('error summary', () => {
    it('summarizes an error held in a property instead of carrying its stack', () => {
        const inner = new TypeError('inner failure');
        const error = new DetailedError('outer failure', inner, new Error('root cause'));

        const summary = toErrorSummary(error);

        expect(summary).toEqual({
            name: 'DetailedError',
            message: 'outer failure',
            properties: {
                code: 'detailed',
                inner: { name: 'TypeError', message: 'inner failure', properties: {}, cause: null }
            },
            cause: { name: 'Error', message: 'root cause', properties: {}, cause: null }
        });
        expect(JSON.stringify(summary)).not.toContain('at ');
    });

    it('summarizes an error that holds itself only once', () => {
        const error = new DetailedError('loop', new Error('placeholder'));
        Object.assign(error, { inner: error });

        expect(toErrorSummary(error).properties.inner).toEqual({ name: 'DetailedError', message: 'loop', properties: {}, cause: null });
    });
});
