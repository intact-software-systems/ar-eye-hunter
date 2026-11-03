import { authorizationDenied } from '@shared-server/http/request-auth-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

export interface ApiAdminAuthDependencies {
    readonly adminClientIds: readonly string[];
    readonly requireApiAuthSession: (
        request: { header(name: string): string | undefined; }
    ) => Promise<IssuedAuthSession>;
}

export async function requireApiAdminSession(
    request: { header(name: string): string | undefined; },
    dependencies: ApiAdminAuthDependencies
): Promise<IssuedAuthSession> {
    const session = await dependencies.requireApiAuthSession(request);

    if (!dependencies.adminClientIds.includes(session.clientId)) {
        throw authorizationDenied('Forbidden: platform admin authorization required');
    }

    return session;
}
