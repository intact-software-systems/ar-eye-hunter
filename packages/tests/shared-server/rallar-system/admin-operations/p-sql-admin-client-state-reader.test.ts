import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlAdminClientStateReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-client-state-reader.ts';

const sessionKey = 'app=app:ws=workspace:principal=alice:instance=browser:session=session-1';

interface AdminClientSessionFixtureInput {
    readonly sessionId: string;
    readonly expiresAtEpochMs: number | string;
}

interface AdminClientSessionFixture {
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly sessionId: string;
    readonly status: 'active';
    readonly disconnectedAtEpochMs: null;
    readonly expiresAtEpochMs: number | string;
}

describe('PostgreSQL admin client-state current session summaries', () => {
    it('counts only current numeric session expiry values', () => {
        const reader = new PSqlAdminClientStateReader(createUnusedDatabase(), {
            nowEpochMs: () => 1_000
        });
        const facts: PSqlAdminClientStateReader.ScopedFacts = {
            totalPrincipals: 1,
            sessionRows: [
                {
                    store_key: sessionKey,
                    store_value: JSON.stringify(
                        activeSession({ sessionId: 'session-1', expiresAtEpochMs: 2_000 })
                    )
                },
                {
                    store_key: sessionKey.replace('session-1', 'session-2'),
                    store_value: JSON.stringify(
                        activeSession({ sessionId: 'session-2', expiresAtEpochMs: '2000' })
                    )
                }
            ]
        };

        expect(reader.summarizeScoped(facts, 1_000)).toEqual({
            totalPrincipals: 1,
            onlinePrincipals: 1,
            activeSessions: 1
        });
    });
});

function activeSession(input: AdminClientSessionFixtureInput): AdminClientSessionFixture {
    return {
        applicationId: 'app',
        workspaceId: 'workspace',
        principalId: 'alice',
        clientInstanceId: 'browser',
        sessionId: input.sessionId,
        status: 'active',
        disconnectedAtEpochMs: null,
        expiresAtEpochMs: input.expiresAtEpochMs
    };
}

function createUnusedDatabase(): PSqlSql {
    const database: PSqlSql = Object.assign(
        <T>(
            _stringsOrValues: TemplateStringsArray | Parameters<PSqlSql>[0],
            ..._values: Parameters<PSqlSql>[0]
        ): Promise<T> => Promise.reject(new Error('Unexpected SQL execution in admin summary test')),
        {
            begin: <T>(_run: (sql: PSqlSql) => Promise<T>): Promise<T> => Promise.reject(new Error('Unexpected transaction in admin summary test'))
        }
    );
    return database;
}
