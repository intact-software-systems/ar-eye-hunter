import { describe, expect, it } from 'vitest';

import {
    toOrderedSendFailureLines,
    toOrderedSendThrownError
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/to-ordered-send-thrown-error.ts';

class NamedError extends Error {
    constructor(name: string, message: string) {
        super(message);
        this.name = name;
    }
}

describe('toOrderedSendThrownError', () => {
    it('keeps the name and the message of an error that names nothing to hide', () => {
        const error = new NamedError(
            'ALAdmissionCorruptionError',
            'Buffered inbound ordering slot lost its canonical message'
        );

        expect(toOrderedSendThrownError(error)).toEqual({
            errorName: 'ALAdmissionCorruptionError',
            errorMessage: 'Buffered inbound ordering slot lost its canonical message'
        });
    });

    it('removes a database URL from a message, with its user, its password, its host and its database', () => {
        const error = new Error('connect to postgres://user:pw@host/db failed; retry postgresql://app:s3cr3t@db.internal:5432/run?sslmode=require later');

        expect(toOrderedSendThrownError(error).errorMessage)
            .toBe('connect to <url removed> failed; retry <url removed> later');
    });

    it('removes the quoted input a URL parser reports, and a credential a URL lost its scheme around', () => {
        const invalidUrl = new NamedError('TypeError', 'Invalid URL input: "not a url s3cr3t", code: "ERR_INVALID_URL"');
        const withoutScheme = new Error('cannot parse postgres//user:pw@host/db as a URL');

        expect(toOrderedSendThrownError(invalidUrl)).toEqual({
            errorName: 'TypeError',
            errorMessage: 'Invalid URL input: <removed>, code: "ERR_INVALID_URL"'
        });
        expect(toOrderedSendThrownError(withoutScheme).errorMessage).toBe('cannot parse <url removed> as a URL');
    });

    it('bounds a message at 240 characters, the last of them an ellipsis, and removes a URL before it cuts', () => {
        const long = new Error(`${'a'.repeat(230)} postgres://user:pw@host/db ${'b'.repeat(300)}`);

        const { errorMessage } = toOrderedSendThrownError(long);

        expect(errorMessage).toBe(`${'a'.repeat(230)} <url rem…`);
        expect(errorMessage).toHaveLength(240);
        expect(toOrderedSendThrownError(new Error('c'.repeat(240))).errorMessage).toBe('c'.repeat(240));
    });

    it('bounds a name at 80 characters and removes a URL from it too', () => {
        expect(toOrderedSendThrownError(new NamedError('n'.repeat(81), 'failed')).errorName).toBe(`${'n'.repeat(79)}…`);
        expect(toOrderedSendThrownError(new NamedError('postgres://user:pw@host/db', 'failed')).errorName)
            .toBe('<url removed>');
    });
});

describe('toOrderedSendFailureLines', () => {
    it('prints one line of name and message for an error', () => {
        expect(toOrderedSendFailureLines(new NamedError('PostgresError', 'role "nouser" does not exist')))
            .toEqual(['PostgresError: role "nouser" does not exist']);
    });

    it('prints an aggregate and then each error it holds, and no URL of any of them', () => {
        const aggregate = new AggregateError(
            [new Error('connect postgres://user:pw@host/db refused'), 'a thrown text'],
            'The ordered-send cell failed to stop its instances.'
        );

        expect(toOrderedSendFailureLines(aggregate)).toEqual([
            'AggregateError: The ordered-send cell failed to stop its instances.',
            'Error: connect <url removed> refused',
            'Error: a thrown text'
        ]);
    });
});
