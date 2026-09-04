import type {
    AgentSessionTicketResponse,
    AuthSession,
    LoginResponse,
    LogoutResponse,
    RegisterResponse,
    WebSocketTicketResponse
} from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import type { PreparedAuthUserRegistration } from '../login/prepare-auth-user-registration.ts';
import type { IssuedAuthSession } from '../persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../persistence/persisted-auth-session.ts';
import type { PersistedAgentSessionTicket, PersistedWebSocketTicket } from '../persistence/persisted-auth-ticket.ts';
import type { PersistedAuthUser } from '../persistence/persisted-auth-user.ts';

type CommandBase = Readonly<{
    version: 1;
    requestId: string;
    capturedAtEpochMs: number;
}>;

type IntentBase = Readonly<{
    version: 1;
    requestId: string;
}>;

export type AuthSessionAuthority =
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

export type RegisterAuthUserIntent =
    & IntentBase
    & Readonly<{
        kind: 'register-user';
        registration: PreparedAuthUserRegistration;
    }>;

export type IssueAuthSessionIntent =
    & IntentBase
    & Readonly<{
        kind: 'issue-session';
        authority: AuthSessionAuthority;
        clientId: string;
        username: string;
        ttlMs: number;
    }>;

export type LogoutAuthSessionIntent =
    & IntentBase
    & Readonly<{
        kind: 'logout-session';
        expected: PersistedAuthSession;
    }>;

export type IssueAuthWsTicketIntent =
    & IntentBase
    & Readonly<{
        kind: 'issue-ws-ticket';
        authority: PersistedAuthSession;
        ttlMs: number;
    }>;

export type ConsumeAuthWsTicketIntent =
    & IntentBase
    & Readonly<{
        kind: 'consume-ws-ticket';
        ticketDigest: string;
        expectedSessionId: string;
    }>;

export type IssueAuthAgentTicketsIntent =
    & IntentBase
    & Readonly<{
        kind: 'issue-agent-tickets';
        authority: PersistedAuthSession;
        ticketTtlMs: number;
        agentIds: readonly string[];
    }>;

export type ConsumeAuthAgentTicketIntent =
    & IntentBase
    & Readonly<{
        kind: 'consume-agent-ticket';
        ticketDigest: string;
    }>;

export type AuthMutationIntent =
    | RegisterAuthUserIntent
    | IssueAuthSessionIntent
    | LogoutAuthSessionIntent
    | IssueAuthWsTicketIntent
    | ConsumeAuthWsTicketIntent
    | IssueAuthAgentTicketsIntent
    | ConsumeAuthAgentTicketIntent;

export type RegisterAuthUserCommand =
    & CommandBase
    & Readonly<{
        kind: 'register-user';
        user: PersistedAuthUser;
    }>;

export type IssueAuthSessionCommand =
    & CommandBase
    & Readonly<{
        kind: 'issue-session';
        authority: AuthSessionAuthority;
        session: PersistedAuthSession;
    }>;

export type LogoutAuthSessionCommand =
    & CommandBase
    & Readonly<{
        kind: 'logout-session';
        expected: PersistedAuthSession;
    }>;

export type IssueAuthWsTicketCommand =
    & CommandBase
    & Readonly<{
        kind: 'issue-ws-ticket';
        ticketRecord: PersistedWebSocketTicket;
    }>;

export type ConsumeAuthWsTicketCommand =
    & CommandBase
    & Readonly<{
        kind: 'consume-ws-ticket';
        ticketDigest: string;
        expectedSessionId: string;
    }>;

export type IssueAuthAgentTicketsCommand =
    & CommandBase
    & Readonly<{
        kind: 'issue-agent-tickets';
        authority: PersistedAuthSession;
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

export type ConsumeAuthAgentTicketCommand =
    & CommandBase
    & Readonly<{
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
    | AuthSession;

type AuthMutationResultIdentity = Readonly<{ requestId: string; }>;

export type AuthMutationResult =
    & AuthMutationResultIdentity
    & (
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
        }>
    );

export type AuthSessionEntries = Readonly<{
    byToken: RuntimeStateEntryValue<PersistedAuthSession> | null;
    bySession: RuntimeStateEntryValue<PersistedAuthSession> | null;
    expiredByTokenEntry: RuntimeStateEntry | null;
    expiredBySessionEntry: RuntimeStateEntry | null;
}>;

export type AuthMutationRead =
    | Readonly<{
        kind: 'register-user';
        byUsername: RuntimeStateEntryValue<PersistedAuthUser> | null;
        byClientId: RuntimeStateEntryValue<PersistedAuthUser> | null;
    }>
    | (
        & Readonly<{
            kind: 'issue-session';
            userByUsername: RuntimeStateEntryValue<PersistedAuthUser> | null;
            userByClientId: RuntimeStateEntryValue<PersistedAuthUser> | null;
        }>
        & AuthSessionEntries
    )
    | (Readonly<{ kind: 'logout-session'; }> & AuthSessionEntries)
    | Readonly<{
        kind: 'issue-ws-ticket';
        ticket: RuntimeStateEntryValue<PersistedWebSocketTicket> | null;
        expiredTicketEntry: RuntimeStateEntry | null;
        session: RuntimeStateEntryValue<PersistedAuthSession> | null;
    }>
    | Readonly<{
        kind: 'consume-ws-ticket';
        ticket: RuntimeStateEntryValue<PersistedWebSocketTicket> | null;
        session: RuntimeStateEntryValue<PersistedAuthSession> | null;
    }>
    | Readonly<{
        kind: 'issue-agent-tickets';
        authority: AuthSessionEntries;
        sessions: readonly AuthSessionEntries[];
        tickets: readonly (RuntimeStateEntryValue<PersistedAgentSessionTicket> | null)[];
        expiredTicketEntries: readonly (RuntimeStateEntry | null)[];
    }>
    | Readonly<{
        kind: 'consume-agent-ticket';
        ticket: RuntimeStateEntryValue<PersistedAgentSessionTicket> | null;
        session: RuntimeStateEntryValue<PersistedAuthSession> | null;
    }>;

export type AuthMutationFacts = Readonly<{
    kind: AuthMutationCommand['kind'];
    serviceId: string;
}>;

export type AuthComputedSession = Readonly<{
    session: PersistedAuthSession;
}>;

export type AuthMutationDomainComputed = Readonly<{
    command: AuthMutationCommand;
    read: AuthMutationRead;
    result: AuthMutationResult;
    sessions: readonly AuthComputedSession[];
    agentTickets: readonly PersistedAgentSessionTicket[];
    logoutOutbox: ResourceEntry | null;
    outcome: 'write' | 'replay' | 'no-op';
}>;

export type AuthPersistenceOperation =
    | Readonly<{
        kind: 'insert';
        namespace: string;
        key: string;
        value: string;
        expireAtIsoTimestamp: string;
        expectedRevision: null;
    }>
    | Readonly<{
        kind: 'update';
        namespace: string;
        key: string;
        value: string;
        expireAtIsoTimestamp: string;
        expectedRevision: number;
    }>
    | Readonly<{
        kind: 'delete';
        namespace: string;
        key: string;
        expectedRevision: number;
    }>;

export type AuthMutationComputed =
    & AuthMutationDomainComputed
    & Readonly<{
        persistence: Readonly<{
            operations: readonly AuthPersistenceOperation[];
            logoutOutbox: AppOutboxInsert | null;
        }>;
    }>;
