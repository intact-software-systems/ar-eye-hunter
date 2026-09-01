import { PSqlAdmissionMutationCollector } from '@shared-server/al-runtime/postgres/p-sql-admission-mutation-collector.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { captureAuthMutationFacts } from '@shared-server/rallar-system/auth/mutation/read/capture-auth-mutation-facts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import assert from 'node:assert/strict';
import { FUTURE_MS, readPGliteDatabaseEpochMs, withPGliteSql } from './pglite-auth-test-harness.ts';

Deno.test('PGlite auth and AL production writers roll back sibling conditional mutations', async () => {
    await withPGliteSql(async (sql) => {
        const runtime = new PSqlRuntimeStateRepository(sql);
        const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
        const credentialIssuer = createHmacAuthCredentialIssuer(
            'pglite-rollback-secret-0123456789abcdef'
        );
        const auth = createAuthMutationService({
            runtimeRepository: runtime,
            serviceId: 'pglite-auth-rollback'
        });
        const registration = {
            version: 1,
            kind: 'register-user',
            requestId: 'register-rollback',
            capturedAtEpochMs: nowEpochMs,
            user: {
                clientId: 'register-client',
                username: 'rollback-user',
                normalizedUsername: 'rollback-user',
                displayName: null,
                passwordHash: 'password-hash',
                passwordSalt: 'password-salt',
                passwordAlgorithm: 'pbkdf2-sha256',
                passwordIterations: 120_000,
                roles: ['member'],
                status: 'active',
                createdAtEpochMs: nowEpochMs,
                updatedAtEpochMs: nowEpochMs
            }
        } as const;
        const registrationRead = await auth.read(registration);
        const registrationComputed = auth.compute(
            registration,
            registrationRead,
            await captureAuthMutationFacts(registration, credentialIssuer)
        );
        auth.validate(registration, registrationRead, registrationComputed);
        await runtime.insertIfAbsent(
            'auth-users:by-client-id',
            'client=register-client',
            JSON.stringify({ collision: true }),
            FUTURE_MS
        );
        await assert.rejects(
            () => sql.begin((transaction) => auth.write(transaction, registrationComputed)),
            RuntimeStateWriteConflictError
        );
        assert.equal(
            await runtime.findEntry('auth-users:by-username', 'username=rollback-user'),
            undefined
        );

        const agentRequestId = 'agent-batch-rollback';
        const agentAuthority = {
            clientId: 'agent-client',
            username: 'alice',
            sessionId: 'agent-authority-session',
            accessToken: await credentialIssuer.issueAccessToken('agent-authority-session'),
            issuedAtEpochMs: nowEpochMs - 1,
            expiresAtEpochMs: nowEpochMs + 60_000
        };
        await new AuthSessionRepository(runtime).putSession(agentAuthority);
        const agentFacts = await Promise.all([
            { agentId: 'rollback-a', sessionId: 'rollback-session-a' },
            { agentId: 'rollback-b', sessionId: 'rollback-session-b' }
        ].map(async ({ agentId, sessionId }) => ({
            agentId,
            sessionId,
            accessTokenDigest: await hashAuthSecret(
                await credentialIssuer.issueAccessToken(sessionId)
            ),
            ticketDigest: await hashAuthSecret(
                await credentialIssuer.issueAgentTicket(agentRequestId, agentId, sessionId)
            ),
            clientId: 'agent-client',
            username: 'alice',
            issuedAtEpochMs: nowEpochMs,
            sessionExpiresAtEpochMs: nowEpochMs + 60_000,
            ticketExpiresAtEpochMs: nowEpochMs + 30_000
        })));
        const agentCommand = {
            version: 1,
            kind: 'issue-agent-tickets',
            requestId: agentRequestId,
            capturedAtEpochMs: nowEpochMs,
            authority: {
                clientId: agentAuthority.clientId,
                username: agentAuthority.username,
                sessionId: agentAuthority.sessionId,
                accessTokenDigest: await hashAuthSecret(agentAuthority.accessToken),
                issuedAtEpochMs: agentAuthority.issuedAtEpochMs,
                expiresAtEpochMs: agentAuthority.expiresAtEpochMs
            },
            tickets: agentFacts
        } as const;
        const agentRead = await auth.read(agentCommand);
        const agentComputed = auth.compute(
            agentCommand,
            agentRead,
            await captureAuthMutationFacts(agentCommand, credentialIssuer)
        );
        auth.validate(agentCommand, agentRead, agentComputed);
        await runtime.insertIfAbsent(
            'auth-sessions:by-session',
            'session=rollback-session-b',
            JSON.stringify({ collision: true }),
            FUTURE_MS
        );
        await assert.rejects(
            () => sql.begin((transaction) => auth.write(transaction, agentComputed)),
            RuntimeStateWriteConflictError
        );
        assert.equal(
            await runtime.findEntry('auth-sessions:by-session', 'session=rollback-session-a'),
            undefined
        );
        assert.equal(
            await runtime.findEntry(
                'auth-sessions:agent-session-tickets',
                `ticket-digest=${agentFacts[0].ticketDigest}`
            ),
            undefined
        );
        assert.equal(
            await runtime.findEntry(
                'auth-sessions:by-token',
                `token-digest=${agentFacts[1].accessTokenDigest}`
            ),
            undefined
        );

        const admission = new PSqlAdmissionMutationCollector(
            runtime,
            'al-admission-rollback',
            () => nowEpochMs
        );
        await runtime.insertIfAbsent(
            'al-admission-rollback',
            'sibling-b',
            JSON.stringify({ collision: true }),
            FUTURE_MS
        );
        await assert.rejects(
            () =>
                admission.apply([
                    {
                        kind: 'insert',
                        key: 'sibling-a',
                        expected: 'absent',
                        value: JSON.stringify({ value: 'a' }),
                        expireAtEpochMs: FUTURE_MS
                    },
                    {
                        kind: 'insert',
                        key: 'sibling-b',
                        expected: 'absent',
                        value: JSON.stringify({ value: 'b' }),
                        expireAtEpochMs: FUTURE_MS
                    }
                ]),
            RuntimeStateWriteConflictError
        );
        assert.equal(
            await runtime.findEntry('al-admission-rollback', 'sibling-a'),
            undefined
        );
    });
});
