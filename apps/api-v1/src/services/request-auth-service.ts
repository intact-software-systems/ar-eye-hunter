import type { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
  requireApiAuthSession as requireSharedApiAuthSession,
  requireWsAuthSession as requireSharedWsAuthSession,
  toAuthErrorResponse,
  toAuthSession,
} from '@shared-server/http/request-auth-service.ts';
import {
  createAuthSessionRepository,
  createRuntimeStateRepository,
} from '../repository/createStateRepositories.ts';

export { toAuthErrorResponse, toAuthSession };

export async function requireApiAuthSession(
  req: {
    header(name: string): string | undefined;
  },
  repository: AuthSessionRepository = createAuthSessionRepository(createRuntimeStateRepository()),
) {
  return await requireSharedApiAuthSession(req, repository);
}

export async function requireWsAuthSession(
  input: {
    sessionId: string;
    ticket?: string;
  },
  repository: AuthSessionRepository = createAuthSessionRepository(createRuntimeStateRepository()),
) {
  return await requireSharedWsAuthSession(input, repository);
}
