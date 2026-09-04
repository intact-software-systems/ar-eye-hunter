import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { computeAppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import {
    AGENT_SESSION_TICKETS_NAMESPACE,
    AUTH_SESSIONS_BY_SESSION_NAMESPACE,
    AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
    AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
    AUTH_USERS_BY_USERNAME_NAMESPACE,
    authClientIdKey,
    authNormalizedUsernameKey,
    authSessionKey,
    authTicketDigestKey,
    authTokenDigestKey,
    WS_AUTH_TICKETS_NAMESPACE
} from '../../persistence/auth-storage-keys.ts';
import type {
    AuthMutationComputed,
    AuthMutationDomainComputed,
    AuthMutationRead,
    AuthPersistenceOperation,
    AuthSessionEntries
} from '../auth-mutation-contracts.ts';

export function computeAuthPersistence(
    computed: AuthMutationDomainComputed,
    kind: AuthMutationDomainComputed['command']['kind']
): AuthMutationComputed['persistence'] {
    if (computed.outcome !== 'write') {
        return { operations: [], logoutOutbox: null };
    }
    return {
        operations: computeAuthPersistenceOperations(computed, kind),
        logoutOutbox: computeLogoutOutbox(computed, kind)
    };
}

function computeAuthPersistenceOperations(
    computed: AuthMutationDomainComputed,
    kind: AuthMutationDomainComputed['command']['kind']
): readonly AuthPersistenceOperation[] {
    switch (kind) {
        case 'register-user':
            return computeUserRegistration(computed, kind);
        case 'issue-session':
            return computeSessionWrites(
                computed.sessions[0].session,
                requireAuthRead(computed, kind)
            );
        case 'logout-session':
            return computeLogoutDeletes(computed, kind);
        case 'issue-ws-ticket':
            const issueWsCommand = authCommand(computed, kind);
            const issueWsRead = requireAuthRead(computed, kind);
            return [runtimeWrite({
                namespace: WS_AUTH_TICKETS_NAMESPACE,
                key: authTicketDigestKey(issueWsCommand.ticketRecord.ticketDigest),
                value: issueWsCommand.ticketRecord,
                expireAtEpochMs: issueWsCommand.ticketRecord.expiresAtEpochMs,
                expectedRevision: issueWsRead.expiredTicketEntry?.revision ?? null
            })];
        case 'consume-ws-ticket': {
            const ticket = requireTicketEntry(requireAuthRead(computed, kind).ticket);
            return [runtimeDelete(
                WS_AUTH_TICKETS_NAMESPACE,
                ticket.entry.key,
                ticket.entry.revision
            )];
        }
        case 'issue-agent-tickets': {
            const issueAgentRead = requireAuthRead(computed, kind);
            return computed.sessions.flatMap((session, index) => [
                ...computeSessionWrites(session.session, issueAgentRead.sessions[index]),
                runtimeWrite({
                    namespace: AGENT_SESSION_TICKETS_NAMESPACE,
                    key: authTicketDigestKey(computed.agentTickets[index].ticketDigest),
                    value: computed.agentTickets[index],
                    expireAtEpochMs: computed.agentTickets[index].expiresAtEpochMs,
                    expectedRevision: issueAgentRead.expiredTicketEntries[index]?.revision ?? null
                })
            ]);
        }
        case 'consume-agent-ticket': {
            const ticket = requireTicketEntry(requireAuthRead(computed, kind).ticket);
            return [runtimeDelete(
                AGENT_SESSION_TICKETS_NAMESPACE,
                ticket.entry.key,
                ticket.entry.revision
            )];
        }
    }
}

function computeUserRegistration(
    computed: AuthMutationDomainComputed,
    kind: 'register-user'
): readonly AuthPersistenceOperation[] {
    const user = authCommand(computed, kind).user;
    const value = encodeRuntimeStateJsonValue(user);
    const expireAtIsoTimestamp = new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString();
    return [
        {
            kind: 'insert',
            namespace: AUTH_USERS_BY_USERNAME_NAMESPACE,
            key: authNormalizedUsernameKey(user.normalizedUsername),
            value,
            expireAtIsoTimestamp,
            expectedRevision: null
        },
        {
            kind: 'insert',
            namespace: AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            key: authClientIdKey(user.clientId),
            value,
            expireAtIsoTimestamp,
            expectedRevision: null
        }
    ];
}

function computeSessionWrites(
    session: AuthMutationDomainComputed['sessions'][number]['session'],
    read: AuthSessionEntries
): readonly AuthPersistenceOperation[] {
    return [
        runtimeWrite({
            namespace: AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            key: authTokenDigestKey(session.accessTokenDigest),
            value: session,
            expireAtEpochMs: session.expiresAtEpochMs,
            expectedRevision: read.expiredByTokenEntry?.revision ?? null
        }),
        runtimeWrite({
            namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            key: authSessionKey(session.sessionId),
            value: session,
            expireAtEpochMs: session.expiresAtEpochMs,
            expectedRevision: read.expiredBySessionEntry?.revision ?? null
        })
    ];
}

function computeLogoutDeletes(
    computed: AuthMutationDomainComputed,
    kind: 'logout-session'
): readonly AuthPersistenceOperation[] {
    const command = authCommand(computed, kind);
    const read = requireAuthRead(computed, kind);
    if (read.bySession === null || read.byToken === null) {
        return [];
    }
    return [
        runtimeDelete(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            authSessionKey(command.expected.sessionId),
            read.bySession.entry.revision
        ),
        runtimeDelete(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            read.byToken.entry.key,
            read.byToken.entry.revision
        )
    ];
}

function computeLogoutOutbox(
    computed: AuthMutationDomainComputed,
    kind: AuthMutationDomainComputed['command']['kind']
): AuthMutationComputed['persistence']['logoutOutbox'] {
    if (kind !== 'logout-session' || computed.logoutOutbox === null) {
        return null;
    }
    const read = requireAuthRead(computed, kind);
    return read.bySession !== null && read.byToken !== null
        ? computeAppOutboxInsert(computed.logoutOutbox)
        : null;
}

function requireAuthRead<Kind extends AuthMutationRead['kind']>(
    computed: AuthMutationDomainComputed,
    _kind: Kind
): Extract<AuthMutationRead, { kind: Kind; }> {
    return computed.read as Extract<AuthMutationRead, { kind: Kind; }>;
}

function authCommand<Kind extends AuthMutationDomainComputed['command']['kind']>(
    computed: AuthMutationDomainComputed,
    _kind: Kind
): Extract<AuthMutationDomainComputed['command'], { kind: Kind; }> {
    return computed.command as Extract<AuthMutationDomainComputed['command'], { kind: Kind; }>;
}

function requireTicketEntry<Entry>(entry: Entry | null): Entry {
    if (entry === null) {
        throw new TypeError('Auth ticket persistence requires the computed ticket read');
    }
    return entry;
}

interface AuthRuntimeWriteInput {
    readonly namespace: string;
    readonly key: string;
    readonly value: object;
    readonly expireAtEpochMs: number;
    readonly expectedRevision: number | null;
}

function runtimeWrite(input: AuthRuntimeWriteInput): AuthPersistenceOperation {
    const stored = {
        namespace: input.namespace,
        key: input.key,
        value: encodeRuntimeStateJsonValue(input.value),
        expireAtIsoTimestamp: new Date(input.expireAtEpochMs).toISOString()
    };
    return input.expectedRevision === null
        ? { ...stored, kind: 'insert', expectedRevision: null }
        : { ...stored, kind: 'update', expectedRevision: input.expectedRevision };
}

function runtimeDelete(
    namespace: string,
    key: string,
    expectedRevision: number
): AuthPersistenceOperation {
    return { kind: 'delete', namespace, key, expectedRevision };
}
