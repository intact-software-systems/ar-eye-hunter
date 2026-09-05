import {
    validateBrowserALRuntimeCleanup,
    type BrowserALRuntimeCleanupComputed,
    type BrowserALRuntimeCleanupRead,
    type BrowserALRuntimeCleanupValidationIssue,
    type BrowserALRuntimeDeletionPolicy
} from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { AL_ADMISSION_REVISION_KEY } from '@shared/alm/open-indexed-db-admission-database.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';

const read: BrowserALRuntimeCleanupRead = {
    revision: 4,
    rows: [
        {
            key: 'browser:expired',
            expireAtTimestamp: 10,
            writeToken: 'expired-token'
        },
        {
            key: 'browser:fresh',
            expireAtTimestamp: 30,
            writeToken: 'fresh-token'
        }
    ]
};

const deletionPolicy: BrowserALRuntimeDeletionPolicy = {
    kind: 'expired',
    nowMs: 20
};

const validComputed: BrowserALRuntimeCleanupComputed = {
    mutations: [{
        kind: 'remove-if-write-token',
        key: 'browser:expired',
        expectedWriteToken: 'expired-token'
    }],
    revisionWrite: {
        key: AL_ADMISSION_REVISION_KEY,
        value: 5,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    }
};

describe('Browser AL runtime cleanup validation', () => {
    it('accepts one guarded deletion for every eligible row', () => {
        expect(validateBrowserALRuntimeCleanup(read, deletionPolicy, validComputed)).toEqual([]);
    });

    it.each(
        [
            {
                label: 'a missing eligible deletion',
                computed: { ...validComputed, mutations: [] },
                code: 'missing-mutation'
            },
            {
                label: 'an ineligible deletion',
                computed: {
                    ...validComputed,
                    mutations: [{
                        kind: 'remove-if-write-token',
                        key: 'browser:fresh',
                        expectedWriteToken: 'fresh-token'
                    }]
                },
                code: 'unexpected-mutation'
            },
            {
                label: 'a stale write token',
                computed: {
                    ...validComputed,
                    mutations: [{
                        kind: 'remove-if-write-token',
                        key: 'browser:expired',
                        expectedWriteToken: 'stale-token'
                    }]
                },
                code: 'write-token-mismatch'
            },
            {
                label: 'a duplicate deletion',
                computed: {
                    ...validComputed,
                    mutations: [
                        ...validComputed.mutations,
                        ...validComputed.mutations
                    ]
                },
                code: 'duplicate-mutation'
            },
            {
                label: 'a non-guarded mutation',
                computed: {
                    ...validComputed,
                    mutations: [{
                        kind: 'remove',
                        key: 'browser:expired'
                    }]
                },
                code: 'unexpected-mutation-kind'
            },
            {
                label: 'a mismatched revision write',
                computed: {
                    ...validComputed,
                    revisionWrite: {
                        ...validComputed.revisionWrite,
                        value: 6
                    }
                },
                code: 'revision-write-mismatch'
            }
        ] satisfies ReadonlyArray<{
            label: string;
            computed: BrowserALRuntimeCleanupComputed;
            code: BrowserALRuntimeCleanupValidationIssue['code'];
        }>
    )('rejects $label', ({ computed, code }) => {
        const issues = validateBrowserALRuntimeCleanup(read, deletionPolicy, computed);

        expect(issues.map((issue) => issue.code)).toContain(code);
    });

    it('reports an eligible row missing when its mutation is not guarded', () => {
        const issues = validateBrowserALRuntimeCleanup(read, deletionPolicy, {
            ...validComputed,
            mutations: [{
                kind: 'remove',
                key: 'browser:expired'
            }]
        });

        expect(issues.map((issue) => issue.code)).toEqual([
            'unexpected-mutation-kind',
            'missing-mutation'
        ]);
    });
});
