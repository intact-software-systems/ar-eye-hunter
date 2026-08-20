import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';

import type { LoginRequest, RegisterRequest, RegisterResponse } from '@shared/api/api-config.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { readRateLimiter, readRequestClientKey } from '@shared-server/http/rate-limit-service.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';

import * as apiLoginService from '../../services/api-login-service.ts';
import type { ConfigRouteDependencies } from '../config-route.ts';
import {
  toApiMutationFailureResponse,
  toApiMutationRateLimitResponse,
} from '../api-mutation-route-failure.ts';
import {
  readAuthMutationRequest,
  requireAuthMutationResult,
  toJsonResponse,
} from './auth-mutation-route-support.ts';

const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

interface RegisterUserThroughAppInboxInput {
  readonly context: Context;
  readonly requestId: string;
  readonly request: RegisterRequest;
  readonly dependencies: ConfigRouteDependencies;
}

export function registerAuthUserMutationRoutes(
  app: Hono,
  dependencies: ConfigRouteDependencies,
): void {
  app.post(
    '/api/auth/login/requests/:requestId',
    (context) => issueLoginResponse(context, dependencies),
  );
  app.post(
    '/api/auth/register/requests/:requestId',
    (context) => registerUserResponse(context, dependencies),
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
        const { requestId, body } = await readAuthMutationRequest(context);
        const loginRequest = body as LoginRequest;
        return await RateLimiter.tryToExecuteOrDefault<Response>(
          readRateLimiter(
            'auth-login-user',
            `${clientKey}:${loginRequest.username ?? ''}`,
            LOGIN_USER_RATE_LIMIT,
          ),
          () => issueLoginSession(requestId, loginRequest, dependencies),
          toApiMutationRateLimitResponse(
            context,
            'Too many login attempts for this user',
            60_000,
          ),
        );
      },
      toApiMutationRateLimitResponse(context, 'Too many login attempts', 60_000),
    );
  } catch (error) {
    return toApiMutationFailureResponse(
      context,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

async function issueLoginSession(
  requestId: string,
  request: LoginRequest,
  dependencies: ConfigRouteDependencies,
): Promise<Response> {
  const loginResponse = await apiLoginService.login({
    request,
    userRepository: dependencies.authUserRepository,
    staticClients: dependencies.staticClients,
  });
  if (!loginResponse) {
    return toApiMutationFailureResponse(
      { json: (value, status) => toJsonResponse(value, status) },
      new Error('Unauthorized: Invalid username or password'),
    );
  }

  const issuedAtEpochMs = dependencies.now();
  return toJsonResponse(requireAuthMutationResult(
    await dependencies.appAuthInbox.issueSession({
      requestId,
      capturedAtEpochMs: issuedAtEpochMs,
      clientId: loginResponse.clientId,
      username: loginResponse.username,
      authority: loginResponse.authority,
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
        const { requestId, body } = await readAuthMutationRequest(context);
        const request = body as RegisterRequest;
        return await RateLimiter.tryToExecuteOrDefault<Response>(
          readRateLimiter(
            'auth-register-user',
            `${clientKey}:${request.username ?? ''}`,
            REGISTER_USER_RATE_LIMIT,
          ),
          () =>
            registerUserThroughAppInbox({
              context,
              requestId,
              request,
              dependencies,
            }),
          toApiMutationRateLimitResponse(
            context,
            'Too many registration attempts for this user',
            60_000,
          ),
        );
      },
      toApiMutationRateLimitResponse(context, 'Too many registration attempts', 60_000),
    );
  } catch (error) {
    return toApiMutationFailureResponse(
      context,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

async function registerUserThroughAppInbox(
  input: RegisterUserThroughAppInboxInput,
): Promise<Response> {
  await requireRegistrationAdminIfNeeded(input.context.req, input.dependencies);
  const capturedAtEpochMs = input.dependencies.now();
  const normalizedUsername = readNormalizedRegistrationUsername(input.request);
  const registerResponse = await apiLoginService.register({
    request: input.request,
    staticClients: input.dependencies.staticClients,
    capturedAtEpochMs,
    clientId: await toDeterministicAuthUserId(input.requestId, normalizedUsername),
    passwordSaltSeed: `auth-registration:${input.requestId}:${normalizedUsername}`,
  });
  return toJsonResponse<RegisterResponse>(
    requireAuthMutationResult(
      await input.dependencies.appAuthInbox.registerUser({
        requestId: input.requestId,
        capturedAtEpochMs: registerResponse.createdAtEpochMs,
        user: registerResponse,
      }),
    ),
    201,
  );
}

function readNormalizedRegistrationUsername(request: RegisterRequest): string {
  const username = typeof request.username === 'string' ? request.username.trim() : '';
  if (username.length === 0) {
    throw new TypeError('Username is required');
  }
  return username.toLowerCase();
}

async function toDeterministicAuthUserId(
  requestId: string,
  normalizedUsername: string,
): Promise<string> {
  const digest = await hashAuthSecret(
    JSON.stringify(['auth-registration-user', requestId, normalizedUsername]),
  );
  return `user-${digest.slice(0, 24)}`;
}

async function requireRegistrationAdminIfNeeded(
  req: { header(name: string): string | undefined },
  dependencies: ConfigRouteDependencies,
): Promise<void> {
  if (dependencies.registrationMode !== 'admin') return;
  const authSession = await dependencies.requireApiAuthSession(req);
  if (!dependencies.adminClientIds.has(authSession.clientId)) {
    throw new Error('Forbidden: admin auth session required to register users');
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  try {
    const raw = Deno.env.get(name)?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
    return value;
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) return fallback;
    throw error;
  }
}
