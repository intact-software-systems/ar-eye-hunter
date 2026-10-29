import { describe, expect, it } from 'vitest';

import {
    AL_PUBLICATION_POLICY_LIMITS,
    decodeALPublicationPolicy,
    validateALPublicationPolicy
} from '@shared/al-contracts/publication/al-publication-policy.ts';

const VALID = { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } };

function toDecodedPaths(value: object): readonly string[] | undefined {
    return decodeALPublicationPolicy(value).left?.map((issue) => issue.path);
}

describe('validateALPublicationPolicy (D466)', () => {
    it('accepts a policy whose four fields are positive safe integers within the limits', () => {
        expect(validateALPublicationPolicy(VALID)).toEqual([]);
    });

    it('accepts every field at its limit', () => {
        expect(validateALPublicationPolicy({
            cadenceMs: AL_PUBLICATION_POLICY_LIMITS.maxCadenceMs,
            retainNewest: AL_PUBLICATION_POLICY_LIMITS.maxRetainNewest,
            drain: {
                messages: AL_PUBLICATION_POLICY_LIMITS.maxDrainMessages,
                bytes: AL_PUBLICATION_POLICY_LIMITS.maxDrainBytes
            }
        }))
            .toEqual([]);
    });

    it('names the limits the contract fixes', () => {
        expect(AL_PUBLICATION_POLICY_LIMITS).toEqual({
            maxCadenceMs: 60_000,
            maxRetainNewest: 64,
            maxDrainMessages: 64,
            maxDrainBytes: 4 * 1024 * 1024
        });
    });

    it('returns every range issue with its field code', () => {
        const issues = validateALPublicationPolicy({ cadenceMs: 0, retainNewest: 65, drain: { messages: 0, bytes: 0.5 } });

        expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
            ['$.publication.cadenceMs', 'invalid-cadenceMs'],
            ['$.publication.retainNewest', 'invalid-retainNewest'],
            ['$.publication.drain.messages', 'invalid-drain-messages'],
            ['$.publication.drain.bytes', 'invalid-drain-bytes']
        ]);
    });
});

describe('decodeALPublicationPolicy (D466)', () => {
    it('returns the policy with exactly its four fields copied', () => {
        const decoded = decodeALPublicationPolicy({ ...VALID, extra: 'ignored', drain: { ...VALID.drain, extra: 1 } });

        expect(decoded.left).toBeUndefined();
        expect(decoded.right).toEqual(VALID);
        expect(Object.keys(decoded.right ?? {})).toEqual(['cadenceMs', 'retainNewest', 'drain']);
        expect(Object.keys(decoded.right?.drain ?? {})).toEqual(['messages', 'bytes']);
    });

    it.each([null, undefined, 'policy', 7, []])('refuses %j as a non-object at $.publication', (value) => {
        expect(decodeALPublicationPolicy(value).left).toEqual([
            { path: '$.publication', code: 'invalid-publication', message: expect.any(String) }
        ]);
    });

    it('returns all four field issues for an empty object', () => {
        const issues = decodeALPublicationPolicy({}).left;

        expect(issues?.map((issue) => [issue.path, issue.code])).toEqual([
            ['$.publication.cadenceMs', 'invalid-cadenceMs'],
            ['$.publication.retainNewest', 'invalid-retainNewest'],
            ['$.publication.drain.messages', 'invalid-drain-messages'],
            ['$.publication.drain.bytes', 'invalid-drain-bytes']
        ]);
    });

    it('refuses a missing drain object at both drain paths', () => {
        expect(toDecodedPaths({ cadenceMs: 100, retainNewest: 1 })).toEqual([
            '$.publication.drain.messages',
            '$.publication.drain.bytes'
        ]);
    });

    it.each([
        ['cadenceMs: 0', { ...VALID, cadenceMs: 0 }, '$.publication.cadenceMs'],
        ['cadenceMs: -1', { ...VALID, cadenceMs: -1 }, '$.publication.cadenceMs'],
        ['cadenceMs above the limit', { ...VALID, cadenceMs: 60_001 }, '$.publication.cadenceMs'],
        ['retainNewest: 1.5', { ...VALID, retainNewest: 1.5 }, '$.publication.retainNewest'],
        ['retainNewest above the limit', { ...VALID, retainNewest: 65 }, '$.publication.retainNewest'],
        ['retainNewest: NaN', { ...VALID, retainNewest: Number.NaN }, '$.publication.retainNewest'],
        [
            'drain.messages above the limit',
            { ...VALID, drain: { messages: 65, bytes: 1 } },
            '$.publication.drain.messages'
        ],
        [
            'drain.bytes of 4 MiB + 1',
            { ...VALID, drain: { messages: 8, bytes: 4 * 1024 * 1024 + 1 } },
            '$.publication.drain.bytes'
        ],
        ['a string cadence', { ...VALID, cadenceMs: '100' }, '$.publication.cadenceMs'],
        [
            'an unsafe integer',
            { ...VALID, drain: { messages: 8, bytes: Number.MAX_SAFE_INTEGER + 1 } },
            '$.publication.drain.bytes'
        ]
    ])('refuses %s with one issue at its own path', (_name, value, path) => {
        expect(toDecodedPaths(value)).toEqual([path]);
    });
});
