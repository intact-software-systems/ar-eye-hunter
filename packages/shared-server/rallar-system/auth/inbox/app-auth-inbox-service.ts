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
// prettier-ignore
import type {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
// prettier-ignore
import type {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type { AuthMutationService } from '../auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import type {
  AuthMutationCommand,
  AuthMutationPublicResult,
  AuthMutationResult,
  IssueAuthSessionCommand,
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

type AuthRequestFacts = Readonly<{
  requestId: string;
  capturedAtEpochMs: number;
}>;

const AUTH_TYPES = [
  AppInboxType.AUTH_USER_REGISTER,
  AppInboxType.AUTH_SESSION_ISSUE,
  AppInboxType.AUTH_SESSION_LOGOUT,
  AppInboxType.AUTH_WS_TICKET_ISSUE,
  AppInboxType.AUTH_WS_TICKET_CONSUME,
  AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
  AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
] as const;

export class AppAuthInboxService extends AppInboxService {
  private readonly authInboxHandler: AuthInboxHandler;

  public override readonly inbox: InboxQueueReader;
  public override readonly resourceInbox: ResourceInboxRepository;
  public override readonly resourceInboxResults: ResourceInboxResultsRepository;
  public readonly authMutationService: AuthMutationService;
  public readonly credentialIssuer: AuthCredentialIssuer;
  public override readonly serviceId: string;

  constructor(
    inbox: InboxQueueReader,
    resourceInbox: ResourceInboxRepository,
    resourceInboxResults: ResourceInboxResultsRepository,
    database: PSqlSql,
    authMutationService: AuthMutationService,
    credentialIssuer: AuthCredentialIssuer,
    serviceId: string,
    timing?: RallarTimingSink,
    options?: AppInboxServiceOptions,
    wakeQueue?: () => void,
  ) {
    super(
      inbox,
      resourceInbox,
      resourceInboxResults,
      database,
      serviceId,
      AUTH_STATE_APP_INBOX_TOPIC,
      timing,
      options,
      wakeQueue,
    );
    this.inbox = inbox;
    this.resourceInbox = resourceInbox;
    this.resourceInboxResults = resourceInboxResults;
    this.authMutationService = authMutationService;
    this.credentialIssuer = credentialIssuer;
    this.serviceId = serviceId;
    this.authInboxHandler = new AuthInboxHandler({
      mutationService: authMutationService,
      credentialIssuer,
      transactionWriter: this.transactionWriter,
    });
    for (const type of AUTH_TYPES) {
      this.onStateMessage<unknown>(
        type,
        async (command, context) =>
          await this.authInboxHandler.processAuthMutation(command, context),
      );
    }
  }

  async processAuthCommandUntilCompletion<R extends AuthMutationPublicResult>(
    command: AuthMutationCommand,
  ): Promise<Either<AppInboxFailure, R>> {
    const decoded = decodeAuthMutationCommand(command);
    let persisted: Either<AppInboxFailure, AuthMutationResult>;
    try {
      persisted = await super.processEntryUntilCompletionResult<
        AuthMutationCommand,
        AuthMutationResult
      >({
        type: toAuthAppInboxType(decoded),
        topicId: AUTH_STATE_APP_INBOX_TOPIC,
        resourceId: decoded.requestId,
        contextId: toAuthCommandContextId(decoded),
        senderId: toAuthCommandSenderId(decoded),
        data: decoded,
      });
    } catch (error) {
      return Either.ofLeft(toTerminalAppInboxFailure(error, toAppInboxErrorCode(error)));
    }
    if (persisted.left !== undefined) return Either.ofLeft(persisted.left);
    if (persisted.right === undefined) throw new Error('Auth AppInbox result is missing');
    return Either.ofRight(
      (await toAuthMutationPublicResult(
        decoded,
        decodeAuthMutationResult(persisted.right),
        this.credentialIssuer,
      )) as R,
    );
  }

  async registerUser(
    input: AuthRequestFacts & Readonly<{ user: AuthUser }>,
  ): Promise<Either<AppInboxFailure, RegisterResponse>> {
    return await this.processAuthCommandUntilCompletion({
      version: 1,
      kind: 'register-user',
      ...input,
    });
  }

  async issueSession(
    input: AuthRequestFacts &
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
    input: AuthRequestFacts & Readonly<{ session: IssuedAuthSession }>,
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
    input: AuthRequestFacts &
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
    input: AuthRequestFacts &
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
    input: AuthRequestFacts &
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
    input: AuthRequestFacts & Readonly<{ ticket: string }>,
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
