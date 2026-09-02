import { describe, expect, it } from 'vitest';

import {
    validateRuntimeStateExpiredAuthority,
    validateRuntimeStateExpiredAuthorityIssues,
    validateRuntimeStateExpiredEntryIssues
} from '@shared-server/runtime-state/runtime-state-expired-entry.ts';

const expiredEntry = Object.freeze({
    key: 'expired-session',
    value: '{"state":"expired"}',
    expireAtTimestamp: 100,
    updatedTimestamp: '2026-01-01T00:00:00.000Z',
    revision: 2
});

describe('expired runtime-state validation', () => {
    it('collects independent entry issues without throwing or replacing the input', () => {
        const input = Object.freeze({
            key: 'different-session',
            value: 42,
            expireAtTimestamp: 101,
            updatedTimestamp: 'invalid timestamp',
            revision: -0,
            extra: true
        });
        const expected = [
            { path: 'entry', cause: new TypeError('Expired runtime state entry fields are invalid') },
            { path: 'entry.key', cause: new TypeError('Expired runtime state entry identity is invalid') },
            { path: 'entry.value', cause: new TypeError('Expired runtime state entry identity is invalid') },
            { path: 'entry.expireAtTimestamp', cause: new TypeError('Expired runtime state entry lifecycle is invalid') },
            { path: 'entry.revision', cause: new TypeError('Expired runtime state entry revision is invalid') },
            { path: 'entry.updatedTimestamp', cause: new TypeError('Expired runtime state entry timestamp is invalid') }
        ];

        expect(validateRuntimeStateExpiredEntryIssues(input, 'expired-session', 100)).toEqual(expected);
        expect(validateRuntimeStateExpiredEntryIssues(input, 'expired-session', 100)).toEqual(expected);
        expect(input).toEqual({
            key: 'different-session',
            value: 42,
            expireAtTimestamp: 101,
            updatedTimestamp: 'invalid timestamp',
            revision: -0,
            extra: true
        });
    });

    it('reports simultaneous live authority and malformed expired authority together', () => {
        const input = {
            live: { state: 'active' },
            expiredEntry: { ...expiredEntry, revision: -1 },
            expectedKey: 'expired-session',
            label: 'Session read'
        };

        expect(validateRuntimeStateExpiredAuthorityIssues(input)).toEqual([
            { path: 'expiredEntry', cause: new TypeError('Session read has live and expired authority') },
            { path: 'entry.revision', cause: new TypeError('Expired runtime state entry revision is invalid') }
        ]);
        expect(() => validateRuntimeStateExpiredAuthority(input))
            .toThrow(new TypeError('Session read has live and expired authority'));
    });

    it('rejects accessor-backed entry facts without executing caller behavior', () => {
        let propertyReads = 0;
        const input = {
            ...expiredEntry,
            get revision() {
                propertyReads += 1;
                throw new Error('Validation executed caller behavior');
            }
        };

        expect(validateRuntimeStateExpiredEntryIssues(input, 'expired-session')).toEqual([
            { path: 'entry.revision', cause: new TypeError('Expired runtime state entry revision is invalid') }
        ]);
        expect(propertyReads).toBe(0);
    });

    it('accepts expiry at the observed time without manufacturing a replacement value', () => {
        expect(validateRuntimeStateExpiredEntryIssues(expiredEntry, 'expired-session', 100)).toEqual([]);
        expect(validateRuntimeStateExpiredAuthorityIssues({
            live: null,
            expiredEntry,
            expectedKey: 'expired-session',
            label: 'Session read'
        })).toEqual([]);
        expect(validateRuntimeStateExpiredAuthorityIssues({
            live: { state: 'active' },
            expiredEntry: null,
            expectedKey: 'expired-session',
            label: 'Session read'
        })).toEqual([]);
    });

    it.each([
        { input: null, message: 'Expired runtime state entry must be an object' },
        { input: [], message: 'Expired runtime state entry must be an object' },
        { input: { ...expiredEntry, extra: true, revision: -1 }, message: 'Expired runtime state entry fields are invalid' },
        { input: { ...expiredEntry, key: 'different-session', revision: -1 }, message: 'Expired runtime state entry identity is invalid' },
        { input: { ...expiredEntry, expireAtTimestamp: 101, revision: -1 }, message: 'Expired runtime state entry lifecycle is invalid' },
        { input: { ...expiredEntry, revision: -1, updatedTimestamp: '' }, message: 'Expired runtime state entry revision is invalid' },
        { input: { ...expiredEntry, updatedTimestamp: '' }, message: 'Expired runtime state entry timestamp is invalid' }
    ])('preserves the first issue used by assertion boundaries: $message', ({ input, message }) => {
        const issues = validateRuntimeStateExpiredEntryIssues(input, 'expired-session', 100);
        expect(issues[0]?.cause).toEqual(new TypeError(message));
    });

    it.each([-0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'reports invalid revision %s without coercion',
        (revision) => {
            expect(validateRuntimeStateExpiredEntryIssues({ ...expiredEntry, revision }, 'expired-session'))
                .toEqual([
                    { path: 'entry.revision', cause: new TypeError('Expired runtime state entry revision is invalid') }
                ]);
        }
    );
});
