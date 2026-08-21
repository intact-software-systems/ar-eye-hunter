import { sha256CanonicalJson } from './mutation/group-state-crypto.ts';
import type {
  GroupMutationAuthorityProof,
  GroupMutationDescriptor,
} from './group-state-service-contracts.ts';

const GROUP_APP_INBOX_COMMAND_ID_PREFIX = 'group-app-inbox:';

export function isScopedGroupMutationCommandId(commandId: string): boolean {
  return commandId.startsWith(GROUP_APP_INBOX_COMMAND_ID_PREFIX);
}

export async function toScopedGroupMutationCommandId(
  descriptor: GroupMutationDescriptor,
  authorityProof: GroupMutationAuthorityProof,
): Promise<string> {
  const digest = await sha256CanonicalJson({
    domain: 'group-app-inbox-command-id',
    version: 1,
    operation: descriptor.operation,
    scope: descriptor.scope,
    groupId: descriptor.groupId,
    targetPrincipalId: descriptor.targetPrincipalId,
    targetSessionId: descriptor.sessionId,
    callerPrincipalId: authorityProof.principalId,
    requestId: descriptor.request.requestId,
  });
  return `${GROUP_APP_INBOX_COMMAND_ID_PREFIX}${digest}`;
}
