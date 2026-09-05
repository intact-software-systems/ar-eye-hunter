import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import {
    assertAuthMutationComputed,
    validateAuthMutation
} from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import { writeAuthMutation } from '@shared-server/rallar-system/auth/mutation/write-auth-mutation.ts';
import { describe, expect, it } from 'vitest';

const DIGEST = `sha256:${'1'.repeat(64)}`;

describe('auth mutation write purity', () => {
    it('serializes session rows during compute and only binds them during write', async () => {
        const command = {
            version: 1 as const,
            kind: 'issue-session' as const,
            requestId: 'request-1',
            capturedAtEpochMs: 1_000,
            authority: {
                kind: 'static-client' as const,
                clientId: 'client-1',
                normalizedUsername: 'alice'
            },
            session: {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessTokenDigest: DIGEST,
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 2_000
            }
        };
        const read = {
            kind: 'issue-session' as const,
            userByUsername: null,
            userByClientId: null,
            byToken: null,
            bySession: null,
            expiredByTokenEntry: null,
            expiredBySessionEntry: null
        };
        const facts = { kind: 'issue-session', serviceId: 'auth-test' } as const;
        const computed = computeAuthMutation({
            command,
            read,
            facts
        });
        const validationInput = { command, read, facts, computed };
        assertAuthMutationComputed(validationInput);
        expect(validateAuthMutation(validationInput)).toEqual([]);
        expect(computed.persistence.operations).toHaveLength(2);
        expect(() =>
            assertAuthMutationComputed({
                command,
                read,
                facts,
                computed: {
                    ...computed,
                    persistence: { operations: [], logoutOutbox: null }
                }
            })
        ).toThrow('Auth computed value differs');

        const originalStringify = JSON.stringify;
        JSON.stringify = () => {
            throw new Error('auth serialization must finish during compute');
        };
        try {
            await expect(writeAuthMutation(appliedSql(), computed)).resolves.toEqual(
                computed.result
            );
        }
        finally {
            JSON.stringify = originalStringify;
        }
    });
});

function appliedSql(): PSqlSql {
    const sql = (
        _stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ..._values: readonly PSqlParameter[]
    ): Promise<readonly Readonly<{ revision: number; }>[]> | object => Promise.resolve([{ revision: 0 }]);
    return sql as PSqlSql;
}
