import { decodeAppInboxFailure, decodePersistedAppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure-decoding.ts';
import { describe, expect, it } from 'vitest';

describe('AppInbox durable failure decoding', () => {
    it('accepts the exact current JSON-safe failure contract', () => {
        const failure = {
            type: 'app-inbox-failure',
            code: 'group-policy-denied',
            status: 403,
            message: 'The mutation is forbidden',
            issues: null,
            denial: {
                code: 'group-policy-denied',
                message: 'The mutation is forbidden',
                details: { groupId: 'group-1' }
            },
            retry: null
        } as const;

        expect(decodeAppInboxFailure(failure)).toEqual(failure);
    });

    it('rejects predecessor failure versions instead of decoding them', () => {
        expect(() =>
            decodeAppInboxFailure({
                type: 'app-inbox-failure',
                version: 'canonical.v2',
                code: 'group-policy-denied',
                status: 403,
                message: 'The mutation is forbidden',
                issues: null,
                denial: null,
                retry: null
            })
        ).toThrow('AppInbox failure fields are invalid');
    });

    it('reports malformed persisted rows through the current corruption failure', () => {
        expect(decodePersistedAppInboxFailure('{"version":"retry-exhausted.v1"}')).toEqual({
            type: 'app-inbox-failure',
            code: 'app-inbox-persisted-failure-corrupt',
            status: 500,
            message: 'Persisted AppInbox failure is corrupt',
            issues: null,
            denial: null,
            retry: null
        });
    });

    it('rejects non-JSON failure details at the durable boundary', () => {
        expect(() =>
            decodeAppInboxFailure({
                type: 'app-inbox-failure',
                code: 'group-policy-denied',
                status: 403,
                message: 'The mutation is forbidden',
                issues: null,
                denial: {
                    code: 'group-policy-denied',
                    message: 'The mutation is forbidden',
                    details: { amount: 1n }
                },
                retry: null
            })
        ).toThrow('AppInbox failure denial details must be JSON-safe');
    });
});
