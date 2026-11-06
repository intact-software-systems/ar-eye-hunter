import { Either } from '@shared/resilience/Either.ts';
import type { ViewWatchRead, ViewWatchValidatedRead } from './compute-view-watch.ts';

export interface ViewWatchIssue {
    readonly code: 'session-not-current' | 'view-unavailable';
    readonly message: string;
}

/** Every refusal of the read; a conflicting expected registration needs no available view. */
export function validateViewWatch(read: ViewWatchRead): Either<readonly ViewWatchIssue[], ViewWatchValidatedRead> {
    const { command, auth, client, predecessor, authorization } = read;
    const issues: ViewWatchIssue[] = [];
    const session = auth?.value;
    const connection = client?.value;
    if (
        session === undefined || connection === undefined || session.clientId !== command.principalId ||
        session.sessionId !== command.sessionId || session.issuedAtEpochMs !== command.sessionIssuedAtEpochMs ||
        session.expiresAtEpochMs !== command.sessionExpiresAtEpochMs || session.expiresAtEpochMs <= read.nowEpochMs ||
        connection.status !== 'active' || connection.expiresAtEpochMs <= read.nowEpochMs ||
        connection.transport !== 'ws' || connection.sessionId !== command.sessionId ||
        connection.principalId !== command.principalId || connection.applicationId !== command.scope.applicationId ||
        connection.workspaceId !== command.scope.workspaceId ||
        connection.generationId !== command.request.connectionGenerationId ||
        connection.connectionId !== connection.generationId
    ) {
        issues.push({
            code: 'session-not-current',
            message: 'A watch requires its current authenticated WebSocket generation'
        });
    }
    const conflict = command.request.expectedRegistrationId !== (predecessor?.slot.value.registrationId ?? null);
    if (!conflict && command.request.resourceId !== null && authorization === null) {
        issues.push({ code: 'view-unavailable', message: 'The selected view is not available' });
    }
    return auth === null || client === null || issues.length > 0
        ? Either.ofLeft(issues)
        : Either.ofRight({ ...read, auth, client });
}
