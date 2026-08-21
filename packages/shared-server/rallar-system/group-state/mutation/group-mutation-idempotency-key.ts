import type { GroupMutationCommand } from './group-mutation-contracts.ts';

export function groupMutationIdempotencyKey(command: GroupMutationCommand): string | null {
  return command.requestId === null ? null : command.commandId;
}
