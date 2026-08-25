import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { computeFormationTimerEntries } from '../../formation-timer-outbox-entry.ts';
import {
    isGroupLifecycleTransitionOperation,
    type GroupLifecycleTransitionOperation,
    type GroupMutationCommand
} from '../group-mutation-contracts.ts';
import { isPureLeaseRenewalHeartbeat } from '../presence/compute-heartbeat-group-presence.ts';
import type { ValidateComputedGroupMutationWriteInput } from './validate-computed-group-mutation-write.ts';

export function validateComputedGroupMutationOutbox(
    input: ValidateComputedGroupMutationWriteInput
): void {
    const { command, read, facts, computed } = input;
    if (!Array.isArray(computed.outboxEntries)) {
        throw new TypeError('Group mutation computed outbox entries must be an array');
    }
    const pureLeaseRenewal = command.operation === 'heartbeatPresence' &&
        isPureLeaseRenewalHeartbeat(command, read, facts);
    if (pureLeaseRenewal) {
        if (computed.outboxEntries.length !== 0 || computed.receipt.outboxIds.length !== 0) {
            throw new TypeError('A pure lease renewal must not expand a presence summary');
        }
        return;
    }
    const expectedTimerEntries = computeExpectedFormationTimerEntries(input);
    if (computed.outboxEntries.length !== 1 + expectedTimerEntries.length) {
        throw new TypeError('Group mutation must compute one presence-summary outbox entry');
    }
    for (const [index, expectedTimer] of expectedTimerEntries.entries()) {
        if (!jsonEquals(computed.outboxEntries[1 + index], expectedTimer)) {
            throw new TypeError('Group mutation formation-timer outbox entry is not canonical');
        }
    }
    const expected = computeGroupPresenceSummaryEntry(
        {
            effectKind: 'group-presence-summary',
            aggregateRef: command.aggregateRef,
            commandId: command.commandId,
            createdAtEpochMs: facts.nowEpochMs,
            expireAtEpochMs: facts.expireAtEpochMs,
            acceptedCausalRevision: computed.receipt.causalRevision,
            event: computed.event
        },
        facts.serviceId
    );
    if (!jsonEquals(computed.outboxEntries[0], expected)) {
        throw new TypeError('Group mutation presence-summary outbox entry is not canonical');
    }
}

function computeExpectedFormationTimerEntries(
    input: ValidateComputedGroupMutationWriteInput
): readonly ResourceEntry[] {
    const { command, read, facts, computed } = input;
    if (!isGroupLifecycleTransitionOperation(command.operation)) {
        return [];
    }
    if (computed.guard.kind !== 'group' || read.lifecyclePolicy === null) {
        return [];
    }
    if (read.lifecyclePolicy.status === 'corrupt') {
        return [];
    }
    const policy = read.lifecyclePolicy.status === 'present'
        ? read.lifecyclePolicy.policy
        : createDefaultGroupLifecyclePolicy();
    return computeFormationTimerEntries({
        command: command as Extract<GroupMutationCommand, {
            operation: GroupLifecycleTransitionOperation;
        }>,
        next: computed.guard.value as Group,
        policy,
        facts
    });
}
