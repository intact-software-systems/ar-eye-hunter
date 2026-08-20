import type {
  AgentSessionTicketResponse,
  ConsumeAgentSessionTicketResponse,
  LoginResponse,
  LogoutResponse,
  RegisterResponse,
  WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { AuthMutationService } from '../auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
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
import { AppInboxService, type AppInboxServiceOptions } from '../../services/AppInboxService.ts';
import { AppInboxType } from '../../services/app-inbox-contracts.ts';
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
} from './auth-app-inbox-routing.ts';
import { AuthInboxHandler } from './auth-inbox-handler.ts';

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
    readonly resourceInboxRepository: AppInboxService.InboxRepository;
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
  }

  export interface RequestFacts {
    readonly requestId: string;
    readonly capturedAtEpochMs: number;
  }
}

export class AppAuthInboxService extends AppInboxService {
  private readonly authInboxHandler: AuthInboxHandler;

  public readonly authMutationService: AuthMutationService;
  public readonly credentialIssuer: AuthCredentialIssuer;

  constructor(dependencies: AppAuthInboxService.Dependencies, config: AppAuthInboxService.Config) {
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
          topicId: AUTH_STATE_APP_INBOX_TOPIC,
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
    input: AppAuthInboxService.RequestFacts & Readonly<{ user: AuthUser }>,
  ): Promise<Either<AppInboxFailure, RegisterResponse>> {
    return await this.processAuthCommandUntilCompletion({
      version: 1,
      kind: 'register-user',
      ...input,
    });
  }

  async issueSession(
    input: AppAuthInboxService.RequestFacts &
      Readonly<{
        clientId: string;
        username: string;
        sessionId: string;
        expiresAtEpochMs: number;
        authority: IssueAuthSessionCommand['authority'];
      }>,
  ): Promise<Either<AppInboxFailure, LoginResponse>> {
    const accessToken = await this.credentialIssuer.issueAccessToken(input.sessionId);
    return await this.processAuthCommandUntilCompletion({
      version: 1,
      kind: 'issue-session',
      requestId: input.requestId,
      capturedAtEpochMs: input.capturedAtEpochMs,
      authority: input.authority,
      session: {
        clientId: input.clientId,
        username: input.username,
        sessionId: input.sessionId,
        accessTokenDigest: await hashAuthSecret(accessToken),
        issuedAtEpochMs: input.capturedAtEpochMs,
        expiresAtEpochMs: input.expiresAtEpochMs,
      },
    });
  }

  async logoutSession(
    input: AppAuthInboxService.RequestFacts & Readonly<{ session: IssuedAuthSession }>,
  ): Promise<Either<AppInboxFailure, LogoutResponse>> {
    return await this.processAuthCommandUntilCompletion({
      version: 1,
      kind: 'logout-session',
      requestId: input.requestId,
      capturedAtEpochMs: input.capturedAtEpochMs,
      expected: {
        clientId: input.session.clientId,
        username: input.session.username,
        sessionId: input.session.sessionId,
        accessTokenDigest: await hashAuthSecret(input.session.accessToken),
        issuedAtEpochMs: input.session.issuedAtEpochMs,
        expiresAtEpochMs: input.session.expiresAtEpochMs,
      },
    });
  }

  async issueWebSocketTicket(
    input: AppAuthInboxService.RequestFacts &
      Readonly<{
        session: IssuedAuthSession;
        expiresAtEpochMs: number;
      }>,
  ): Promise<Either<AppInboxFailure, WebSocketTicketResponse>> {
    const ticket = await this.credentialIssuer.issueWebSocketTicket(
      input.requestId,
      input.session.sessionId,
    );
    return await this.processAuthCommandUntilCompletion({
      version: 1,
      kind: 'issue-ws-ticket',
      requestId: input.requestId,
      capturedAtEpochMs: input.capturedAtEpochMs,
      ticketRecord: {
        ticketDigest: await hashAuthSecret(ticket),
        accessTokenDigest: await hashAuthSecret(input.session.accessToken),
        sessionId: input.session.sessionId,
        clientId: input.session.clientId,
        issuedAtEpochMs: input.capturedAtEpochMs,
        expiresAtEpochMs: input.expiresAtEpochMs,
      },
    });
  }

  async consumeWebSocketTicket(
    input: AppAuthInboxService.RequestFacts &
      Readonly<{
        ticket: string;
        expectedSessionId: string;
      }>,
  ): Promise<Either<AppInboxFailure, IssuedAuthSession>> {
    return await this.processAuthCommandUntilCompletion({
      version: 1,
      kind: 'consume-ws-ticket',
      requestId: input.requestId,
      capturedAtEpochMs: input.capturedAtEpochMs,
      ticketDigest: await hashAuthSecret(input.ticket),
      expectedSessionId: input.expectedSessionId,
    });
  }

  async issueAgentSessionTickets(
    input: AppAuthInboxService.RequestFacts &
      Readonly<{
        session: IssuedAuthSession;
        sessionExpiresAtEpochMs: number;
        ticketExpiresAtEpochMs: number;
        agents: readonly Readonly<{ agentId: string; sessionId: string }>[];
      }>,
  ): Promise<Either<AppInboxFailure, AgentSessionTicketResponse>> {
    const tickets = await Promise.all(
      input.agents.map(async (agent) => {
        const accessToken = await this.credentialIssuer.issueAccessToken(agent.sessionId);
        const ticket = await this.credentialIssuer.issueAgentTicket(
          input.requestId,
          agent.agentId,
          agent.sessionId,
        );
        return {
          agentId: agent.agentId,
          sessionId: agent.sessionId,
          accessTokenDigest: await hashAuthSecret(accessToken),
          ticketDigest: await hashAuthSecret(ticket),
          clientId: input.session.clientId,
          username: input.session.username,
          issuedAtEpochMs: input.capturedAtEpochMs,
          sessionExpiresAtEpochMs: input.sessionExpiresAtEpochMs,
          ticketExpiresAtEpochMs: input.ticketExpiresAtEpochMs,
        };
      }),
    );
    return await this.processAuthCommandUntilCompletion({
      version: 1,
      kind: 'issue-agent-tickets',
      requestId: input.requestId,
      capturedAtEpochMs: input.capturedAtEpochMs,
      authority: {
        clientId: input.session.clientId,
        username: input.session.username,
        sessionId: input.session.sessionId,
        accessTokenDigest: await hashAuthSecret(input.session.accessToken),
        issuedAtEpochMs: input.session.issuedAtEpochMs,
        expiresAtEpochMs: input.session.expiresAtEpochMs,
      },
      tickets,
    });
  }

  async consumeAgentSessionTicket(
    input: AppAuthInboxService.RequestFacts & Readonly<{ ticket: string }>,
  ): Promise<Either<AppInboxFailure, ConsumeAgentSessionTicketResponse>> {
    return await this.processAuthCommandUntilCompletion({
      version: 1,
      kind: 'consume-agent-ticket',
      requestId: input.requestId,
      capturedAtEpochMs: input.capturedAtEpochMs,
      ticketDigest: await hashAuthSecret(input.ticket),
    });
  }
}
