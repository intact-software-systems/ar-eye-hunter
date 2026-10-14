import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';

const GROUP_APP_INBOX_COMMAND_ID_PREFIX = 'group-app-inbox:';

export interface ScopedGroupMutationCommandIdentityInput {
    readonly operation: GroupMutationDescriptor['operation'];
    readonly scope: GroupMutationDescriptor['scope'];
    readonly groupId: string;
    readonly targetPrincipalId: string | null;
    readonly targetSessionId: string | null;
    readonly callerPrincipalId: string;
    readonly requestId: GroupMutationDescriptor['request']['requestId'];
}

export function isScopedGroupMutationCommandId(commandId: string): boolean {
    return commandId.startsWith(GROUP_APP_INBOX_COMMAND_ID_PREFIX);
}

export function toScopedGroupMutationCommandId(
    descriptor: GroupMutationDescriptor,
    callerPrincipalId: string
): string {
    return toScopedGroupMutationCommandIdFromIdentity({
        operation: descriptor.operation,
        scope: descriptor.scope,
        groupId: descriptor.groupId,
        targetPrincipalId: descriptor.targetPrincipalId,
        targetSessionId: descriptor.sessionId,
        callerPrincipalId,
        requestId: descriptor.request.requestId
    });
}

export function toScopedGroupMutationCommandIdFromIdentity(
    identity: ScopedGroupMutationCommandIdentityInput
): string {
    const digest = computeSha256CanonicalJson({
        domain: 'group-app-inbox-command-id',
        version: 1,
        ...identity
    });
    return `${GROUP_APP_INBOX_COMMAND_ID_PREFIX}${digest}`;
}
