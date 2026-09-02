import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeGroupConnectTrigger } from '../aggregate/compute-group-connect-trigger.ts';
import { resolveCreateGroupLifecyclePolicy } from '../aggregate/create-initial-group-mutation.ts';
import { resolveGroupAuthorityPolicy } from '../aggregate/resolve-group-authority-policy.ts';

import { computeFormationTimerEntries } from '../../formation-timer-outbox-entry.ts';
import {
    isGroupLifecycleTransitionOperation,
    type GroupLifecycleTransitionOperation,
    type GroupMutationCommand
} from '../group-mutation-contracts.ts';
import { isPureLeaseRenewalHeartbeat } from '../presence/compute-heartbeat-group-presence.ts';
import type { AssertComputedGroupMutationWriteInput } from './assert-computed-group-mutation-write.ts';

export function assertComputedGroupMutationOutbox(
    input: AssertComputedGroupMutationWriteInput
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
    const expectedFollowupEntries = computeExpectedFormationFollowupEntries(input);
    if (computed.outboxEntries.length !== 1 + expectedFollowupEntries.length) {
        throw new TypeError('Group mutation must compute one presence-summary outbox entry');
    }
    for (const [index, expectedFollowup] of expectedFollowupEntries.entries()) {
        if (!jsonEquals(computed.outboxEntries[1 + index], expectedFollowup)) {
            throw new TypeError('Group mutation formation follow-up outbox entry is not canonical');
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

function computeExpectedFormationFollowupEntries(
    input: AssertComputedGroupMutationWriteInput
): readonly ResourceEntry[] {
    const { command, read, facts, computed } = input;
    if (computed.guard.kind !== 'group') {
        return [];
    }
    if (command.operation === 'createGroup') {
        return computeFormationTimerEntries({
            command,
            previous: null,
            next: computed.guard.value,
            policy: resolveCreateGroupLifecyclePolicy(command),
            facts
        });
    }
    if (!isGroupLifecycleTransitionOperation(command.operation) || read.group === null) {
        return [];
    }
    const resolution = resolveGroupAuthorityPolicy(read);
    if (resolution.status === 'corrupt') {
        return [];
    }
    const policy = resolution.policy;
    const previous = read.group.value.lifecycleState;
    const trigger = computeGroupConnectTrigger({ command, read, facts, next: computed.guard.value, policy, previous });
    return [
        ...computeFormationTimerEntries({
            command: command as Extract<GroupMutationCommand, {
                operation: GroupLifecycleTransitionOperation;
            }>,
            previous,
            next: computed.guard.value,
            policy,
            facts
        }),
        ...trigger.outboxEntries
    ];
}
