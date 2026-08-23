import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { GroupStateMutationCommand } from '../group-state-service-contracts.ts';
import type { GroupJoinCodeWritten, GroupStateWritten } from '../group-state-service-contracts.ts';
import type { GroupMutationReceipt } from '../mutation/group-mutation-contracts.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import type { InactiveGroupPresenceResult } from '../presence/group-presence-service.ts';

export type GroupPresenceInboxDurableResult = GroupMutationReceipt | InactiveGroupPresenceResult;

export type GroupStateInboxDurableResult = GroupPresenceInboxDurableResult | GroupJoinCodeWritten | GroupStateWritten;

export interface GroupStateInboxResult {
    readonly durableResult: GroupStateInboxDurableResult;
    readonly committedSnapshot: GroupSnapshot | undefined;
}

export interface ReadGroupStateInboxResultInput {
    readonly repository: GroupStateRepository;
    readonly command: GroupStateMutationCommand;
    readonly receipt: GroupMutationReceipt;
}

interface ToGroupMutationResultInput {
    readonly command: GroupStateMutationCommand;
    readonly receipt: GroupMutationReceipt;
    readonly snapshot: GroupSnapshot;
    readonly event: GroupEvent | null;
}

export async function readGroupStateInboxResult(
    input: ReadGroupStateInboxResultInput
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
        input.receipt
    );
    const durableResult = input.command.command.operation === 'rotateGroupJoinCode'
        ? toJoinCodeResult(input.receipt, snapshot, event)
        : toGroupMutationResult({ command: input.command, receipt: input.receipt, snapshot, event });
    return { durableResult, committedSnapshot: snapshot };
}

function isPresenceOperation(
    operation: GroupStateMutationCommand['command']['operation']
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
    receipt: GroupMutationReceipt
): Promise<GroupEvent | null> {
    if (receipt.eventId === null) {
        return null;
    }
    const event = (await repository.listEvents(ref)).find(
        (candidate) => candidate.eventId === receipt.eventId
    );
    if (!event) {
        throw new TypeError(`Group mutation event not found: ${receipt.eventId}`);
    }
    return event;
}

function toJoinCodeResult(
    receipt: GroupMutationReceipt,
    snapshot: GroupSnapshot,
    event: GroupEvent | null
): GroupJoinCodeWritten {
    if (receipt.outcome === 'rejected') {
        throw new TypeError('Rejected join-code mutation reached success result assembly');
    }
    if (receipt.joinCode === null || receipt.joinCodeExpiresAtEpochMs === null) {
        throw new TypeError('Join-code mutation result is incomplete');
    }
    return {
        status: 'ok',
        result: {
            joinCode: receipt.joinCode,
            expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs,
            snapshot,
            event
        }
    };
}

function toGroupMutationResult(input: ToGroupMutationResultInput): GroupStateWritten {
    const { command, event, receipt, snapshot } = input;
    if (receipt.outcome === 'rejected') {
        throw new TypeError('Rejected group mutation reached success result assembly');
    }
    return {
        status: command.command.operation === 'createGroup' ? 'created' : 'ok',
        result: { snapshot, event }
    };
}
