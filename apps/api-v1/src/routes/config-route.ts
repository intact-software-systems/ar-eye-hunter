import { Hono } from 'jsr:@hono/hono@4.11.9';
import {
  type AuthSession,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  RegisterRequest,
  RegisterResponse,
  WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import { configuration } from '../config-repo.ts';
import * as loginRepository from '../repository/login-repository.ts';
import { createAuthSessionRepository } from '../repository/createStateRepositories.ts';
import {
  requireApiAuthSession,
  toAuthErrorResponse,
  toAuthSession,
} from '../services/request-auth-service.ts';
import { readRateLimiter, readRequestClientKey } from '@shared-server/http/rate-limit-service.ts';
import { signRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import { getMiddleware, type Middleware } from '../middleware.ts';

const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WS_AUTH_TICKET_TTL_MS = 30_000;
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

const REGISTRATION_MODE = (
  Deno.env.get('AUTH_REGISTRATION_MODE') ?? 'public'
).toLowerCase();

const ADMIN_CLIENT_IDS = new Set(
  (Deno.env.get('AUTH_ADMIN_CLIENT_IDS') ?? 'admin')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);

type BlackBoxControlTokenAuthSession = Pick<
  AuthSession,
  'clientId' | 'username' | 'sessionId'
>;

export type ConfigRouteDependencies = Readonly<{
  requireApiAuthSession?: (
    req: { header(name: string): string | undefined },
  ) => Promise<BlackBoxControlTokenAuthSession>;
  readEnv?: (name: string) => string | undefined;
  now?: () => number;
  createTokenId?: () => string;
}>;

type ResolvedConfigRouteDependencies = Required<ConfigRouteDependencies>;

export function init(
  app: Hono,
  dependencies: ConfigRouteDependencies = {},
) {
  const deps = resolveConfigRouteDependencies(dependencies);

  app.get(
    '/api/config',
    (c) => c.json(configuration),
  );

  app.post(
    '/api/auth/login',
    async (c) => {
      try {
        const clientKey = readRequestClientKey(c.req);

        return await RateLimiter.tryToExecuteOrDefault<Response>(
          readRateLimiter('auth-login-ip', clientKey, LOGIN_IP_RATE_LIMIT),
          async () => {
            const loginRequest = await c.req.json() as LoginRequest;

            return await RateLimiter.tryToExecuteOrDefault<Response>(
              readRateLimiter(
                'auth-login-user',
                `${clientKey}:${loginRequest.username ?? ''}`,
                LOGIN_USER_RATE_LIMIT,
              ),
              async () => {
                const loginResponse = await loginRepository.login(loginRequest);

                if (!loginResponse) {
                  return toJsonResponse(
                    {
                      error: 'Invalid username or password',
                    },
                    401,
                  );
                }

                return toJsonResponse(
                  await issueAuthSession(loginResponse),
                );
              },
              toJsonResponse({ error: 'Too many login attempts for this user' }, 429),
            );
          },
          toJsonResponse({ error: 'Too many login attempts' }, 429),
        );
      } catch (error) {
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/auth/register',
    async (c) => {
      try {
        const clientKey = readRequestClientKey(c.req);

        return await RateLimiter.tryToExecuteOrDefault<Response>(
          readRateLimiter(
            'auth-register-ip',
            clientKey,
            REGISTER_IP_RATE_LIMIT,
          ),
          async () => {
            const registerRequest = await c.req.json() as RegisterRequest;

            return await RateLimiter.tryToExecuteOrDefault<Response>(
              readRateLimiter(
                'auth-register-user',
                `${clientKey}:${registerRequest.username ?? ''}`,
                REGISTER_USER_RATE_LIMIT,
              ),
              async () => {
                await requireRegistrationAdminIfNeeded(c.req);
                const registerResponse = await loginRepository.register(
                  registerRequest,
                );

                return toJsonResponse<RegisterResponse>(
                  registerResponse,
                  201,
                );
              },
              toJsonResponse({ error: 'Too many registration attempts for this user' }, 429),
            );
          },
          toJsonResponse({ error: 'Too many registration attempts' }, 429),
        );
      } catch (error) {
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/auth/logout',
    async (c) => {
      try {
        const authSession = await requireApiAuthSession(c.req);
        await createAuthSessionRepository().deleteSession(authSession);
        closeLiveAuthSessionSocket(authSession.sessionId);
        return toJsonResponse({ loggedOut: true } satisfies LogoutResponse);
      } catch (error) {
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/auth/ws-ticket',
    async (c) => {
      try {
        const authSession = await requireApiAuthSession(c.req);

        return await RateLimiter.tryToExecuteOrDefault<Response>(
          readRateLimiter('auth-ws-ticket', authSession.sessionId, WS_TICKET_RATE_LIMIT),
          async () => {
            const issuedAtEpochMs = Date.now();
            const ticket = toWebSocketTicket();
            const response: WebSocketTicketResponse = {
              ticket,
              sessionId: authSession.sessionId,
              expiresAtEpochMs: issuedAtEpochMs + WS_AUTH_TICKET_TTL_MS,
            };

            await createAuthSessionRepository().putWebSocketTicket({
              ...response,
              clientId: authSession.clientId,
              issuedAtEpochMs,
            });

            return toJsonResponse(response);
          },
          toJsonResponse({ error: 'Too many websocket ticket requests' }, 429),
        );
      } catch (error) {
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/black-box/control-token',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const allowlist = readCsvSet(
          deps.readEnv('RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS'),
        );
        if (
          allowlist.size > 0 &&
          !allowlist.has(authSession.clientId)
        ) {
          throw new Error(
            'Forbidden: black-box operator token is not allowed for this client',
          );
        }

        const secret = deps.readEnv('RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET')
          ?.trim();
        if (!secret) {
          return toJsonResponse(
            {
              error: 'Black-box operator token broker is not configured.',
            },
            503,
          );
        }

        const ttlMs = readPositiveIntegerFromEnv(
          deps.readEnv,
          'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS',
          BLACK_BOX_OPERATOR_TOKEN_DEFAULT_TTL_MS,
        );
        const issuedAtEpochMs = deps.now();
        const expiresAtEpochMs = issuedAtEpochMs + ttlMs;
        const token = await signRallarBlackBoxOperatorToken({
          secret,
          subject: authSession.username || authSession.clientId,
          sessionId: authSession.sessionId,
          issuedAtEpochMs,
          expiresAtEpochMs,
          tokenId: deps.createTokenId(),
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
        return toAuthRouteErrorResponse(c, error);
      }
    },
  );
}

export type CloseLiveAuthSessionSocketOptions = Readonly<{
  readMiddleware?: () => Middleware;
  logger?: Pick<Console, 'warn'>;
}>;

export function closeLiveAuthSessionSocket(
  sessionId: string,
  options: CloseLiveAuthSessionSocketOptions = {},
): void {
  const logger = options.logger ?? console;

  try {
    const middleware = options.readMiddleware?.() ?? getMiddleware();
    middleware.wsQBoxServerService.socket.closeConnection(
      sessionId,
      1000,
      'auth-logout',
    );
  } catch (error) {
    logger.warn(
      'Failed to close live websocket session after logout:',
      error,
    );
  }
}

async function issueAuthSession(
  loginResponse: Omit<LoginResponse, 'expiresAtEpochMs'>,
): Promise<LoginResponse> {
  const issuedAtEpochMs = Date.now();
  const issuedSession = {
    ...loginResponse,
    issuedAtEpochMs,
    expiresAtEpochMs: issuedAtEpochMs + AUTH_SESSION_TTL_MS,
  };

  await createAuthSessionRepository().putSession(issuedSession);

  return toAuthSession(issuedSession);
}

async function requireRegistrationAdminIfNeeded(
  req: {
    header(name: string): string | undefined;
  },
): Promise<void> {
  if (REGISTRATION_MODE !== 'admin') {
    return;
  }

  const authSession = await requireApiAuthSession(req);
  if (!ADMIN_CLIENT_IDS.has(authSession.clientId)) {
    throw new Error('Forbidden: admin auth session required to register users');
  }
}

function toWebSocketTicket(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

function resolveConfigRouteDependencies(
  dependencies: ConfigRouteDependencies,
): ResolvedConfigRouteDependencies {
  return {
    requireApiAuthSession: dependencies.requireApiAuthSession ?? requireApiAuthSession,
    readEnv: dependencies.readEnv ?? ((name) => Deno.env.get(name)),
    now: dependencies.now ?? (() => Date.now()),
    createTokenId: dependencies.createTokenId ?? (() => crypto.randomUUID()),
  };
}

function toJsonResponse<T>(data: T, status = 200): Response {
  return Response.json(
    data,
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function toAuthRouteErrorResponse(
  c: {
    json(value: unknown, status?: number): Response;
  },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('already exists')) {
    return c.json({ error: message }, 409);
  }
  if (message.startsWith('Forbidden:')) {
    return c.json({ error: message }, 403);
  }

  return toAuthErrorResponse(c, error);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  return readPositiveIntegerFromEnv(
    (envName) => Deno.env.get(envName),
    name,
    fallback,
  );
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
