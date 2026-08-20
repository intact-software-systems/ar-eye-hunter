import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';
import { signRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';
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

import { toAuthErrorResponse } from '../services/request-auth-service.ts';
import { toJsonResponse } from './auth/auth-mutation-route-support.ts';
import {
  registerAuthCredentialMutationRoutes,
} from './auth/register-auth-credential-mutation-routes.ts';
import { registerAuthUserMutationRoutes } from './auth/register-auth-user-mutation-routes.ts';

const BLACK_BOX_OPERATOR_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

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
    | 'replayLogoutSessionWithCredentialProof'
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

  registerAuthUserMutationRoutes(app, deps);
  registerAuthCredentialMutationRoutes(app, deps);

  app.post(
    '/api/black-box/control-token',
    (context) => issueBlackBoxControlTokenResponse(context, deps),
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
    return toAuthRouteErrorResponse(
      context,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

async function readApiConfiguration() {
  const configRepository = await import('../config-repo.ts');
  return configRepository.configuration;
}

function toAuthRouteErrorResponse(
  context: Context,
  error: Error,
): Response {
  const message = error.message;
  if (message.includes('already exists')) {
    return context.json({ error: message }, 409);
  }
  if (message.startsWith('Bad Request:')) {
    return context.json({ error: message }, 400);
  }
  if (message.startsWith('Forbidden:')) {
    return context.json({ error: message }, 403);
  }

  return toAuthErrorResponse(context, error);
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
