import { Temporal } from '@js-temporal/polyfill';
import type {
    AgentSessionTicketResponse,
    ConsumeAgentSessionTicketResponse,
    LoginResponse,
    LogoutResponse,
    RegisterResponse,
    WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { requireConditionalWrite } from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    AuthSessionRepository,
    hashAuthSecret,
    type IssuedAuthSession,
    type PersistedAgentSessionTicket,
    type PersistedAuthSession,
    type PersistedWebSocketTicket,
} from '../repositories/AuthSessionRepository.ts';
import {
    type AuthUser,
    AuthUserRepository,
} from '../repositories/AuthUserRepository.ts';
import { toAppQueueCreatedBy } from './app-inbox-queue-key.ts';
import type { AuthCredentialIssuer } from './auth-credential-issuer.ts';

type CommandBase = Readonly<{
    version: 1;
    requestId: string;
    capturedAtEpochMs: number;
}>;

export type RegisterAuthUserCommand = CommandBase & Readonly<{
    kind: 'register-user';
    user: AuthUser;
}>;

export type IssueAuthSessionCommand = CommandBase & Readonly<{
    kind: 'issue-session';
    authority:
        | Readonly<{
            kind: 'registered-user';
            clientId: string;
            normalizedUsername: string;
            userRevision: number;
        }>
        | Readonly<{
            kind: 'static-client';
            clientId: string;
            normalizedUsername: string;
        }>;
    session: Readonly<{
        clientId: string;
        username: string;
        sessionId: string;
        accessTokenDigest: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;
}>;

export type LogoutAuthSessionCommand = CommandBase & Readonly<{
    kind: 'logout-session';
    expected: Readonly<{
        clientId: string;
        username: string;
        sessionId: string;
        accessTokenDigest: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;
}>;

export type IssueAuthWsTicketCommand = CommandBase & Readonly<{
    kind: 'issue-ws-ticket';
    ticketRecord: PersistedWebSocketTicket;
}>;

export type ConsumeAuthWsTicketCommand = CommandBase & Readonly<{
    kind: 'consume-ws-ticket';
    ticketDigest: string;
    expectedSessionId: string;
}>;

export type IssueAuthAgentTicketsCommand = CommandBase & Readonly<{
    kind: 'issue-agent-tickets';
    authority: Readonly<{
        clientId: string;
        username: string;
        sessionId: string;
        accessTokenDigest: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;
    tickets: readonly Readonly<{
        agentId: string;
        sessionId: string;
        accessTokenDigest: string;
        ticketDigest: string;
        clientId: string;
        username: string;
        issuedAtEpochMs: number;
        sessionExpiresAtEpochMs: number;
        ticketExpiresAtEpochMs: number;
    }>[];
}>;

export type ConsumeAuthAgentTicketCommand = CommandBase & Readonly<{
    kind: 'consume-agent-ticket';
    ticketDigest: string;
}>;

export type AuthMutationCommand =
    | RegisterAuthUserCommand
    | IssueAuthSessionCommand
    | LogoutAuthSessionCommand
    | IssueAuthWsTicketCommand
    | ConsumeAuthWsTicketCommand
    | IssueAuthAgentTicketsCommand
    | ConsumeAuthAgentTicketCommand;

export type AuthMutationPublicResult =
    | RegisterResponse
    | LoginResponse
    | LogoutResponse
    | WebSocketTicketResponse
    | IssuedAuthSession
    | AgentSessionTicketResponse
    | ConsumeAgentSessionTicketResponse;

export type AuthMutationResult =
    | RegisterResponse
    | LogoutResponse
    | Readonly<{
        kind: 'session-issued';
        clientId: string;
        username: string;
        sessionId: string;
        accessTokenDigest: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>
    | Readonly<{
        kind: 'ws-ticket-issued';
        ticketDigest: string;
        sessionId: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>
    | Readonly<{
        kind: 'ws-ticket-consumed' | 'agent-ticket-consumed';
        clientId: string;
        username: string;
        sessionId: string;
        accessTokenDigest: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>
    | Readonly<{
        kind: 'agent-tickets-issued';
        tickets: readonly Readonly<{
            agentId: string;
            ticketDigest: string;
            sessionId: string;
            issuedAtEpochMs: number;
            expiresAtEpochMs: number;
        }>[];
    }>;

type SessionEntries = Readonly<{
    byToken: RuntimeStateEntryValue<PersistedAuthSession> | null;
    bySession: RuntimeStateEntryValue<PersistedAuthSession> | null;
}>;

export type AuthMutationRead =
    | Readonly<{
        kind: 'register-user';
        byUsername: RuntimeStateEntryValue<AuthUser> | null;
        byClientId: RuntimeStateEntryValue<AuthUser> | null;
    }>
    | (Readonly<{
        kind: 'issue-session';
        userByUsername: RuntimeStateEntryValue<AuthUser> | null;
        userByClientId: RuntimeStateEntryValue<AuthUser> | null;
    }> & SessionEntries)
    | (Readonly<{ kind: 'logout-session' }> & SessionEntries)
    | Readonly<{
        kind: 'issue-ws-ticket';
        ticket: RuntimeStateEntryValue<PersistedWebSocketTicket> | null;
        session: RuntimeStateEntryValue<PersistedAuthSession> | null;
    }>
    | Readonly<{
        kind: 'consume-ws-ticket';
        ticket: RuntimeStateEntryValue<PersistedWebSocketTicket> | null;
        session: RuntimeStateEntryValue<PersistedAuthSession> | null;
    }>
    | Readonly<{
        kind: 'issue-agent-tickets';
        authority: SessionEntries;
        sessions: readonly SessionEntries[];
        tickets: readonly (RuntimeStateEntryValue<PersistedAgentSessionTicket> | null)[];
    }>
    | Readonly<{
        kind: 'consume-agent-ticket';
        ticket: RuntimeStateEntryValue<PersistedAgentSessionTicket> | null;
        session: RuntimeStateEntryValue<PersistedAuthSession> | null;
    }>;

export type AuthMutationFacts = Readonly<{
    kind: AuthMutationCommand['kind'];
}>;

type AuthComputedSession = Readonly<{
    session: PersistedAuthSession;
}>;

export type AuthMutationComputed = Readonly<{
    command: AuthMutationCommand;
    read: AuthMutationRead;
    result: AuthMutationResult;
    sessions: readonly AuthComputedSession[];
    agentTickets: readonly PersistedAgentSessionTicket[];
    logoutOutbox: ResourceEntry | null;
    outcome: 'write' | 'replay' | 'no-op';
}>;

export type AuthMutationService = Readonly<{
    read(command: AuthMutationCommand): Promise<AuthMutationRead>;
    compute(
        command: AuthMutationCommand,
        read: AuthMutationRead,
        facts: AuthMutationFacts,
    ): AuthMutationComputed;
    validate(
        command: AuthMutationCommand,
        read: AuthMutationRead,
        computed: AuthMutationComputed,
    ): void;
    write(
        transaction: PSqlTransactionSql,
        computed: AuthMutationComputed,
    ): Promise<AuthMutationResult>;
}>;

export function createAuthMutationService(options: Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    serviceId: string;
}>): AuthMutationService {
    const users = new AuthUserRepository(options.runtimeRepository);
    const sessions = new AuthSessionRepository(options.runtimeRepository);
    return {
        read: async (command) => await readAuthMutation(users, sessions, command),
        compute: (command, read, facts) => computeAuthMutation(
            command,
            read,
            facts,
            options.serviceId,
        ),
        validate: validateAuthMutation,
        write: async (transaction, computed) =>
            await writeAuthMutation(transaction, computed),
    };
}

export async function captureAuthMutationFacts(
    command: AuthMutationCommand,
    credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationFacts> {
    switch (command.kind) {
        case 'issue-session': {
            const accessToken = await credentialIssuer.issueAccessToken(
                command.session.sessionId,
            );
            await requireMatchingCredentialDigest(
                accessToken,
                command.session.accessTokenDigest,
                'Auth session credential digest differs',
            );
            break;
        }
        case 'issue-ws-ticket': {
            const ticket = await credentialIssuer.issueWebSocketTicket(
                command.requestId,
                command.ticketRecord.sessionId,
            );
            await requireMatchingCredentialDigest(
                ticket,
                command.ticketRecord.ticketDigest,
                'Websocket ticket digest differs',
            );
            break;
        }
        case 'issue-agent-tickets':
            for (const ticket of command.tickets) {
                const accessToken = await credentialIssuer.issueAccessToken(
                    ticket.sessionId,
                );
                const presentedTicket = await credentialIssuer.issueAgentTicket(
                    command.requestId,
                    ticket.agentId,
                    ticket.sessionId,
                );
                await requireMatchingCredentialDigest(
                    accessToken,
                    ticket.accessTokenDigest,
                    'Agent credential digest differs',
                );
                await requireMatchingCredentialDigest(
                    presentedTicket,
                    ticket.ticketDigest,
                    'Agent credential digest differs',
                );
            }
            break;
        case 'register-user':
        case 'logout-session':
        case 'consume-ws-ticket':
        case 'consume-agent-ticket':
            break;
    }
    return { kind: command.kind };
}

async function readAuthMutation(
    users: AuthUserRepository,
    sessions: AuthSessionRepository,
    command: AuthMutationCommand,
): Promise<AuthMutationRead> {
    switch (command.kind) {
        case 'register-user':
            return {
                kind: command.kind,
                byUsername: await users.findByNormalizedUsernameEntry(
                    command.user.normalizedUsername,
                ) ?? null,
                byClientId: await users.findByClientIdEntry(command.user.clientId) ?? null,
            };
        case 'issue-session': {
            return {
                kind: command.kind,
                userByUsername: await users.findByNormalizedUsernameEntry(
                    command.authority.normalizedUsername,
                ) ?? null,
                userByClientId: await users.findByClientIdEntry(
                    command.authority.clientId,
                ) ?? null,
                byToken: await sessions.findSessionByAccessTokenDigestEntry(
                    command.session.accessTokenDigest,
                ) ?? null,
                bySession: await sessions.findSessionBySessionIdEntry(
                    command.session.sessionId,
                ) ?? null,
            };
        }
        case 'logout-session': {
            return {
                kind: command.kind,
                ...await readExpectedSessionEntries(sessions, command.expected),
            };
        }
        case 'issue-ws-ticket': {
            const session = await sessions.findSessionBySessionIdEntry(
                command.ticketRecord.sessionId,
            ) ?? null;
            return {
                kind: command.kind,
                ticket: await sessions.findWebSocketTicketByDigestEntry(
                    command.ticketRecord.ticketDigest,
                ) ?? null,
                session,
            };
        }
        case 'consume-ws-ticket': {
            const ticket = await sessions.findWebSocketTicketByDigestEntry(
                command.ticketDigest,
            ) ?? null;
            const session = ticket
                ? await sessions.findSessionBySessionIdEntry(
                    ticket.value.sessionId,
                ) ?? null
                : null;
            return {
                kind: command.kind,
                ticket,
                session,
            };
        }
        case 'issue-agent-tickets': {
            const sessionEntries: SessionEntries[] = [];
            const ticketEntries: Array<RuntimeStateEntryValue<PersistedAgentSessionTicket> | null> = [];
            for (const ticket of command.tickets) {
                sessionEntries.push({
                    byToken: await sessions.findSessionByAccessTokenDigestEntry(
                        ticket.accessTokenDigest,
                    ) ?? null,
                    bySession: await sessions.findSessionBySessionIdEntry(ticket.sessionId) ?? null,
                });
                ticketEntries.push(
                    await sessions.findAgentSessionTicketByDigestEntry(ticket.ticketDigest) ?? null,
                );
            }
            return {
                kind: command.kind,
                authority: await readExpectedSessionEntries(
                    sessions,
                    command.authority,
                ),
                sessions: sessionEntries,
                tickets: ticketEntries,
            };
        }
        case 'consume-agent-ticket': {
            const ticket = await sessions.findAgentSessionTicketByDigestEntry(
                command.ticketDigest,
            ) ?? null;
            const session = ticket
                ? await sessions.findSessionBySessionIdEntry(
                    ticket.value.sessionId,
                ) ?? null
                : null;
            return {
                kind: command.kind,
                ticket,
                session,
            };
        }
    }
}

async function readExpectedSessionEntries(
    sessions: AuthSessionRepository,
    expected: Readonly<{
        sessionId: string;
        accessTokenDigest: string;
    }>,
): Promise<SessionEntries> {
    const bySession = await sessions.findSessionBySessionIdEntry(
        expected.sessionId,
    ) ?? null;
    let byToken = await sessions.findSessionByAccessTokenDigestEntry(
        expected.accessTokenDigest,
    ) ?? null;
    if (!byToken) {
        byToken = await sessions.findLegacySessionByAccessTokenDigestEntry(
            expected.accessTokenDigest,
        ) ?? null;
    }
    return { byToken, bySession };
}

function computeAuthMutation(
    command: AuthMutationCommand,
    read: AuthMutationRead,
    facts: AuthMutationFacts,
    serviceId: string,
): AuthMutationComputed {
    requireMatchingKind(command, read);
    requireMatchingFacts(command, facts);
    const common = {
        command,
        read,
        sessions: [] as readonly AuthComputedSession[],
        agentTickets: [] as readonly PersistedAgentSessionTicket[],
        logoutOutbox: null,
    };
    switch (command.kind) {
        case 'register-user':
            return {
                ...common,
                result: {
                    clientId: command.user.clientId,
                    username: command.user.username,
                    displayName: command.user.displayName,
                    registeredAtEpochMs: command.user.createdAtEpochMs,
                },
                outcome: isMatchingUserRead(read, command.user) ? 'replay' : 'write',
            };
        case 'issue-session': {
            const session: PersistedAuthSession = {
                clientId: command.session.clientId,
                username: command.session.username,
                sessionId: command.session.sessionId,
                accessTokenDigest: command.session.accessTokenDigest,
                issuedAtEpochMs: command.session.issuedAtEpochMs,
                expiresAtEpochMs: command.session.expiresAtEpochMs,
            };
            return {
                ...common,
                sessions: [{ session }],
                result: toSessionReceipt(session),
                outcome: isMatchingSessionRead(read, session) ? 'replay' : 'write',
            };
        }
        case 'logout-session': {
            const logoutRead = read as Extract<AuthMutationRead, { kind: 'logout-session' }>;
            return {
                ...common,
                result: { loggedOut: true },
                outcome: logoutRead.bySession === null && logoutRead.byToken === null
                    ? 'no-op'
                    : 'write',
                logoutOutbox: logoutRead.bySession
                    ? toLogoutWsOutbox(command, serviceId)
                    : null,
            };
        }
        case 'issue-ws-ticket': {
            const ticketRead = read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket' }>;
            return {
                ...common,
                result: {
                    kind: 'ws-ticket-issued',
                    ticketDigest: command.ticketRecord.ticketDigest,
                    sessionId: command.ticketRecord.sessionId,
                    issuedAtEpochMs: command.ticketRecord.issuedAtEpochMs,
                    expiresAtEpochMs: command.ticketRecord.expiresAtEpochMs,
                },
                outcome: ticketRead.ticket && equalJson(ticketRead.ticket.value, command.ticketRecord)
                    ? 'replay'
                    : 'write',
            };
        }
        case 'consume-ws-ticket': {
            const consumeRead = read as Extract<AuthMutationRead, { kind: 'consume-ws-ticket' }>;
            const ticket = requireTicket(consumeRead.ticket);
            return {
                ...common,
                result: toConsumedSessionReceipt(
                    'ws-ticket-consumed',
                    requireSession(
                        consumeRead.session,
                        'Websocket ticket session is unavailable',
                    ),
                    ticket.value.accessTokenDigest,
                ),
                outcome: 'write',
            };
        }
        case 'issue-agent-tickets': {
            const agentRead = read as Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>;
            const issuedSessions: AuthComputedSession[] = [];
            const persistedTickets: PersistedAgentSessionTicket[] = [];
            const responseTickets = [];
            for (const ticket of command.tickets) {
                issuedSessions.push({
                    session: {
                        clientId: ticket.clientId,
                        username: ticket.username,
                        sessionId: ticket.sessionId,
                        accessTokenDigest: ticket.accessTokenDigest,
                        issuedAtEpochMs: ticket.issuedAtEpochMs,
                        expiresAtEpochMs: ticket.sessionExpiresAtEpochMs,
                    },
                });
                persistedTickets.push({
                    ticketDigest: ticket.ticketDigest,
                    accessTokenDigest: ticket.accessTokenDigest,
                    sessionId: ticket.sessionId,
                    clientId: ticket.clientId,
                    agentId: ticket.agentId,
                    issuedAtEpochMs: ticket.issuedAtEpochMs,
                    expiresAtEpochMs: ticket.ticketExpiresAtEpochMs,
                });
                responseTickets.push({
                    agentId: ticket.agentId,
                    ticketDigest: ticket.ticketDigest,
                    sessionId: ticket.sessionId,
                    issuedAtEpochMs: ticket.issuedAtEpochMs,
                    expiresAtEpochMs: ticket.ticketExpiresAtEpochMs,
                });
            }
            return {
                ...common,
                sessions: issuedSessions,
                agentTickets: persistedTickets,
                result: { kind: 'agent-tickets-issued', tickets: responseTickets },
                outcome: isMatchingAgentIssueRead(agentRead, issuedSessions, persistedTickets)
                    ? 'replay'
                    : 'write',
            };
        }
        case 'consume-agent-ticket': {
            const consumeRead = read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>;
            const ticket = requireTicket(consumeRead.ticket);
            return {
                ...common,
                result: toConsumedSessionReceipt(
                    'agent-ticket-consumed',
                    requireSession(
                        consumeRead.session,
                        'Agent ticket session is unavailable',
                    ),
                    ticket.value.accessTokenDigest,
                ),
                outcome: 'write',
            };
        }
    }
}

function validateAuthMutation(
    command: AuthMutationCommand,
    read: AuthMutationRead,
    computed: AuthMutationComputed,
): void {
    requireMatchingKind(command, read);
    if (computed.command !== command || computed.read !== read) {
        throw new AuthMutationRejectedError('Auth computed input identity differs');
    }
    if (command.capturedAtEpochMs < 0) {
        throw new AuthMutationRejectedError('Auth command timestamp is invalid');
    }
    switch (command.kind) {
        case 'register-user':
            validateRegisterRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'register-user' }>,
            );
            return;
        case 'issue-session':
            validateIssueSessionRead(
                computed.sessions[0]?.session,
                read as Extract<AuthMutationRead, { kind: 'issue-session' }>,
            );
            validateIssueSessionUserAuthority(
                command,
                read as Extract<AuthMutationRead, { kind: 'issue-session' }>,
            );
            return;
        case 'logout-session':
            validateLogoutRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'logout-session' }>,
            );
            return;
        case 'issue-ws-ticket':
            validateIssueWsTicketRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket' }>,
            );
            return;
        case 'consume-ws-ticket':
            validateConsumeWsTicketRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'consume-ws-ticket' }>,
            );
            return;
        case 'issue-agent-tickets':
            validateAgentIssueRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
                computed,
            );
            return;
        case 'consume-agent-ticket':
            validateConsumeAgentTicketRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>,
            );
            return;
    }
}

async function writeAuthMutation(
    transaction: PSqlTransactionSql,
    computed: AuthMutationComputed,
): Promise<AuthMutationResult> {
    if (computed.outcome !== 'write') return computed.result;
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const users = new AuthUserRepository(runtime);
    const sessions = new AuthSessionRepository(runtime);
    switch (computed.command.kind) {
        case 'register-user':
            requireConditionalWrite(await users.insertByNormalizedUsername(
                computed.command.user,
            ));
            requireConditionalWrite(await users.insertByClientId(computed.command.user));
            break;
        case 'issue-session':
            await writeSession(sessions, computed.sessions[0]);
            break;
        case 'logout-session': {
            const read = computed.read as Extract<AuthMutationRead, { kind: 'logout-session' }>;
            if (!read.bySession || !read.byToken) break;
            requireConditionalWrite(await sessions.deleteSessionBySessionIdIfRevision(
                computed.command.expected.sessionId,
                read.bySession.entry.revision,
            ));
            requireConditionalWrite(await sessions.deleteSessionTokenStorageKeyIfRevision(
                read.byToken.entry.key,
                read.byToken.entry.revision,
            ));
            if (computed.logoutOutbox) {
                await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(
                    computed.logoutOutbox,
                );
            }
            break;
        }
        case 'issue-ws-ticket':
            requireConditionalWrite(await sessions.insertWebSocketTicket(
                computed.command.ticketRecord,
            ));
            break;
        case 'consume-ws-ticket': {
            const read = computed.read as Extract<AuthMutationRead, { kind: 'consume-ws-ticket' }>;
            const ticket = requireTicket(read.ticket);
            requireConditionalWrite(await sessions.deleteWebSocketTicketStorageKeyIfRevision(
                ticket.entry.key,
                ticket.entry.revision,
            ));
            break;
        }
        case 'issue-agent-tickets':
            for (let index = 0; index < computed.sessions.length; index += 1) {
                await writeSession(sessions, computed.sessions[index]);
                requireConditionalWrite(await sessions.insertAgentSessionTicket(
                    computed.agentTickets[index],
                ));
            }
            break;
        case 'consume-agent-ticket': {
            const read = computed.read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>;
            const ticket = requireTicket(read.ticket);
            requireConditionalWrite(await sessions.deleteAgentSessionTicketStorageKeyIfRevision(
                ticket.entry.key,
                ticket.entry.revision,
            ));
            break;
        }
    }
    return computed.result;
}

async function writeSession(
    repository: AuthSessionRepository,
    computed: AuthComputedSession,
): Promise<void> {
    requireConditionalWrite(await repository.insertSessionByTokenDigest(computed.session));
    requireConditionalWrite(await repository.insertSessionBySessionId(computed.session));
}

function validateRegisterRead(
    command: RegisterAuthUserCommand,
    read: Extract<AuthMutationRead, { kind: 'register-user' }>,
): void {
    if (read.byUsername && !equalJson(read.byUsername.value, command.user)) {
        throw new AuthMutationRejectedError('Auth username already exists', 409);
    }
    if (read.byClientId && !equalJson(read.byClientId.value, command.user)) {
        throw new AuthMutationRejectedError('Auth client identity already exists', 409);
    }
    if ((read.byUsername === null) !== (read.byClientId === null)) {
        throw new AuthMutationRejectedError('Auth user indexes are inconsistent', 500);
    }
}

function validateIssueSessionRead(
    session: PersistedAuthSession | undefined,
    read: Readonly<{ kind: 'issue-session' }> & SessionEntries,
): void {
    if (!session) throw new AuthMutationRejectedError('Issued auth session is missing');
    const tokenMatches = !read.byToken || equalJson(read.byToken.value, session);
    const sessionMatches = !read.bySession || equalJson(read.bySession.value, session);
    if (!tokenMatches || !sessionMatches) {
        throw new AuthMutationRejectedError('Auth session identity collision', 409);
    }
    if ((read.byToken === null) !== (read.bySession === null)) {
        throw new AuthMutationRejectedError('Auth session indexes are inconsistent', 500);
    }
}

function validateIssueSessionUserAuthority(
    command: IssueAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-session' }>,
): void {
    if (
        command.session.clientId !== command.authority.clientId ||
        command.session.username.trim().toLowerCase() !==
            command.authority.normalizedUsername
    ) {
        throw new AuthMutationRejectedError('Auth session user authority differs', 403);
    }
    if (command.authority.kind === 'static-client') {
        if (read.userByUsername || read.userByClientId) {
            throw new AuthMutationRejectedError(
                'Static auth session authority conflicts with a registered user',
                403,
            );
        }
        return;
    }
    if (
        !read.userByUsername || !read.userByClientId ||
        read.userByUsername.entry.revision !== command.authority.userRevision ||
        read.userByClientId.entry.revision !== command.authority.userRevision ||
        !equalJson(read.userByUsername.value, read.userByClientId.value)
    ) {
        throw new AuthMutationRejectedError('Registered auth user authority is unavailable', 403);
    }
    const user = read.userByUsername.value;
    if (
        user.status !== 'active' ||
        user.clientId !== command.authority.clientId ||
        user.normalizedUsername !== command.authority.normalizedUsername ||
        user.clientId !== command.session.clientId ||
        user.username !== command.session.username
    ) {
        throw new AuthMutationRejectedError('Registered auth user authority differs', 403);
    }
}

function validateLogoutRead(
    command: LogoutAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'logout-session' }>,
): void {
    if (read.bySession === null && read.byToken === null) return;
    if (!read.bySession || !read.byToken || !equalJson(read.bySession.value, read.byToken.value)) {
        throw new AuthMutationRejectedError('Auth logout indexes are inconsistent', 500);
    }
    const session = read.bySession.value;
    if (
        session.clientId !== command.expected.clientId ||
        session.username !== command.expected.username ||
        session.sessionId !== command.expected.sessionId ||
        session.issuedAtEpochMs !== command.expected.issuedAtEpochMs ||
        session.expiresAtEpochMs !== command.expected.expiresAtEpochMs
    ) {
        throw new AuthMutationRejectedError('Auth logout authority differs', 403);
    }
}

function validateIssueWsTicketRead(
    command: IssueAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-ws-ticket' }>,
): void {
    if (
        !read.session ||
        read.session.value.clientId !== command.ticketRecord.clientId ||
        read.session.value.accessTokenDigest !== command.ticketRecord.accessTokenDigest
    ) {
        throw new AuthMutationRejectedError('Websocket ticket session authority differs', 401);
    }
    if (
        command.ticketRecord.issuedAtEpochMs !== command.capturedAtEpochMs ||
        command.ticketRecord.expiresAtEpochMs <= command.capturedAtEpochMs ||
        command.ticketRecord.expiresAtEpochMs > read.session.value.expiresAtEpochMs
    ) {
        throw new AuthMutationRejectedError('Websocket ticket is expired', 410);
    }
    if (read.ticket && !equalJson(read.ticket.value, command.ticketRecord)) {
        throw new AuthMutationRejectedError('Websocket ticket digest collision', 409);
    }
}

function validateConsumeWsTicketRead(
    command: ConsumeAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'consume-ws-ticket' }>,
): void {
    const ticket = requireTicket(read.ticket).value;
    if (ticket.expiresAtEpochMs <= command.capturedAtEpochMs) {
        throw new AuthMutationRejectedError('Websocket ticket is expired', 410);
    }
    if (
        ticket.sessionId !== command.expectedSessionId ||
        !read.session || read.session.value.sessionId !== ticket.sessionId ||
        read.session.value.clientId !== ticket.clientId ||
        read.session.value.accessTokenDigest !== ticket.accessTokenDigest
    ) {
        throw new AuthMutationRejectedError('Websocket ticket authority differs', 401);
    }
}

function validateAgentIssueRead(
    command: IssueAuthAgentTicketsCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
    computed: AuthMutationComputed,
): void {
    if (command.tickets.length === 0 || command.tickets.length !== computed.sessions.length) {
        throw new AuthMutationRejectedError('Agent ticket batch is invalid');
    }
    validateLiveSessionAuthority(
        command.authority,
        read.authority,
        command.capturedAtEpochMs,
        'Agent ticket authority',
    );
    const seenAgentIds = new Set<string>();
    const seenSessionIds = new Set<string>();
    const seenTicketDigests = new Set<string>();
    for (let index = 0; index < command.tickets.length; index += 1) {
        const ticket = command.tickets[index];
        if (
            ticket.clientId !== command.authority.clientId ||
            ticket.username !== command.authority.username
        ) {
            throw new AuthMutationRejectedError('Agent ticket authority differs', 403);
        }
        if (
            ticket.issuedAtEpochMs !== command.capturedAtEpochMs ||
            ticket.sessionExpiresAtEpochMs <= command.capturedAtEpochMs ||
            ticket.ticketExpiresAtEpochMs <= command.capturedAtEpochMs ||
            ticket.ticketExpiresAtEpochMs > ticket.sessionExpiresAtEpochMs
        ) {
            throw new AuthMutationRejectedError('Agent ticket lifecycle is invalid', 410);
        }
        if (
            seenAgentIds.has(ticket.agentId) ||
            seenSessionIds.has(ticket.sessionId) ||
            seenTicketDigests.has(ticket.ticketDigest)
        ) {
            throw new AuthMutationRejectedError('Agent ticket batch identity is duplicated', 409);
        }
        seenAgentIds.add(ticket.agentId);
        seenSessionIds.add(ticket.sessionId);
        seenTicketDigests.add(ticket.ticketDigest);
        validateIssueSessionRead(computed.sessions[index]?.session, {
            kind: 'issue-session',
            ...read.sessions[index],
        });
        const current = read.tickets[index];
        if (current && !equalJson(current.value, computed.agentTickets[index])) {
            throw new AuthMutationRejectedError('Agent ticket digest collision', 409);
        }
    }
}

function validateLiveSessionAuthority(
    expected: Readonly<{
        clientId: string;
        username: string;
        sessionId: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>,
    read: SessionEntries,
    capturedAtEpochMs: number,
    label: string,
): void {
    if (
        !read.bySession || !read.byToken ||
        !equalJson(read.bySession.value, read.byToken.value)
    ) {
        throw new AuthMutationRejectedError(`${label} is unavailable`, 401);
    }
    const session = read.bySession.value;
    if (
        session.clientId !== expected.clientId ||
        session.username !== expected.username ||
        session.sessionId !== expected.sessionId ||
        session.issuedAtEpochMs !== expected.issuedAtEpochMs ||
        session.expiresAtEpochMs !== expected.expiresAtEpochMs
    ) {
        throw new AuthMutationRejectedError(`${label} differs`, 403);
    }
    if (session.expiresAtEpochMs <= capturedAtEpochMs) {
        throw new AuthMutationRejectedError(`${label} is expired`, 401);
    }
}

function validateConsumeAgentTicketRead(
    command: ConsumeAuthAgentTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>,
): void {
    const ticket = requireTicket(read.ticket).value;
    if (ticket.expiresAtEpochMs <= command.capturedAtEpochMs) {
        throw new AuthMutationRejectedError('Agent ticket is expired', 410);
    }
    if (
        !read.session || read.session.value.sessionId !== ticket.sessionId ||
        read.session.value.clientId !== ticket.clientId ||
        read.session.value.accessTokenDigest !== ticket.accessTokenDigest
    ) {
        throw new AuthMutationRejectedError('Agent ticket authority differs', 401);
    }
}

function isMatchingUserRead(
    read: AuthMutationRead,
    user: AuthUser,
): boolean {
    return read.kind === 'register-user' &&
        read.byUsername !== null && read.byClientId !== null &&
        equalJson(read.byUsername.value, user) && equalJson(read.byClientId.value, user);
}

function isMatchingSessionRead(read: AuthMutationRead, session: PersistedAuthSession): boolean {
    return (read.kind === 'issue-session' || read.kind === 'logout-session') &&
        read.byToken !== null && read.bySession !== null &&
        equalJson(read.byToken.value, session) && equalJson(read.bySession.value, session);
}

function isMatchingAgentIssueRead(
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
    sessions: readonly AuthComputedSession[],
    tickets: readonly PersistedAgentSessionTicket[],
): boolean {
    return read.sessions.length === sessions.length && read.tickets.length === tickets.length &&
        sessions.every((computed, index) =>
            read.sessions[index].byToken !== null &&
            read.sessions[index].bySession !== null &&
            equalJson(read.sessions[index].byToken?.value, computed.session) &&
            equalJson(read.sessions[index].bySession?.value, computed.session) &&
            read.tickets[index] !== null &&
            equalJson(read.tickets[index]?.value, tickets[index])
        );
}

function requireMatchingFacts(
    command: AuthMutationCommand,
    facts: AuthMutationFacts,
): void {
    if (facts.kind !== command.kind) {
        throw new AuthMutationRejectedError('Auth command/facts operation differs');
    }
}

function requireSession(
    entry: RuntimeStateEntryValue<PersistedAuthSession> | null,
    message: string,
): PersistedAuthSession {
    if (!entry) throw new AuthMutationRejectedError(message, 404);
    return entry.value;
}

function requireTicket<T>(entry: RuntimeStateEntryValue<T> | null): RuntimeStateEntryValue<T> {
    if (!entry) throw new AuthMutationRejectedError('Auth ticket is invalid or consumed', 404);
    return entry;
}

function requireMatchingKind(command: AuthMutationCommand, read: AuthMutationRead): void {
    if (command.kind !== read.kind) {
        throw new AuthMutationRejectedError('Auth command/read operation differs');
    }
}

function toSessionReceipt(
    session: PersistedAuthSession,
): Extract<AuthMutationResult, { kind: 'session-issued' }> {
    return {
        kind: 'session-issued',
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: session.accessTokenDigest,
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs,
    };
}

function toConsumedSessionReceipt(
    kind: 'ws-ticket-consumed' | 'agent-ticket-consumed',
    session: PersistedAuthSession,
    accessTokenDigest: string,
): Extract<AuthMutationResult, { kind: typeof kind }> {
    return {
        kind,
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest,
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs,
    };
}

function toLogoutWsOutbox(
    command: LogoutAuthSessionCommand,
    serviceId: string,
): ResourceEntry {
    const message = {
        id: {
            v: 2,
            msgId: `auth-logout:${command.requestId}`,
            ts: command.capturedAtEpochMs,
            senderId: serviceId,
        },
        route: {
            topicId: 'auth.session.logout',
            resourceId: command.requestId,
            contextId: command.expected.sessionId,
        },
        targets: {
            mode: 'unicast',
            toPeerId: command.expected.sessionId,
        },
        constraints: {
            expiresAtMs: command.expected.expiresAtEpochMs,
        },
        payload: {
            typeId: 'auth.session.logout.v1',
            contentType: 'application/json',
            resource: JSON.stringify({
                sessionId: command.expected.sessionId,
                closeCode: 1000,
                reason: 'auth-logout',
            }),
        },
        audit: {
            createdBy: serviceId,
            createdTs: command.capturedAtEpochMs,
        },
    } as const;
    const createdTs = Temporal.Instant
        .fromEpochMilliseconds(command.capturedAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key: message.route,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(serviceId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(
                command.expected.expiresAtEpochMs,
            ),
        },
        dequeueAudit: { attempts: 0 },
    };
}

function equalJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export class AuthMutationRejectedError extends Error {
    readonly code = 'auth-mutation-rejected';

    constructor(message: string, readonly status = 400) {
        super(message);
        this.name = 'AuthMutationRejectedError';
    }
}

async function requireMatchingCredentialDigest(
    credential: string,
    expectedDigest: string,
    message: string,
): Promise<void> {
    if (await hashAuthSecret(credential) !== expectedDigest) {
        throw new AuthMutationRejectedError(message);
    }
}

export function decodeAuthMutationCommand(input: unknown): AuthMutationCommand {
    const command = requireRecord(input, 'Auth mutation command');
    if (command.version !== 1) throw new TypeError('Auth mutation command version is invalid');
    requireString(command.requestId, 'Auth mutation requestId');
    requireTimestamp(command.capturedAtEpochMs, 'Auth mutation capturedAtEpochMs');
    switch (command.kind) {
        case 'register-user': {
            requireExactKeys(command, [
                'version', 'kind', 'requestId', 'capturedAtEpochMs', 'user',
            ]);
            validateAuthUserContract(command.user);
            break;
        }
        case 'issue-session': {
            requireExactKeys(command, [
                'version', 'kind', 'requestId', 'capturedAtEpochMs', 'authority',
                'session',
            ]);
            const authority = requireRecord(command.authority, 'Auth session authority');
            requireString(authority.clientId, 'Auth session authority clientId');
            requireString(
                authority.normalizedUsername,
                'Auth session authority normalizedUsername',
            );
            if (authority.kind === 'registered-user') {
                requireExactKeys(authority, [
                    'kind', 'clientId', 'normalizedUsername', 'userRevision',
                ]);
                requireTimestamp(authority.userRevision, 'Auth session authority userRevision');
            } else if (authority.kind === 'static-client') {
                requireExactKeys(authority, [
                    'kind', 'clientId', 'normalizedUsername',
                ]);
            } else {
                throw new TypeError('Auth session authority kind is invalid');
            }
            const session = requireRecord(command.session, 'Auth session command');
            requireExactKeys(session, [
                'clientId', 'username', 'sessionId', 'accessTokenDigest',
                'issuedAtEpochMs', 'expiresAtEpochMs',
            ]);
            validateSessionSeed(session);
            requireString(session.accessTokenDigest, 'Auth session accessTokenDigest');
            break;
        }
        case 'logout-session': {
            requireExactKeys(command, [
                'version', 'kind', 'requestId', 'capturedAtEpochMs', 'expected',
            ]);
            const expected = requireRecord(command.expected, 'Auth logout expected session');
            requireExactKeys(expected, [
                'clientId', 'username', 'sessionId', 'accessTokenDigest',
                'issuedAtEpochMs', 'expiresAtEpochMs',
            ]);
            validateSessionSeed(expected);
            requireString(expected.accessTokenDigest, 'Auth logout accessTokenDigest');
            break;
        }
        case 'issue-ws-ticket': {
            requireExactKeys(command, [
                'version', 'kind', 'requestId', 'capturedAtEpochMs',
                'ticketRecord',
            ]);
            validateWsTicketContract(command.ticketRecord);
            break;
        }
        case 'consume-ws-ticket': {
            requireExactKeys(command, [
                'version', 'kind', 'requestId', 'capturedAtEpochMs',
                'ticketDigest', 'expectedSessionId',
            ]);
            requireString(command.ticketDigest, 'Auth websocket ticket digest');
            requireString(command.expectedSessionId, 'Auth websocket expected sessionId');
            break;
        }
        case 'issue-agent-tickets': {
            requireExactKeys(command, [
                'version', 'kind', 'requestId', 'capturedAtEpochMs',
                'authority', 'tickets',
            ]);
            const authority = requireRecord(
                command.authority,
                'Auth agent ticket authority',
            );
            requireExactKeys(authority, [
                'clientId', 'username', 'sessionId', 'accessTokenDigest',
                'issuedAtEpochMs', 'expiresAtEpochMs',
            ]);
            validateSessionSeed(authority);
            requireString(
                authority.accessTokenDigest,
                'Auth agent ticket authority accessTokenDigest',
            );
            if (!Array.isArray(command.tickets) || command.tickets.length === 0) {
                throw new TypeError('Auth agent tickets must be a non-empty array');
            }
            for (const inputTicket of command.tickets) {
                const ticket = requireRecord(inputTicket, 'Auth agent ticket command');
                requireExactKeys(ticket, [
                    'agentId', 'sessionId', 'accessTokenDigest',
                    'ticketDigest', 'clientId', 'username', 'issuedAtEpochMs',
                    'sessionExpiresAtEpochMs', 'ticketExpiresAtEpochMs',
                ]);
                for (const field of [
                    'agentId', 'sessionId', 'accessTokenDigest',
                    'ticketDigest', 'clientId', 'username',
                ] as const) requireString(ticket[field], `Auth agent ticket ${field}`);
                for (const field of [
                    'issuedAtEpochMs', 'sessionExpiresAtEpochMs',
                    'ticketExpiresAtEpochMs',
                ] as const) requireTimestamp(ticket[field], `Auth agent ticket ${field}`);
            }
            break;
        }
        case 'consume-agent-ticket': {
            requireExactKeys(command, [
                'version', 'kind', 'requestId', 'capturedAtEpochMs', 'ticketDigest',
            ]);
            requireString(command.ticketDigest, 'Auth agent ticket digest');
            break;
        }
        default:
            throw new TypeError('Auth mutation command kind is invalid');
    }
    assertNoPlaintextAuthFields(command);
    return structuredClone(command) as AuthMutationCommand;
}

export function decodeAuthMutationResult(input: unknown): AuthMutationResult {
    const result = requireRecord(input, 'Auth mutation result');
    if ('registeredAtEpochMs' in result) {
        requireExactKeys(result, [
            'clientId', 'username', 'displayName', 'registeredAtEpochMs',
        ]);
        requireString(result.clientId, 'Auth result clientId');
        requireString(result.username, 'Auth result username');
        if (result.displayName !== null) {
            requireString(result.displayName, 'Auth result displayName');
        }
        requireTimestamp(result.registeredAtEpochMs, 'Auth result registeredAtEpochMs');
    } else if ('loggedOut' in result) {
        requireExactKeys(result, ['loggedOut']);
        if (result.loggedOut !== true) throw new TypeError('Auth logout result is invalid');
    } else {
        switch (result.kind) {
            case 'session-issued':
            case 'ws-ticket-consumed':
            case 'agent-ticket-consumed':
                validateSessionResult(result);
                break;
            case 'ws-ticket-issued':
                requireExactKeys(result, [
                    'kind', 'ticketDigest', 'sessionId', 'issuedAtEpochMs',
                    'expiresAtEpochMs',
                ]);
                requireString(result.ticketDigest, 'Auth result ticketDigest');
                requireString(result.sessionId, 'Auth result sessionId');
                validateResultLifecycle(result);
                break;
            case 'agent-tickets-issued':
                requireExactKeys(result, ['kind', 'tickets']);
                if (!Array.isArray(result.tickets) || result.tickets.length === 0) {
                    throw new TypeError('Auth result tickets must be a non-empty array');
                }
                for (const inputTicket of result.tickets) {
                    const ticket = requireRecord(inputTicket, 'Auth result agent ticket');
                    requireExactKeys(ticket, [
                        'agentId', 'ticketDigest', 'sessionId', 'issuedAtEpochMs',
                        'expiresAtEpochMs',
                    ]);
                    requireString(ticket.agentId, 'Auth result agentId');
                    requireString(ticket.ticketDigest, 'Auth result ticketDigest');
                    requireString(ticket.sessionId, 'Auth result sessionId');
                    validateResultLifecycle(ticket);
                }
                break;
            default:
                throw new TypeError('Auth mutation result kind is invalid');
        }
    }
    assertNoPlaintextAuthFields(result);
    return structuredClone(result) as AuthMutationResult;
}

function validateSessionResult(result: Readonly<Record<string, unknown>>): void {
    requireExactKeys(result, [
        'kind', 'clientId', 'username', 'sessionId', 'accessTokenDigest',
        'issuedAtEpochMs', 'expiresAtEpochMs',
    ]);
    for (const field of [
        'clientId', 'username', 'sessionId', 'accessTokenDigest',
    ] as const) requireString(result[field], `Auth result ${field}`);
    validateResultLifecycle(result);
}

function validateResultLifecycle(result: Readonly<Record<string, unknown>>): void {
    requireTimestamp(result.issuedAtEpochMs, 'Auth result issuedAtEpochMs');
    requireTimestamp(result.expiresAtEpochMs, 'Auth result expiresAtEpochMs');
    if ((result.issuedAtEpochMs as number) >= (result.expiresAtEpochMs as number)) {
        throw new TypeError('Auth result lifecycle is invalid');
    }
}

function validateAuthUserContract(input: unknown): void {
    const user = requireRecord(input, 'Auth user');
    requireExactKeys(user, [
        'clientId', 'username', 'normalizedUsername', 'displayName',
        'passwordHash', 'passwordSalt', 'passwordAlgorithm',
        'passwordIterations', 'roles', 'status', 'createdAtEpochMs',
        'updatedAtEpochMs',
    ]);
    for (const field of [
        'clientId', 'username', 'normalizedUsername', 'passwordHash', 'passwordSalt',
    ] as const) requireString(user[field], `Auth user ${field}`);
    if (user.displayName !== null) requireString(user.displayName, 'Auth user displayName');
    if (user.passwordAlgorithm !== 'pbkdf2-sha256') {
        throw new TypeError('Auth user passwordAlgorithm is invalid');
    }
    requireTimestamp(user.passwordIterations, 'Auth user passwordIterations');
    requireTimestamp(user.createdAtEpochMs, 'Auth user createdAtEpochMs');
    requireTimestamp(user.updatedAtEpochMs, 'Auth user updatedAtEpochMs');
    if (!Array.isArray(user.roles) || user.roles.some((role) =>
        typeof role !== 'string' || role.length === 0
    )) throw new TypeError('Auth user roles are invalid');
    if (user.status !== 'active' && user.status !== 'disabled') {
        throw new TypeError('Auth user status is invalid');
    }
}

function validateSessionSeed(session: Readonly<Record<string, unknown>>): void {
    for (const field of ['clientId', 'username', 'sessionId'] as const) {
        requireString(session[field], `Auth session ${field}`);
    }
    requireTimestamp(session.issuedAtEpochMs, 'Auth session issuedAtEpochMs');
    requireTimestamp(session.expiresAtEpochMs, 'Auth session expiresAtEpochMs');
}

function validateWsTicketContract(input: unknown): void {
    const ticket = requireRecord(input, 'Persisted websocket ticket');
    requireExactKeys(ticket, [
        'ticketDigest', 'accessTokenDigest', 'sessionId', 'clientId', 'issuedAtEpochMs',
        'expiresAtEpochMs',
    ]);
    for (const field of [
        'ticketDigest', 'accessTokenDigest', 'sessionId', 'clientId',
    ] as const) {
        requireString(ticket[field], `Persisted websocket ticket ${field}`);
    }
    requireTimestamp(ticket.issuedAtEpochMs, 'Persisted websocket ticket issuedAtEpochMs');
    requireTimestamp(ticket.expiresAtEpochMs, 'Persisted websocket ticket expiresAtEpochMs');
}

function assertNoPlaintextAuthFields(value: unknown): void {
    if (Array.isArray(value)) {
        for (const item of value) assertNoPlaintextAuthFields(item);
        return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
        if (key === 'password' || key === 'accessToken' || key === 'ticket') {
            throw new TypeError(`Auth mutation command contains forbidden plaintext field: ${key}`);
        }
        assertNoPlaintextAuthFields(nested);
    }
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError(`${label} must be a plain JSON object`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (!equalJson(actual, expected)) {
        throw new TypeError(`Auth mutation fields are invalid: ${actual.join(',')}`);
    }
}

function requireString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is required`);
    }
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
}
