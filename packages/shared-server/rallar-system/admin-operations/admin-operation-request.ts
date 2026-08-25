import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { IssuedAuthSession } from '../auth/persistence/auth-session-types.ts';

export interface AdminOperationReadRequest {
    readonly adminSession: AuthSession;
    readonly scope?: StateScope;
}

export interface AdminOperationWriteRequest<TRequest> {
    readonly adminSession: AuthSession;
    readonly request: TRequest;
}

export interface AdminOperationMutationRequest<TRequest> {
    readonly adminSession: IssuedAuthSession;
    readonly request: TRequest;
    readonly requestId: string;
}
