import type {
  AgentSessionTicketResponse,
  ConsumeAgentSessionTicketResponse,
  LoginResponse,
  LogoutResponse,
  RegisterRequest,
  RegisterResponse,
  WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { AuthMutationService } from '../auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import { constantTimeAuthDigestEqual } from '../credentials/constant-time-auth-digest-equal.ts';
import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import type {
  AuthMutationCommand,
  AuthMutationPublicResult,
  AuthMutationResult,
  ConsumeAuthAgentTicketCommand,
  ConsumeAuthWsTicketCommand,
  IssueAuthAgentTicketsCommand,
  IssueAuthSessionCommand,
  IssueAuthWsTicketCommand,
  LogoutAuthSessionCommand,
  RegisterAuthUserCommand,
} from '../mutation/auth-mutation-contracts.ts';
import { decodeAuthMutationCommand } from '../mutation/decode-auth-mutation-command.ts';
import { decodeAuthMutationResult } from '../mutation/decode-auth-mutation-result.ts';
import { toAuthMutationPublicResult } from '../mutation/to-auth-mutation-public-result.ts';
import type { IssuedAuthSession } from '../persistence/auth-session-types.ts';
import type { AuthUser } from '../persistence/auth-user-repository.ts';
import type { LoginClientData } from '../login/authenticate-auth-user.ts';
import { verifyAuthUserPassword } from '../login/authenticate-auth-user.ts';
import { prepareAuthUserRegistration } from '../login/prepare-auth-user-registration.ts';
import { AppInboxService, type AppInboxServiceOptions } from '../../services/AppInboxService.ts';
import {
  AppInboxIdempotencyConflictError,
  type AppInboxEnqueueInput,
  AppInboxType,
} from '../../services/app-inbox-contracts.ts';
import { toAppInboxErrorCode } from '../../services/app-inbox-error-classification.ts';
import {
  type AppInboxFailure,
  toTerminalAppInboxFailure,
} from '../../services/app-inbox-failure.ts';
import type { RallarTimingSink } from '../../services/timing.ts';
import {
  AUTH_STATE_APP_INBOX_TOPIC,
  toAuthAppInboxType,
  toAuthCommandContextId,
  toAuthCommandSenderId,
  toAuthCredentialContextId,
  toAuthSessionContextId,
  toAuthUsernameContextId,
} from './auth-app-inbox-routing.ts';
import { AuthInboxHandler } from './auth-inbox-handler.ts';
import { validateAppInboxCommandIdentity } from '../../services/app-inbox-command-identity.ts';
import { toJsonWireAppInboxEnqueue } from '../../services/app-inbox-command-wire.ts';
import {
  toAppInboxQueueCreatedBy,
  toAppInboxQueueKey,
} from '../../services/app-inbox-queue-key.ts';

interface AuthInboxRepository {
  findAllByTopicAndResourceId(
    topicId: string,
    resourceId: string,
  ): Promise<readonly ResourceEntry[]>;
  writeMaterializedIfAbsentOrReplaceExpired(
    placeholder: ResourceEntry,
    materialize: () => Promise<ResourceEntry>,
  ): Promise<ResourceEntry>;
}

export { AUTH_STATE_APP_INBOX_TOPIC, toAuthAppInboxType } from './auth-app-inbox-routing.ts';

const AUTH_TYPES = [
  AppInboxType.AUTH_USER_REGISTER,
  AppInboxType.AUTH_SESSION_ISSUE,
  AppInboxType.AUTH_SESSION_LOGOUT,
  AppInboxType.AUTH_WS_TICKET_ISSUE,
  AppInboxType.AUTH_WS_TICKET_CONSUME,
  AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
  AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
] as const;

export namespace AppAuthInboxService {
  export interface Dependencies {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: AppInboxService.InboxRepository & AuthInboxRepository;
    readonly resourceInboxResultsRepository: AppInboxService.ResultRepository;
    readonly database: PSqlSql;
    readonly authMutationService: AuthMutationService;
    readonly credentialIssuer: AuthCredentialIssuer;
  }

  export interface Config {
    readonly serviceId: string;
    readonly timing?: RallarTimingSink;
    readonly options?: AppInboxServiceOptions;
    readonly wakeOwningQueue?: () => void;
    readonly authFactNowEpochMs?: () => number;
  }

  export interface RequestIdentity {
    readonly requestId: string;
  }
}

export class AppAuthInboxService extends AppInboxService {
  private readonly authInboxHandler: AuthInboxHandler;
  private readonly authInboxRepository: AuthInboxRepository;
  private readonly authFactNowEpochMs: () => number;

  public readonly authMutationService: AuthMutationService;
  public readonly credentialIssuer: AuthCredentialIssuer;

  constructor(
    dependencies: AppAuthInboxService.Dependencies,
    config: AppAuthInboxService.Config,
  ) {
    super(
      {
        inboxQueueReader: dependencies.inboxQueueReader,
        resourceInboxRepository: dependencies.resourceInboxRepository,
        resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
        database: dependencies.database,
      },
      {
        serviceId: config.serviceId,
        defaultTopicId: AUTH_STATE_APP_INBOX_TOPIC,
        timing: config.timing,
        options: config.options,
        wakeOwningQueue: config.wakeOwningQueue,
      },
    );
    this.authMutationService = dependencies.authMutationService;
    this.credentialIssuer = dependencies.credentialIssuer;
    this.authInboxRepository = dependencies.resourceInboxRepository;
    this.authFactNowEpochMs = config.authFactNowEpochMs ?? Date.now;
    this.authInboxHandler = new AuthInboxHandler({
      mutationService: dependencies.authMutationService,
      credentialIssuer: dependencies.credentialIssuer,
      transactionWriter: this.transactionWriter,
    });
    for (const type of AUTH_TYPES) {
      this.onStateMessage<Parameters<AuthInboxHandler['processAuthMutation']>[0]>(
        type,
        async (command, context) =>
          await this.authInboxHandler.processAuthMutation(command, context),
      );
    }
  }

  async processAuthCommandUntilCompletion(
    command: RegisterAuthUserCommand,
  ): Promise<Either<AppInboxFailure, RegisterResponse>>;
  async processAuthCommandUntilCompletion(
    command: IssueAuthSessionCommand,
  ): Promise<Either<AppInboxFailure, LoginResponse>>;
  async processAuthCommandUntilCompletion(
    command: LogoutAuthSessionCommand,
  ): Promise<Either<AppInboxFailure, LogoutResponse>>;
  async processAuthCommandUntilCompletion(
    command: IssueAuthWsTicketCommand,
  ): Promise<Either<AppInboxFailure, WebSocketTicketResponse>>;
  async processAuthCommandUntilCompletion(
    command: ConsumeAuthWsTicketCommand,
  ): Promise<Either<AppInboxFailure, IssuedAuthSession>>;
  async processAuthCommandUntilCompletion(
    command: IssueAuthAgentTicketsCommand,
  ): Promise<Either<AppInboxFailure, AgentSessionTicketResponse>>;
  async processAuthCommandUntilCompletion(
    command: ConsumeAuthAgentTicketCommand,
  ): Promise<Either<AppInboxFailure, ConsumeAgentSessionTicketResponse>>;
  async processAuthCommandUntilCompletion(
    command: AuthMutationCommand,
  ): Promise<Either<AppInboxFailure, AuthMutationPublicResult>>;
  async processAuthCommandUntilCompletion(
    command: AuthMutationCommand,
  ): Promise<Either<AppInboxFailure, AuthMutationPublicResult>> {
    const decoded = decodeAuthMutationCommand(command);
    let persisted: Either<AppInboxFailure, AuthMutationResult>;
    try {
      persisted = await super.processEntryUntilCompletionResult<
        AuthMutationCommand,
        AuthMutationResult
      >(
        {
          type: toAuthAppInboxType(decoded),
          topicId: toAuthAppInboxType(decoded),
          resourceId: decoded.requestId,
          contextId: toAuthCommandContextId(decoded),
          senderId: toAuthCommandSenderId(decoded),
          data: decoded,
        },
        decodeAuthMutationResult,
      );
    } catch (error) {
      return Either.ofLeft(toTerminalAppInboxFailure(error, toAppInboxErrorCode(error)));
    }
    if (persisted.left !== undefined) return Either.ofLeft(persisted.left);
    if (persisted.right === undefined) throw new Error('Auth AppInbox result is missing');
    return Either.ofRight(
      await toAuthMutationPublicResult(decoded, persisted.right, this.credentialIssuer),
    );
  }

  async registerUser(
    input:
      & AppAuthInboxService.RequestIdentity
      & Readonly<{
        request: RegisterRequest;
        staticClients?: readonly LoginClientData[];
      }>,
  ): Promise<Either<AppInboxFailure, RegisterResponse>> {
    const normalizedUsername = readNormalizedUsername(input.request.username);
    const reserved = await this.reserveAuthCommand(
      {
        type: AppInboxType.AUTH_USER_REGISTER,
        requestId: input.requestId,
        contextId: toAuthUsernameContextId('register-user', normalizedUsername),
        senderId: normalizedUsername,
      },
      async () => {
        const capturedAtEpochMs = this.authFactNowEpochMs();
        const user = await prepareAuthUserRegistration(
          input.request,
          {
            clientId: await toAuthServiceDeterministicId(
              'user',
              input.requestId,
              normalizedUsername,
            ),
            capturedAtEpochMs,
            passwordSaltSeed: `auth-registration:${input.requestId}:${normalizedUsername}`,
          },
          input.staticClients,
        );
        return {
          version: 1,
          kind: 'register-user',
          requestId: input.requestId,
          capturedAtEpochMs,
          user,
        };
      },
      async (command) =>
        command.kind === 'register-user' &&
        command.user.normalizedUsername === normalizedUsername &&
        command.user.username === input.request.username.trim() &&
        command.user.displayName === readRegistrationDisplayName(input.request.displayName) &&
        await verifyAuthUserPassword(input.request.password, command.user),
    );
    if (reserved.left !== undefined) return Either.ofLeft(reserved.left);
    return await this.processAuthCommandUntilCompletion(
      requireReservedCommand(reserved, 'register-user'),
    );
  }

  async issueSession(
    input:
      & AppAuthInboxService.RequestIdentity
      & Readonly<{
        clientId: string;
        username: string;
        ttlMs: number;
        authority: IssueAuthSessionCommand['authority'];
      }>,
  ): Promise<Either<AppInboxFailure, LoginResponse>> {
    const reserved = await this.reserveAuthCommand(
      {
        type: AppInboxType.AUTH_SESSION_ISSUE,
        requestId: input.requestId,
        contextId: toAuthUsernameContextId(
          'issue-session',
          input.authority.normalizedUsername,
        ),
        senderId: input.clientId,
      },
      async () => {
        const capturedAtEpochMs = this.authFactNowEpochMs();
        const sessionId = await toAuthServiceDeterministicId(
          'session',
          input.requestId,
          input.authority.normalizedUsername,
          input.clientId,
        );
        const accessToken = await this.credentialIssuer.issueAccessToken(sessionId);
        return {
          version: 1,
          kind: 'issue-session',
          requestId: input.requestId,
          capturedAtEpochMs,
          authority: input.authority,
          session: {
            clientId: input.clientId,
            username: input.username,
            sessionId,
            accessTokenDigest: await hashAuthSecret(accessToken),
            issuedAtEpochMs: capturedAtEpochMs,
            expiresAtEpochMs: capturedAtEpochMs + input.ttlMs,
          },
        };
      },
      (command) =>
        command.kind === 'issue-session' &&
        command.session.clientId === input.clientId &&
        command.session.username === input.username &&
        command.authority.kind === input.authority.kind &&
        command.authority.clientId === input.authority.clientId &&
        command.authority.normalizedUsername === input.authority.normalizedUsername &&
        (command.authority.kind !== 'registered-user' ||
          input.authority.kind !== 'registered-user' ||
          command.authority.userRevision === input.authority.userRevision) &&
        command.session.expiresAtEpochMs - command.session.issuedAtEpochMs === input.ttlMs,
    );
    if (reserved.left !== undefined) return Either.ofLeft(reserved.left);
    return await this.processAuthCommandUntilCompletion(
      requireReservedCommand(reserved, 'issue-session'),
    );
  }

  async logoutSession(
    input: AppAuthInboxService.RequestIdentity & Readonly<{ session: IssuedAuthSession }>,
  ): Promise<Either<AppInboxFailure, LogoutResponse>> {
    const reserved = await this.reserveAuthCommand(
      {
        type: AppInboxType.AUTH_SESSION_LOGOUT,
        requestId: input.requestId,
        contextId: toAuthSessionContextId(input.session.clientId, input.session.sessionId),
        senderId: input.session.clientId,
      },
      async () => ({
        version: 1,
        kind: 'logout-session',
        requestId: input.requestId,
        capturedAtEpochMs: this.authFactNowEpochMs(),
        expected: {
          clientId: input.session.clientId,
          username: input.session.username,
          sessionId: input.session.sessionId,
          accessTokenDigest: await hashAuthSecret(input.session.accessToken),
          issuedAtEpochMs: input.session.issuedAtEpochMs,
          expiresAtEpochMs: input.session.expiresAtEpochMs,
        },
      }),
      async (command) =>
        command.kind === 'logout-session' &&
        command.expected.clientId === input.session.clientId &&
        command.expected.sessionId === input.session.sessionId &&
        constantTimeAuthDigestEqual(
          command.expected.accessTokenDigest,
          await hashAuthSecret(input.session.accessToken),
        ),
    );
    if (reserved.left !== undefined) return Either.ofLeft(reserved.left);
    return await this.processAuthCommandUntilCompletion(
      requireReservedCommand(reserved, 'logout-session'),
    );
  }

  async replayLogoutSessionWithCredentialProof(
    input: Readonly<{
      requestId: string;
      clientId: string;
      accessToken: string;
    }>,
  ): Promise<Either<AppInboxFailure, LogoutResponse> | null> {
    const presentedDigest = await hashAuthSecret(input.accessToken);
    const entries = await this.authInboxRepository.findAllByTopicAndResourceId(
      AppInboxType.AUTH_SESSION_LOGOUT,
      input.requestId,
    );
    const matchingCommands: LogoutAuthSessionCommand[] = [];
    for (const entry of entries) {
      const command = readAuthReplayCommand(entry, AppInboxType.AUTH_SESSION_LOGOUT);
      if (command === null) {
        constantTimeAuthDigestEqual(presentedDigest, '0'.repeat(43));
        continue;
      }
      const proofMatches = constantTimeAuthDigestEqual(
        presentedDigest,
        command?.kind === 'logout-session' ? command.expected.accessTokenDigest : '0'.repeat(43),
      );
      if (
        proofMatches &&
        command?.kind === 'logout-session' &&
        command.expected.clientId === input.clientId
      ) {
        matchingCommands.push(command);
      }
    }
    if (matchingCommands.length !== 1) {
      return null;
    }
    return await this.processAuthCommandUntilCompletion(matchingCommands[0]);
  }

  async issueWebSocketTicket(
    input:
      & AppAuthInboxService.RequestIdentity
      & Readonly<{
        session: IssuedAuthSession;
        ttlMs: number;
      }>,
  ): Promise<Either<AppInboxFailure, WebSocketTicketResponse>> {
    const reserved = await this.reserveAuthCommand(
      {
        type: AppInboxType.AUTH_WS_TICKET_ISSUE,
        requestId: input.requestId,
        contextId: toAuthSessionContextId(input.session.clientId, input.session.sessionId),
        senderId: input.session.clientId,
      },
      async () => {
        const capturedAtEpochMs = this.authFactNowEpochMs();
        const ticket = await this.credentialIssuer.issueWebSocketTicket(
          input.requestId,
          input.session.sessionId,
        );
        return {
          version: 1,
          kind: 'issue-ws-ticket',
          requestId: input.requestId,
          capturedAtEpochMs,
          ticketRecord: {
            ticketDigest: await hashAuthSecret(ticket),
            accessTokenDigest: await hashAuthSecret(input.session.accessToken),
            sessionId: input.session.sessionId,
            clientId: input.session.clientId,
            issuedAtEpochMs: capturedAtEpochMs,
            expiresAtEpochMs: capturedAtEpochMs + input.ttlMs,
          },
        };
      },
      async (command) =>
        command.kind === 'issue-ws-ticket' &&
        command.ticketRecord.clientId === input.session.clientId &&
        command.ticketRecord.sessionId === input.session.sessionId &&
        command.ticketRecord.expiresAtEpochMs - command.ticketRecord.issuedAtEpochMs ===
          input.ttlMs &&
        constantTimeAuthDigestEqual(
          command.ticketRecord.accessTokenDigest,
          await hashAuthSecret(input.session.accessToken),
        ),
    );
    if (reserved.left !== undefined) return Either.ofLeft(reserved.left);
    return await this.processAuthCommandUntilCompletion(
      requireReservedCommand(reserved, 'issue-ws-ticket'),
    );
  }

  async consumeWebSocketTicket(
    input:
      & AppAuthInboxService.RequestIdentity
      & Readonly<{
        ticket: string;
        expectedSessionId: string;
      }>,
  ): Promise<Either<AppInboxFailure, IssuedAuthSession>> {
    const ticketDigest = await hashAuthSecret(input.ticket);
    const reserved = await this.reserveAuthCommand(
      {
        type: AppInboxType.AUTH_WS_TICKET_CONSUME,
        requestId: input.requestId,
        contextId: toAuthCredentialContextId(ticketDigest),
        senderId: ticketDigest,
      },
      async () => ({
        version: 1,
        kind: 'consume-ws-ticket',
        requestId: input.requestId,
        capturedAtEpochMs: this.authFactNowEpochMs(),
        ticketDigest,
        expectedSessionId: input.expectedSessionId,
      }),
      (command) =>
        command.kind === 'consume-ws-ticket' &&
        command.ticketDigest === ticketDigest &&
        command.expectedSessionId === input.expectedSessionId,
    );
    if (reserved.left !== undefined) return Either.ofLeft(reserved.left);
    return await this.processAuthCommandUntilCompletion(
      requireReservedCommand(reserved, 'consume-ws-ticket'),
    );
  }

  async issueAgentSessionTickets(
    input:
      & AppAuthInboxService.RequestIdentity
      & Readonly<{
        session: IssuedAuthSession;
        ticketTtlMs: number;
        agents: readonly Readonly<{ agentId: string }>[];
      }>,
  ): Promise<Either<AppInboxFailure, AgentSessionTicketResponse>> {
    const reserved = await this.reserveAuthCommand(
      {
        type: AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
        requestId: input.requestId,
        contextId: toAuthSessionContextId(input.session.clientId, input.session.sessionId),
        senderId: input.session.clientId,
      },
      async () => {
        const capturedAtEpochMs = this.authFactNowEpochMs();
        const tickets = await Promise.all(
          input.agents.map(async (agent) => {
            const sessionId = await toAuthServiceDeterministicId(
              'agent-session',
              input.requestId,
              input.session.clientId,
              agent.agentId,
            );
            const accessToken = await this.credentialIssuer.issueAccessToken(sessionId);
            const ticket = await this.credentialIssuer.issueAgentTicket(
              input.requestId,
              agent.agentId,
              sessionId,
            );
            return {
              agentId: agent.agentId,
              sessionId,
              accessTokenDigest: await hashAuthSecret(accessToken),
              ticketDigest: await hashAuthSecret(ticket),
              clientId: input.session.clientId,
              username: input.session.username,
              issuedAtEpochMs: capturedAtEpochMs,
              sessionExpiresAtEpochMs: input.session.expiresAtEpochMs,
              ticketExpiresAtEpochMs: Math.min(
                input.session.expiresAtEpochMs,
                capturedAtEpochMs + input.ticketTtlMs,
              ),
            };
          }),
        );
        return {
          version: 1,
          kind: 'issue-agent-tickets',
          requestId: input.requestId,
          capturedAtEpochMs,
          authority: {
            clientId: input.session.clientId,
            username: input.session.username,
            sessionId: input.session.sessionId,
            accessTokenDigest: await hashAuthSecret(input.session.accessToken),
            issuedAtEpochMs: input.session.issuedAtEpochMs,
            expiresAtEpochMs: input.session.expiresAtEpochMs,
          },
          tickets,
        };
      },
      async (command) =>
        command.kind === 'issue-agent-tickets' &&
        command.tickets.map((ticket) => ticket.agentId).join('\u0000') ===
          input.agents.map((agent) => agent.agentId).join('\u0000') &&
        command.tickets.every((ticket) =>
          ticket.ticketExpiresAtEpochMs - ticket.issuedAtEpochMs ===
            Math.min(input.ticketTtlMs, input.session.expiresAtEpochMs - ticket.issuedAtEpochMs)
        ) &&
        constantTimeAuthDigestEqual(
          command.authority.accessTokenDigest,
          await hashAuthSecret(input.session.accessToken),
        ),
    );
    if (reserved.left !== undefined) return Either.ofLeft(reserved.left);
    return await this.processAuthCommandUntilCompletion(
      requireReservedCommand(reserved, 'issue-agent-tickets'),
    );
  }

  async consumeAgentSessionTicket(
    input: AppAuthInboxService.RequestIdentity & Readonly<{ ticket: string }>,
  ): Promise<Either<AppInboxFailure, ConsumeAgentSessionTicketResponse>> {
    const ticketDigest = await hashAuthSecret(input.ticket);
    const entries = await this.authInboxRepository.findAllByTopicAndResourceId(
      AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
      input.requestId,
    );
    const matchingCommands: ConsumeAuthAgentTicketCommand[] = [];
    for (const entry of entries) {
      const command = readAuthReplayCommand(
        entry,
        AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
      );
      const expectedDigest = command?.kind === 'consume-agent-ticket'
        ? command.ticketDigest
        : '0'.repeat(43);
      if (
        constantTimeAuthDigestEqual(ticketDigest, expectedDigest) &&
        command?.kind === 'consume-agent-ticket'
      ) {
        matchingCommands.push(command);
      }
    }
    if (matchingCommands.length === 1) {
      return await this.processAuthCommandUntilCompletion(matchingCommands[0]);
    }
    const reserved = await this.reserveAuthCommand(
      {
        type: AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
        requestId: input.requestId,
        contextId: toAuthCredentialContextId(ticketDigest),
        senderId: ticketDigest,
      },
      async () => ({
        version: 1,
        kind: 'consume-agent-ticket',
        requestId: input.requestId,
        capturedAtEpochMs: this.authFactNowEpochMs(),
        ticketDigest,
      }),
      (command) =>
        command.kind === 'consume-agent-ticket' && command.ticketDigest === ticketDigest,
    );
    if (reserved.left !== undefined) return Either.ofLeft(reserved.left);
    return await this.processAuthCommandUntilCompletion(
      requireReservedCommand(reserved, 'consume-agent-ticket'),
    );
  }

  private async reserveAuthCommand<C extends AuthMutationCommand>(
    reservation: AuthCommandReservation,
    materialize: () => Promise<C>,
    matches: (command: AuthMutationCommand) => boolean | Promise<boolean>,
  ): Promise<Either<AppInboxFailure, C>> {
    try {
      const placeholder = toAuthInboxEntry({
        type: reservation.type,
        topicId: reservation.type,
        resourceId: reservation.requestId,
        contextId: reservation.contextId,
        senderId: reservation.senderId,
        data: null,
      });
      const entry = await this.authInboxRepository
        .writeMaterializedIfAbsentOrReplaceExpired(
          placeholder,
          async () => toAuthInboxEntry(toAuthCommandEnqueue(await materialize())),
        );
      const command = readAuthReplayCommand(entry, reservation.type);
      if (!command || !(await matches(command))) {
        throw new AppInboxIdempotencyConflictError(
          reservation.requestId,
          'existing-auth-command',
          'received-auth-intent',
        );
      }
      return Either.ofRight(command as C);
    } catch (error) {
      return Either.ofLeft(toTerminalAppInboxFailure(error, toAppInboxErrorCode(error)));
    }
  }
}

interface AuthCommandReservation {
  readonly type: AppInboxType;
  readonly requestId: string;
  readonly contextId: string;
  readonly senderId: string;
}

function toAuthCommandEnqueue(
  command: AuthMutationCommand,
): AppInboxEnqueueInput<AuthMutationCommand> {
  return {
    type: toAuthAppInboxType(command),
    topicId: toAuthAppInboxType(command),
    resourceId: command.requestId,
    contextId: toAuthCommandContextId(command),
    senderId: toAuthCommandSenderId(command),
    data: command,
  };
}

function toAuthInboxEntry(
  enqueue: AppInboxEnqueueInput<AuthMutationCommand | null>,
): ResourceEntry {
  const wire = toJsonWireAppInboxEnqueue(enqueue);
  const key = toAppInboxQueueKey({
    topicId: wire.topicId!,
    contextId: wire.contextId!,
    resourceId: wire.resourceId!,
  });
  return QueueBoxUtilities.toResourceEntryFromMsg(
    newALUntargetedMessage(
      toAppInboxQueueCreatedBy('auth-fact-reservation'),
      newALRoute(key.topicId, key.contextId, key.resourceId),
      wire.type,
      wire,
    ),
    'APP_INBOX',
  );
}

function requireReservedCommand<K extends AuthMutationCommand['kind']>(
  reserved: Either<AppInboxFailure, AuthMutationCommand>,
  kind: K,
): Extract<AuthMutationCommand, { kind: K }> {
  if (reserved.right?.kind !== kind) {
    throw new Error(`Reserved auth command kind differs: ${kind}`);
  }
  return reserved.right as Extract<AuthMutationCommand, { kind: K }>;
}

function readNormalizedUsername(username: string): string {
  return username.trim().toLowerCase();
}

function readRegistrationDisplayName(displayName: string | undefined): string | null {
  return displayName?.trim() || null;
}

function readAuthReplayCommand(
  entry: ResourceEntry,
  operation: AppInboxType,
): AuthMutationCommand | null {
  const validation = validateAppInboxCommandIdentity(entry);
  if (!validation.valid || validation.identity.operation !== operation) {
    return null;
  }
  try {
    const command = decodeAuthMutationCommand(validation.command.data);
    const expectedKey = toAppQueueKey({
      topicId: toAuthAppInboxType(command),
      resourceId: command.requestId,
      contextId: toAuthCommandContextId(command),
    });
    return expectedKey.topicId === entry.key.topicId &&
        expectedKey.resourceId === entry.key.resourceId &&
        expectedKey.contextId === entry.key.contextId
      ? command
      : null;
  } catch {
    return null;
  }
}

async function toAuthServiceDeterministicId(
  kind: 'user' | 'session' | 'agent-session',
  ...identity: readonly string[]
): Promise<string> {
  const digest = await hashAuthSecret(JSON.stringify([kind, ...identity]));
  return `${kind}-${digest.slice(0, 24)}`;
}
