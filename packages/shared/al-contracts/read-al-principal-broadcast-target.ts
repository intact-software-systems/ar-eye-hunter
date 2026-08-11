import type { ClientPrincipalRef } from '../api/client-types.ts';
import type { ALMessage } from './al-contract.ts';

/**
 * Reads the server-resolved principal audience from a broadcast target with
 * scope 'principal': the principal's own live sessions plus live sessions of
 * groups the principal is an active member of. Never a world broadcast.
 */
export function readALPrincipalBroadcastTarget(
    message: ALMessage,
): ClientPrincipalRef | undefined {
    const targets = message.targets;
    if (
        targets?.mode !== 'broadcast' ||
        targets.scope !== 'principal' ||
        targets.principalRef === undefined ||
        typeof targets.principalRef.applicationId !== 'string' ||
        typeof targets.principalRef.workspaceId !== 'string' ||
        typeof targets.principalRef.principalId !== 'string'
    ) {
        return undefined;
    }

    return {
        applicationId: targets.principalRef.applicationId,
        workspaceId: targets.principalRef.workspaceId,
        principalId: targets.principalRef.principalId,
    };
}
