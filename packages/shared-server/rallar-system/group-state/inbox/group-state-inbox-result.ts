import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { GroupStateRepository } from '../../repositories/GroupStateRepository.ts';
import type { GroupMutationReceipt } from '../../services/group-state-mutations.ts';
import type { GroupStateMutationCommand } from '../group-state-service-contracts.ts';

export interface GroupStateInboxResult {
  readonly durableResult: unknown;
  readonly committedSnapshot: GroupSnapshot | undefined;
}

export interface ReadGroupStateInboxResultInput {
  readonly repository: GroupStateRepository;
  readonly command: GroupStateMutationCommand;
  readonly receipt: GroupMutationReceipt;
}

export async function readGroupStateInboxResult(
  input: ReadGroupStateInboxResultInput,
): Promise<GroupStateInboxResult> {
  const snapshot = await input.repository.readSnapshot(input.command.command.aggregateRef);
  if (isPresenceOperation(input.command.command.operation)) {
    return { durableResult: input.receipt, committedSnapshot: snapshot };
  }
  if (!snapshot) {
    throw new TypeError(`Group snapshot not found after ${input.command.command.operation}`);
  }
  const event = await readReceiptEvent(
    input.repository,
    input.command.command.aggregateRef,
    input.receipt,
  );
  const durableResult =
    input.command.command.operation === 'rotateGroupJoinCode'
      ? toJoinCodeResult(input.receipt, snapshot, event)
      : toGroupMutationResult(input.command, input.receipt, snapshot, event);
  return { durableResult, committedSnapshot: snapshot };
}

function isPresenceOperation(
  operation: GroupStateMutationCommand['command']['operation'],
): boolean {
  return (
    operation === 'connectPresence' ||
    operation === 'heartbeatPresence' ||
    operation === 'disconnectPresence'
  );
}

async function readReceiptEvent(
  repository: GroupStateRepository,
  ref: GroupRef,
  receipt: GroupMutationReceipt,
): Promise<GroupEvent | null> {
  if (receipt.eventId === null) return null;
  const event = (await repository.listEvents(ref)).find(
    (candidate) => candidate.eventId === receipt.eventId,
  );
  if (!event) throw new TypeError(`Group mutation event not found: ${receipt.eventId}`);
  return event;
}

function toJoinCodeResult(
  receipt: GroupMutationReceipt,
  snapshot: GroupSnapshot,
  event: GroupEvent | null,
): unknown {
  if (receipt.outcome === 'rejected') {
    return {
      status: 'error',
      result: Either.ofLeft(receipt.rejection ?? 'Join-code rotation rejected'),
    };
  }
  if (receipt.joinCode === null || receipt.joinCodeExpiresAtEpochMs === null) {
    throw new TypeError('Join-code mutation result is incomplete');
  }
  return {
    status: 'ok',
    result: Either.ofRight({
      joinCode: receipt.joinCode,
      expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs,
      snapshot,
      event,
    }),
  };
}

function toGroupMutationResult(
  command: GroupStateMutationCommand,
  receipt: GroupMutationReceipt,
  snapshot: GroupSnapshot,
  event: GroupEvent | null,
): unknown {
  if (receipt.outcome === 'rejected') {
    return {
      status: 'error',
      result: Either.ofLeft(receipt.rejection ?? 'Group mutation rejected'),
    };
  }
  return {
    status: command.command.operation === 'createGroup' ? 'created' : 'ok',
    result: Either.ofRight({ snapshot, event }),
  };
}
