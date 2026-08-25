import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

export type ApiAdminAuthDependencies = Readonly<{
    adminClientIds: readonly string[];
    requireApiAuthSession: (
        req: { header(name: string): string | undefined; }
    ) => Promise<IssuedAuthSession>;
}>;

export async function requireApiAdminSession(
    req: { header(name: string): string | undefined; },
    dependencies: ApiAdminAuthDependencies
): Promise<IssuedAuthSession> {
    const session = await dependencies.requireApiAuthSession(req);

    if (!dependencies.adminClientIds.includes(session.clientId)) {
        throw new Error('Forbidden: platform admin authorization required');
    }

    return session;
}
