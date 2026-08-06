import type {
  AgentSessionTicketResponse,
  ConsumeAgentSessionTicketResponse,
  LoginResponse,
  LogoutResponse,
  RegisterResponse,
  WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/RuntimeStateRepository.ts';
import type {
  PersistedAgentSessionTicket,
  PersistedAuthSession,
  PersistedWebSocketTicket,
} from '../../repositories/auth-persistence-contracts.ts';
import type { IssuedAuthSession } from '../../repositories/auth-session-types.ts';

type AuthUser = import('../../repositories/AuthUserRepository.ts').AuthUser;

type CommandBase = Readonly<{
  version: 1;
  requestId: string;
  capturedAtEpochMs: number;
}>;

export type RegisterAuthUserCommand = CommandBase &
  Readonly<{
    kind: 'register-user';
    user: AuthUser;
  }>;

export type IssueAuthSessionCommand = CommandBase &
  Readonly<{
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
    session: PersistedAuthSession;
  }>;

export type LogoutAuthSessionCommand = CommandBase &
  Readonly<{
    kind: 'logout-session';
    expected: PersistedAuthSession;
  }>;

export type IssueAuthWsTicketCommand = CommandBase &
  Readonly<{
    kind: 'issue-ws-ticket';
    ticketRecord: PersistedWebSocketTicket;
  }>;

export type ConsumeAuthWsTicketCommand = CommandBase &
  Readonly<{
    kind: 'consume-ws-ticket';
    ticketDigest: string;
    expectedSessionId: string;
  }>;

export type IssueAuthAgentTicketsCommand = CommandBase &
  Readonly<{
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

export type ConsumeAuthAgentTicketCommand = CommandBase &
  Readonly<{
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

type AuthMutationResultIdentity = Readonly<{ requestId: string }>;

export type AuthMutationResult = AuthMutationResultIdentity &
  (
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
      byUsername: RuntimeStateEntryValue<AuthUser> | null;
      byClientId: RuntimeStateEntryValue<AuthUser> | null;
    }>
  | (Readonly<{
      kind: 'issue-session';
      userByUsername: RuntimeStateEntryValue<AuthUser> | null;
      userByClientId: RuntimeStateEntryValue<AuthUser> | null;
    }> &
      AuthSessionEntries)
  | (Readonly<{ kind: 'logout-session' }> & AuthSessionEntries)
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
}>;

export type AuthComputedSession = Readonly<{
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
