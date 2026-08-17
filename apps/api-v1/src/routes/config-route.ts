import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';
import {
  AgentSessionTicketRequest,
  AgentSessionTicketResponse,
  ConsumeAgentSessionTicketRequest,
  ConsumeAgentSessionTicketResponse,
  LoginRequest,
  LogoutResponse,
  RegisterRequest,
  RegisterResponse,
  WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import { readRateLimiter, readRequestClientKey } from '@shared-server/http/rate-limit-service.ts';
import { signRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import type {
  AppAuthInboxService,
} from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import type {
  AuthUserRepository,
} from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type {
  LoginClientData,
} from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';
import type { Either } from '@shared/resilience/Either.ts';

import * as apiLoginService from '../services/api-login-service.ts';
import { toAuthErrorResponse } from '../services/request-auth-service.ts';

const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WS_AUTH_TICKET_TTL_MS = 30_000;
const AGENT_SESSION_TICKET_TTL_MS = 60_000;
const BLACK_BOX_OPERATOR_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_IP_RATE_LIMIT = new RateLimiterPolicy(
  60_000,
  readPositiveIntegerEnv('RALLAR_LOGIN_IP_RATE_LIMIT', 30),
);
const LOGIN_USER_RATE_LIMIT = new RateLimiterPolicy(
  60_000,
  readPositiveIntegerEnv('RALLAR_LOGIN_USER_RATE_LIMIT', 5),
);
const REGISTER_IP_RATE_LIMIT = new RateLimiterPolicy(60_000, 20);
const REGISTER_USER_RATE_LIMIT = new RateLimiterPolicy(60_000, 5);
const WS_TICKET_RATE_LIMIT = new RateLimiterPolicy(60_000, 30);

export interface ConfigRouteDependencies {
  readonly requireApiAuthSession: (
    req: { header(name: string): string | undefined },
  ) => Promise<IssuedAuthSession>;
  readonly readEnv: (name: string) => string | undefined;
  readonly now: () => number;
  readonly createTokenId: () => string;
  readonly appAuthInbox: Pick<
    AppAuthInboxService,
    | 'registerUser'
    | 'issueSession'
    | 'logoutSession'
    | 'issueWebSocketTicket'
    | 'issueAgentSessionTickets'
    | 'consumeAgentSessionTicket'
  >;
  readonly authUserRepository: AuthUserRepository;
  readonly staticClients: readonly LoginClientData[];
  readonly registrationMode: 'public' | 'admin';
  readonly adminClientIds: ReadonlySet<string>;
}

export function registerConfigRoutes(
  app: Hono,
  dependencies: ConfigRouteDependencies,
): void {
  const deps = dependencies;

  app.get(
    '/api/config',
    async (c) => c.json(await readApiConfiguration()),
  );

  app.post(
    '/api/auth/login',
    (context) => issueLoginResponse(context, deps),
  );

  app.post(
    '/api/auth/register',
    (context) => registerUserResponse(context, deps),
  );

  app.post(
    '/api/auth/logout',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        return toJsonResponse(
          requireAuthMutationResult(
            await deps.appAuthInbox.logoutSession({
              requestId: deps.createTokenId(),
              capturedAtEpochMs: deps.now(),
              session: authSession,
            }),
          ) satisfies LogoutResponse,
        );
      } catch (error) {
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/auth/ws-ticket',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);

        return await RateLimiter.tryToExecuteOrDefault<Response>(
          readRateLimiter('auth-ws-ticket', authSession.sessionId, WS_TICKET_RATE_LIMIT),
          async () => {
            const issuedAtEpochMs = Date.now();
            return toJsonResponse<WebSocketTicketResponse>(
              requireAuthMutationResult(
                await deps.appAuthInbox.issueWebSocketTicket({
                  requestId: deps.createTokenId(),
                  capturedAtEpochMs: issuedAtEpochMs,
                  session: authSession,
                  expiresAtEpochMs: issuedAtEpochMs + WS_AUTH_TICKET_TTL_MS,
                }),
              ),
            );
          },
          toJsonResponse({ error: 'Too many websocket ticket requests' }, 429),
        );
      } catch (error) {
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/auth/agent-session-tickets',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const request = await c.req.json() as AgentSessionTicketRequest;
        const agentIds = readAgentSessionTicketAgentIds(request);
        const issuedAtEpochMs = deps.now();
        const ticketExpiresAtEpochMs = Math.min(
          authSession.expiresAtEpochMs,
          issuedAtEpochMs + AGENT_SESSION_TICKET_TTL_MS,
        );
        const sessionExpiresAtEpochMs = authSession.expiresAtEpochMs;
        return toJsonResponse<AgentSessionTicketResponse>(requireAuthMutationResult(
          await deps.appAuthInbox.issueAgentSessionTickets({
            requestId: deps.createTokenId(),
            capturedAtEpochMs: issuedAtEpochMs,
            session: authSession,
            sessionExpiresAtEpochMs,
            ticketExpiresAtEpochMs,
            agents: agentIds.map((agentId) => ({
              agentId,
              sessionId: `${agentId}-${deps.createTokenId()}`,
            })),
          }),
        ));
      } catch (error) {
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/auth/agent-session-tickets/consume',
    async (c) => {
      try {
        const request = await c.req.json() as ConsumeAgentSessionTicketRequest;
        const ticket = typeof request.ticket === 'string' ? request.ticket.trim() : '';
        if (!ticket) {
          return toJsonResponse({ error: 'Agent session ticket is required.' }, 400);
        }

        return toJsonResponse(
          requireAuthMutationResult(
            await deps.appAuthInbox.consumeAgentSessionTicket({
              requestId: deps.createTokenId(),
              capturedAtEpochMs: deps.now(),
              ticket,
            }),
          ) satisfies ConsumeAgentSessionTicketResponse,
        );
      } catch (error) {
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/black-box/control-token',
    (context) => issueBlackBoxControlTokenResponse(context, deps),
  );
}

async function issueLoginResponse(
  context: Context,
  dependencies: ConfigRouteDependencies,
): Promise<Response> {
  try {
    const clientKey = readRequestClientKey(context.req);
    return await RateLimiter.tryToExecuteOrDefault<Response>(
      readRateLimiter('auth-login-ip', clientKey, LOGIN_IP_RATE_LIMIT),
      async () => {
        const loginRequest = await context.req.json() as LoginRequest;
        return await RateLimiter.tryToExecuteOrDefault<Response>(
          readRateLimiter(
            'auth-login-user',
            `${clientKey}:${loginRequest.username ?? ''}`,
            LOGIN_USER_RATE_LIMIT,
          ),
          () => issueLoginSession(loginRequest, dependencies),
          toJsonResponse({ error: 'Too many login attempts for this user' }, 429),
        );
      },
      toJsonResponse({ error: 'Too many login attempts' }, 429),
    );
  } catch (error) {
    return toAuthRouteErrorResponse(context, error);
  }
}

async function issueLoginSession(
  request: LoginRequest,
  dependencies: ConfigRouteDependencies,
): Promise<Response> {
  const loginResponse = await apiLoginService.login({
    request,
    userRepository: dependencies.authUserRepository,
    staticClients: dependencies.staticClients,
  });
  if (!loginResponse) {
    return toJsonResponse({ error: 'Invalid username or password' }, 401);
  }

  const issuedAtEpochMs = dependencies.now();
  return toJsonResponse(requireAuthMutationResult(
    await dependencies.appAuthInbox.issueSession({
      requestId: dependencies.createTokenId(),
      capturedAtEpochMs: issuedAtEpochMs,
      clientId: loginResponse.clientId,
      username: loginResponse.username,
      authority: loginResponse.authority,
      sessionId: dependencies.createTokenId(),
      expiresAtEpochMs: issuedAtEpochMs + AUTH_SESSION_TTL_MS,
    }),
  ));
}

async function registerUserResponse(
  context: Context,
  dependencies: ConfigRouteDependencies,
): Promise<Response> {
  try {
    const clientKey = readRequestClientKey(context.req);
    return await RateLimiter.tryToExecuteOrDefault<Response>(
      readRateLimiter('auth-register-ip', clientKey, REGISTER_IP_RATE_LIMIT),
      async () => {
        const request = await context.req.json() as RegisterRequest;
        return await RateLimiter.tryToExecuteOrDefault<Response>(
          readRateLimiter(
            'auth-register-user',
            `${clientKey}:${request.username ?? ''}`,
            REGISTER_USER_RATE_LIMIT,
          ),
          () => registerUserThroughAppInbox(context, request, dependencies),
          toJsonResponse({ error: 'Too many registration attempts for this user' }, 429),
        );
      },
      toJsonResponse({ error: 'Too many registration attempts' }, 429),
    );
  } catch (error) {
    return toAuthRouteErrorResponse(context, error);
  }
}

async function registerUserThroughAppInbox(
  context: Context,
  request: RegisterRequest,
  dependencies: ConfigRouteDependencies,
): Promise<Response> {
  await requireRegistrationAdminIfNeeded(context.req, dependencies);
  const capturedAtEpochMs = dependencies.now();
  const registerResponse = await apiLoginService.register({
    request,
    staticClients: dependencies.staticClients,
    capturedAtEpochMs,
    clientId: dependencies.createTokenId(),
  });
  return toJsonResponse<RegisterResponse>(
    requireAuthMutationResult(
      await dependencies.appAuthInbox.registerUser({
        requestId: dependencies.createTokenId(),
        capturedAtEpochMs: registerResponse.createdAtEpochMs,
        user: registerResponse,
      }),
    ),
    201,
  );
}

async function issueBlackBoxControlTokenResponse(
  context: Context,
  dependencies: ConfigRouteDependencies,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const allowlist = readCsvSet(
      dependencies.readEnv('RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS'),
    );
    if (allowlist.size > 0 && !allowlist.has(authSession.clientId)) {
      throw new Error(
        'Forbidden: black-box operator token is not allowed for this client',
      );
    }

    const secret = dependencies.readEnv('RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET')
      ?.trim();
    if (!secret) {
      return toJsonResponse(
        { error: 'Black-box operator token broker is not configured.' },
        503,
      );
    }

    const ttlMs = readPositiveIntegerFromEnv(
      dependencies.readEnv,
      'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS',
      BLACK_BOX_OPERATOR_TOKEN_DEFAULT_TTL_MS,
    );
    const issuedAtEpochMs = dependencies.now();
    const expiresAtEpochMs = issuedAtEpochMs + ttlMs;
    const token = await signRallarBlackBoxOperatorToken({
      secret,
      subject: authSession.username || authSession.clientId,
      sessionId: authSession.sessionId,
      issuedAtEpochMs,
      expiresAtEpochMs,
      tokenId: dependencies.createTokenId(),
    });
    return toJsonResponse(
      {
        tokenType: 'Bearer',
        token,
        issuedAtEpochMs,
        expiresAtEpochMs,
        ttlMs,
      } as const,
    );
  } catch (error) {
    return toAuthRouteErrorResponse(context, error);
  }
}

async function readApiConfiguration() {
  const configRepository = await import('../config-repo.ts');
  return configRepository.configuration;
}

async function requireRegistrationAdminIfNeeded(
  req: {
    header(name: string): string | undefined;
  },
  dependencies: ConfigRouteDependencies,
): Promise<void> {
  if (dependencies.registrationMode !== 'admin') {
    return;
  }

  const authSession = await dependencies.requireApiAuthSession(req);
  if (!dependencies.adminClientIds.has(authSession.clientId)) {
    throw new Error('Forbidden: admin auth session required to register users');
  }
}

function readAgentSessionTicketAgentIds(
  request: AgentSessionTicketRequest,
): readonly string[] {
  if (!Array.isArray(request.agentIds)) {
    throw new Error('Bad Request: agentIds must be a non-empty array');
  }

  const agentIds = request.agentIds
    .map((agentId) => typeof agentId === 'string' ? agentId.trim() : '')
    .filter((agentId) => agentId.length > 0);
  if (agentIds.length === 0) {
    throw new Error('Bad Request: agentIds must be a non-empty array');
  }
  if (agentIds.length > 6) {
    throw new Error('Bad Request: agentIds cannot contain more than 6 agents');
  }
  if (new Set(agentIds).size !== agentIds.length) {
    throw new Error('Bad Request: agentIds must be unique');
  }

  return agentIds;
}

function requireAuthMutationResult<R>(result: Either<AppInboxFailure, R>): R {
  if (result.right !== undefined) return result.right;
  const failure = result.left;
  if (!failure) throw new Error('Auth mutation result is unavailable');
  throw new AuthMutationRouteError(failure.message, failure.status);
}

class AuthMutationRouteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'AuthMutationRouteError';
  }
}

function toJsonResponse<T>(data: T, status = 200): Response {
  return Response.json(data, { status, headers: { 'content-type': 'application/json' } });
}

function toAuthRouteErrorResponse(
  c: {
    json(value: unknown, status?: number): Response;
  },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AuthMutationRouteError) {
    return c.json({ error: message }, error.status);
  }
  if (message.includes('already exists')) {
    return c.json({ error: message }, 409);
  }
  if (message.startsWith('Bad Request:')) {
    return c.json({ error: message }, 400);
  }
  if (message.startsWith('Forbidden:')) {
    return c.json({ error: message }, 403);
  }

  return toAuthErrorResponse(c, error);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  return readPositiveIntegerFromEnv(
    readDenoEnv,
    name,
    fallback,
  );
}

function readDenoEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function readPositiveIntegerFromEnv(
  readEnv: (name: string) => string | undefined,
  name: string,
  fallback: number,
): number {
  const raw = readEnv(name)?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function readCsvSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}
