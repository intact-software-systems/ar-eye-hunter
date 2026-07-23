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
import { getMiddleware } from '../middleware.ts';

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
  appAuthInbox = getMiddleware().appAuthInboxService,
  facts: Readonly<{ requestId: string; capturedAtEpochMs: number }> = {
    requestId: crypto.randomUUID(),
    capturedAtEpochMs: Date.now(),
  },
) {
  return await requireSharedWsAuthSession(input, appAuthInbox, facts);
}
