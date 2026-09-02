import { describe, expect, it } from 'vitest';

import type { AuthMutationCommand, AuthMutationRead, AuthSessionEntries } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';

const session = {
    clientId: 'client-1',
    username: 'alice',
    sessionId: 'session-1',
    accessTokenDigest: 'token-1',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000
} as const;
const ticket = {
    clientId: session.clientId,
    sessionId: session.sessionId,
    accessTokenDigest: session.accessTokenDigest,
    ticketDigest: 'ticket-1',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 1_500
} as const;
const commandIdentity = { version: 1, requestId: 'revision-request', capturedAtEpochMs: 1_000 } as const;
const emptySessions: AuthSessionEntries = {
    byToken: null,
    bySession: null,
    expiredByTokenEntry: null,
    expiredBySessionEntry: null
};

interface AuthRevisionCase {
    readonly label: string;
    readonly command: AuthMutationCommand;
    readonly read: AuthMutationRead;
}

describe('auth mutation storage revisions', () => {
    it.each(
        [-1, -0, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap((revision) =>
            createDeletionCases(revision).map((testCase) => ({ ...testCase, revision }))
        )
    )(
        'rejects invalid delete revision $revision for $label in original read facts',
        (testCase) => {
            const computed = computeCase(testCase);
            expect(computed.outcome).toBe('write');
            expect(() => validateAuthMutation(testCase.command, testCase.read, computed)).toThrow(
                new Error(`Invalid runtime state expected revision: ${testCase.revision}`)
            );
        }
    );

    it.each(createReplacementCases(Number.MAX_SAFE_INTEGER))(
        'rejects overflow before replacing $label',
        (testCase) => {
            const computed = computeCase(testCase);
            expect(computed.outcome).toBe('write');
            expect(() => validateAuthMutation(testCase.command, testCase.read, computed)).toThrow(
                new Error(`Invalid runtime state upsert expected revision: ${Number.MAX_SAFE_INTEGER}`)
            );
        }
    );

    it('allows the largest update and delete revisions without restricting readonly authority', () => {
        const cases = [
            ...createReplacementCases(Number.MAX_SAFE_INTEGER - 1),
            ...createDeletionCases(Number.MAX_SAFE_INTEGER)
        ];
        for (const testCase of cases) {
            expect(
                () => validateAuthMutation(testCase.command, testCase.read, computeCase(testCase)),
                testCase.label
            ).not.toThrow();
        }
    });

    it('does not require increment capacity for a matching session replay or absent logout', () => {
        const command: AuthMutationCommand = {
            ...commandIdentity,
            kind: 'issue-session',
            authority: { kind: 'static-client', clientId: session.clientId, normalizedUsername: 'alice' },
            session
        };
        const read: AuthMutationRead = {
            kind: 'issue-session',
            userByUsername: null,
            userByClientId: null,
            ...createLiveSessions()
        };
        const replay = computeCase({ label: 'replay', command, read });
        expect(replay.outcome).toBe('replay');
        expect(() => validateAuthMutation(command, read, replay)).not.toThrow();
        const logoutCommand: AuthMutationCommand = { ...commandIdentity, kind: 'logout-session', expected: session };
        const logoutRead: AuthMutationRead = { kind: 'logout-session', ...emptySessions };
        const noOp = computeCase({ label: 'no-op', command: logoutCommand, read: logoutRead });
        expect(noOp.outcome).toBe('no-op');
        expect(() => validateAuthMutation(logoutCommand, logoutRead, noOp)).not.toThrow();
    });
});

function createDeletionCases(revision: number): readonly AuthRevisionCase[] {
    return [
        ...(['bySession', 'byToken'] as const).map((index): AuthRevisionCase => ({
            label: `logout ${index}`,
            command: { ...commandIdentity, kind: 'logout-session', expected: session },
            read: {
                kind: 'logout-session',
                ...createLiveSessions(),
                [index]: createLiveEntry(session, revision)
            }
        })),
        {
            label: 'consume websocket ticket',
            command: {
                ...commandIdentity,
                kind: 'consume-ws-ticket',
                ticketDigest: ticket.ticketDigest,
                expectedSessionId: session.sessionId
            },
            read: {
                kind: 'consume-ws-ticket',
                ticket: createLiveEntry(ticket, revision),
                session: createLiveEntry(session, Number.MAX_SAFE_INTEGER)
            }
        },
        {
            label: 'consume agent ticket',
            command: { ...commandIdentity, kind: 'consume-agent-ticket', ticketDigest: ticket.ticketDigest },
            read: {
                kind: 'consume-agent-ticket',
                ticket: createLiveEntry({ ...ticket, agentId: 'agent-1' }, revision),
                session: createLiveEntry(session, Number.MAX_SAFE_INTEGER)
            }
        }
    ];
}

function createReplacementCases(revision: number): readonly AuthRevisionCase[] {
    return [
        ...(['expiredByTokenEntry', 'expiredBySessionEntry'] as const).map((field): AuthRevisionCase => ({
            label: `session ${field}`,
            command: {
                ...commandIdentity,
                kind: 'issue-session',
                authority: { kind: 'static-client', clientId: session.clientId, normalizedUsername: 'alice' },
                session
            },
            read: {
                kind: 'issue-session',
                userByUsername: null,
                userByClientId: null,
                ...createExpiredSessions(field, revision)
            }
        })),
        {
            label: 'websocket ticket',
            command: { ...commandIdentity, kind: 'issue-ws-ticket', ticketRecord: ticket },
            read: {
                kind: 'issue-ws-ticket',
                ticket: null,
                expiredTicketEntry: createExpiredEntry('ticket-digest=ticket-1', revision),
                session: createLiveEntry(session, Number.MAX_SAFE_INTEGER)
            }
        },
        ...(['expiredByTokenEntry', 'expiredBySessionEntry', 'ticket'] as const).map((field) => createAgentReplacementCase(field, revision))
    ];
}

function createAgentReplacementCase(
    field: 'expiredByTokenEntry' | 'expiredBySessionEntry' | 'ticket',
    revision: number
): AuthRevisionCase {
    return {
        label: `agent ${field}`,
        command: {
            ...commandIdentity,
            kind: 'issue-agent-tickets',
            authority: session,
            tickets: [{
                ...session,
                agentId: 'agent-1',
                ticketDigest: ticket.ticketDigest,
                sessionExpiresAtEpochMs: session.expiresAtEpochMs,
                ticketExpiresAtEpochMs: ticket.expiresAtEpochMs
            }]
        },
        read: {
            kind: 'issue-agent-tickets',
            authority: createLiveSessions(),
            sessions: [field === 'ticket' ? emptySessions : createExpiredSessions(field, revision)],
            tickets: [null],
            expiredTicketEntries: [field === 'ticket' ? createExpiredEntry('ticket-digest=ticket-1', revision) : null]
        }
    };
}

function createExpiredSessions(
    field: 'expiredByTokenEntry' | 'expiredBySessionEntry',
    revision: number
): AuthSessionEntries {
    return {
        ...emptySessions,
        [field]: createExpiredEntry(field === 'expiredByTokenEntry' ? 'token-digest=token-1' : 'session=session-1', revision)
    };
}

function createExpiredEntry(key: string, revision: number): RuntimeStateEntry {
    return { key, value: '{}', revision, expireAtTimestamp: 500, updatedTimestamp: '1970-01-01T00:00:00.000Z' };
}

function createLiveEntry<T>(value: T, revision: number): RuntimeStateEntryValue<T> {
    return { entry: { ...createExpiredEntry('live-entry', revision), value: JSON.stringify(value), expireAtTimestamp: 2_000 }, value };
}

function createLiveSessions(): AuthSessionEntries {
    return {
        ...emptySessions,
        byToken: createLiveEntry(session, Number.MAX_SAFE_INTEGER),
        bySession: createLiveEntry(session, Number.MAX_SAFE_INTEGER)
    };
}

function computeCase(testCase: AuthRevisionCase) {
    return computeAuthMutation({
        command: testCase.command,
        read: testCase.read,
        facts: { kind: testCase.command.kind },
        serviceId: 'auth-service'
    });
}
