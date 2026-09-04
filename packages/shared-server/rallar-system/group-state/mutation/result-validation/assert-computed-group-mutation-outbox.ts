import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { isExactAppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
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
    if (!Array.isArray(computed.outboxWrites)) {
        throw new TypeError('Group mutation computed outbox writes must be an array');
    }
    const pureLeaseRenewal = command.operation === 'heartbeatPresence' &&
        isPureLeaseRenewalHeartbeat(command, read, facts);
    if (pureLeaseRenewal) {
        if (computed.outboxWrites.length !== 0 || computed.receipt.outboxIds.length !== 0) {
            throw new TypeError('A pure lease renewal must not expand a presence summary');
        }
        return;
    }
    const expectedEntries = [
        computeGroupPresenceSummaryEntry(
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
        ),
        ...computeExpectedFormationFollowupEntries(input)
    ];
    if (computed.outboxWrites.length !== expectedEntries.length) {
        throw new TypeError('Group mutation must compute one presence-summary outbox entry');
    }
    for (const [index, expected] of expectedEntries.entries()) {
        const write = computed.outboxWrites[index];
        if (write === undefined || !isExactAppOutboxInsert(expected, write)) {
            throw new TypeError('Group mutation outbox write is not canonical');
        }
    }
    if (
        computed.receipt.outboxIds.length !== expectedEntries.length ||
        expectedEntries.some((entry, index) => computed.receipt.outboxIds[index] !== entry.key.resourceId)
    ) {
        throw new TypeError('Group mutation receipt outbox identities are not canonical');
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
