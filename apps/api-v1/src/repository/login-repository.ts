import authorisedClientsJson from '../../resources/authorised-clients.json' with { type: 'json' };
import type { LoginRequest, RegisterRequest } from '@shared/api/api-config.ts';
import type { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import {
  loginAuthUser,
  type LoginClientData,
  registerAuthUser,
} from '@shared-server/rallar-system/services/auth-login-service.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
  createAuthUserRepository,
  createRuntimeStateRepository,
} from './createStateRepositories.ts';

type RegisterOptions = Readonly<{
  runtimeRepository?: RuntimeStateRepositoryLike;
  now?: () => number;
}>;

type LoginOptions = Readonly<{
  userRepository?: AuthUserRepository;
}>;

const authorisedClients = authorisedClientsJson as readonly LoginClientData[];

export async function register(
  request: RegisterRequest,
  options: RegisterOptions = {},
) {
  return await registerAuthUser(request, {
    runtimeRepository: options.runtimeRepository ?? createRuntimeStateRepository(),
    staticClients: authorisedClients,
    now: options.now,
  });
}

export async function login(
  loginRequest: LoginRequest,
  options: LoginOptions = {},
) {
  return await loginAuthUser(loginRequest, {
    userRepository: options.userRepository ?? createAuthUserRepository(),
    staticClients: authorisedClients,
  });
}
