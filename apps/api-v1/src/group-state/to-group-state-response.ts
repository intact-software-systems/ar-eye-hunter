import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type {
  GroupJoinCodeMutationWritten,
  GroupJoinCodeWritten,
  GroupMutationWritten,
  GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
// deno-fmt-ignore: This package import exceeds the repository's 100-column checker limit.
import type {
  GroupMutationReceipt,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

import type { GroupStateRouteService } from './group-state-route-contracts.ts';

type GroupJoinCodeResponse = Omit<GroupJoinCodeMutationWritten, 'event'>;

export type GroupStateResponseInput =
  | Readonly<{
    kind: 'mutation';
    written: GroupStateWritten;
  }>
  | Readonly<{
    kind: 'join-code';
    written: GroupJoinCodeWritten;
  }>
  | Readonly<{
    kind: 'presence';
    receipt: GroupMutationReceipt;
    ref: GroupRef;
    service: GroupStateRouteService;
  }>;

export function toGroupStateResponse(
  input: Extract<GroupStateResponseInput, { kind: 'mutation' }>,
): GroupMutationWritten;

export function toGroupStateResponse(
  input: Extract<GroupStateResponseInput, { kind: 'join-code' }>,
): GroupJoinCodeResponse;

export function toGroupStateResponse(
  input: Extract<GroupStateResponseInput, { kind: 'presence' }>,
): Promise<GroupSnapshot>;

export function toGroupStateResponse(
  input: GroupStateResponseInput,
): GroupMutationWritten | GroupJoinCodeResponse | Promise<GroupSnapshot> {
  switch (input.kind) {
    case 'mutation':
      return toGroupMutationResponse(input.written);
    case 'join-code':
      return toGroupJoinCodeResponse(input.written);
    case 'presence':
      return toGroupPresenceResponse(input);
  }
}

function toGroupMutationResponse(written: GroupStateWritten): GroupMutationWritten {
  const mutation = written.result.right;
  if (!mutation) {
    throw new Error(written.result.left ?? 'Client mutation failed');
  }

  return mutation;
}

function toGroupJoinCodeResponse(written: GroupJoinCodeWritten): GroupJoinCodeResponse {
  const mutation = written.result.right;
  if (!mutation) {
    throw new Error(written.result.left ?? 'Group join code rotation failed');
  }

  const { event: _event, ...response } = mutation;
  return response;
}

async function toGroupPresenceResponse(
  input: Extract<GroupStateResponseInput, { kind: 'presence' }>,
): Promise<GroupSnapshot> {
  if (input.receipt.outcome === 'rejected') {
    throw new Error(input.receipt.rejection ?? 'Group presence mutation rejected');
  }

  const snapshot = await input.service.readCurrentSnapshot(input.ref);
  if (!snapshot) {
    throw new Error(`Group snapshot not found after mutation: ${input.ref.groupId}`);
  }

  return snapshot;
}
