import type { AuthSession } from '@shared/api/api-config.ts';
import { requireApiAuthSession as defaultRequireApiAuthSession } from './request-auth-service.ts';

export type ApiAdminAuthDependencies = Readonly<{
  adminClientIds: readonly string[];
  requireApiAuthSession?: (
    req: { header(name: string): string | undefined },
  ) => Promise<AuthSession>;
}>;

export async function requireApiAdminSession(
  req: { header(name: string): string | undefined },
  dependencies: ApiAdminAuthDependencies,
): Promise<AuthSession> {
  const session = await (dependencies.requireApiAuthSession ??
    defaultRequireApiAuthSession)(req);

  if (!dependencies.adminClientIds.includes(session.clientId)) {
    throw new Error('Forbidden: platform admin authorization required');
  }

  return session;
}
