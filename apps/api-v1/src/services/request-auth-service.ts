import {
    authenticationRequired,
    authorizationDenied,
    readApiAuthCredentialProof,
    RequestAuthFailure,
    requireApiAuthSession as requireSharedApiAuthSession,
    toAuthErrorResponse,
    toAuthSession
} from '@shared-server/http/request-auth-service.ts';
import type { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
export {
    authenticationRequired,
    authorizationDenied,
    readApiAuthCredentialProof,
    RequestAuthFailure,
    toAuthErrorResponse,
    toAuthSession
};

export async function requireApiAuthSession(
    req: {
        header(name: string): string | undefined;
    },
    repository: AuthSessionRepository
) {
    return await requireSharedApiAuthSession(req, repository);
}
