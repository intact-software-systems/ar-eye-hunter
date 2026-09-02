import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { validateAppInboxComputedProjection } from '../../../app-inbox/handler/app-inbox-computed-validation.ts';
import { computeAppOutboxInsertOrMatch } from '../../../app-outbox/app-outbox-insert.ts';
import { computeFormationTimerEntries } from '../../formation-timer-outbox-entry.ts';
import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { computeGroupConnectTrigger } from '../aggregate/compute-group-connect-trigger.ts';
import {
    isGroupLifecycleTransitionOperation,
    type GroupLifecycleTransitionOperation,
    type GroupMutationCommand
} from '../group-mutation-contracts.ts';
import { isPureLeaseRenewalHeartbeat } from '../presence/compute-heartbeat-group-presence.ts';
import type { ValidateComputedGroupMutationWriteInput } from './validate-computed-group-mutation-write.ts';

export function validateComputedGroupMutationOutbox(
    input: ValidateComputedGroupMutationWriteInput
): readonly GroupStateValidationIssue[] {
    const { command, read, facts, computed } = input;
    const pureLeaseRenewal = command.operation === 'heartbeatPresence' &&
        isPureLeaseRenewalHeartbeat(command, read, facts);
    const expectedEntries: ResourceEntry[] = [];
    if (!pureLeaseRenewal) {
        expectedEntries.push(
            computeGroupPresenceSummaryEntry({
                effectKind: 'group-presence-summary',
                aggregateRef: command.aggregateRef,
                commandId: command.commandId,
                createdAtEpochMs: facts.nowEpochMs,
                expireAtEpochMs: facts.expireAtEpochMs,
                acceptedCausalRevision: computed.receipt.causalRevision,
                event: computed.event
            }, facts.serviceId),
            ...computeExpectedFormationTimerEntries(input)
        );
    }
    const issues: GroupStateValidationIssue[] = [
        ...validateAppInboxComputedProjection(expectedEntries, computed.outboxEntries, 'computed.outboxEntries'),
        ...validateAppInboxComputedProjection(
            expectedEntries.map(computeAppOutboxInsertOrMatch),
            computed.outboxWrites,
            'computed.outboxWrites'
        )
    ];
    if (pureLeaseRenewal && computed.receipt.outboxIds.length !== 0) {
        issues.push(toGroupStateValidationIssue(
            'computed.receipt.outboxIds',
            'A pure lease renewal must not expand a presence summary'
        ));
    }
    return issues;
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
    const trigger = computeGroupConnectTrigger({ command, read, facts, next: computed.guard.value });
    return [
        ...computeFormationTimerEntries({
            command: command as Extract<GroupMutationCommand, {
                operation: GroupLifecycleTransitionOperation;
            }>,
            next: computed.guard.value,
            policy,
            facts
        }),
        ...trigger.outboxEntries
    ];
}

