import authorisedClientsJson from '../../resources/authorised-clients.json' with { type: 'json' };
import type { LoginRequest, RegisterRequest } from '@shared/api/api-config.ts';
import type { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import {
  authenticateAuthUser,
  prepareAuthUserRegistration,
  type LoginClientData,
} from '@shared-server/rallar-system/services/auth-login-service.ts';
import {
  createAuthUserRepository,
} from './createStateRepositories.ts';

type RegisterOptions = Readonly<{
  now?: () => number;
  createClientId?: () => string;
}>;

type LoginOptions = Readonly<{
  userRepository?: AuthUserRepository;
}>;

export type AuthStaticClientsMode = 'demo' | 'disabled';

const authorisedClients = authorisedClientsJson as readonly LoginClientData[];

export async function register(
  request: RegisterRequest,
  options: RegisterOptions = {},
) {
  const capturedAtEpochMs = (options.now ?? (() => Date.now()))();
  return await prepareAuthUserRegistration(
    request,
    {
      clientId: (options.createClientId ?? (() => crypto.randomUUID()))(),
      capturedAtEpochMs,
    },
    readAuthorisedClients(Deno.env),
  );
}

export async function login(
  loginRequest: LoginRequest,
  options: LoginOptions = {},
) {
  return await authenticateAuthUser(loginRequest, {
    userRepository: options.userRepository ?? createAuthUserRepository(),
    staticClients: readAuthorisedClients(Deno.env),
  });
}

export function readAuthStaticClientsMode(env: Pick<Deno.Env, 'get'>): AuthStaticClientsMode {
  const raw = env.get('AUTH_STATIC_CLIENTS_MODE')?.trim().toLowerCase();
  if (!raw || raw === 'demo') {
    return 'demo';
  }
  if (raw === 'disabled') {
    return 'disabled';
  }

  throw new Error('AUTH_STATIC_CLIENTS_MODE must be demo or disabled.');
}

function readAuthorisedClients(env: Pick<Deno.Env, 'get'>): readonly LoginClientData[] {
  return readAuthStaticClientsMode(env) === 'disabled' ? [] : authorisedClients;
}
