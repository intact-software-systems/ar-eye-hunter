import type {
  AuthSessionRepository,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type {
  AppAuthInboxService,
} from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import {
  requireApiAuthSession as requireSharedApiAuthSession,
  requireWsAuthSession as requireSharedWsAuthSession,
  toAuthErrorResponse,
  toAuthSession,
} from '@shared-server/http/request-auth-service.ts';
export { toAuthErrorResponse, toAuthSession };

export async function requireApiAuthSession(
  req: {
    header(name: string): string | undefined;
  },
  repository: AuthSessionRepository,
) {
  return await requireSharedApiAuthSession(req, repository);
}

export async function requireWsAuthSession(
  input: {
    sessionId: string;
    ticket?: string;
  },
  appAuthInbox: AppAuthInboxService,
  facts: Readonly<{ requestId: string; capturedAtEpochMs: number }>,
) {
  return await requireSharedWsAuthSession(input, appAuthInbox, facts);
}
