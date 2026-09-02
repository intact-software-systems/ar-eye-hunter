import { validateRuntimeStateGuardedBatch } from '../../../../runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import { validateAppInboxComputedProjection } from '../../../app-inbox/handler/app-inbox-computed-validation.ts';
import { type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { validateCurrentGroupLifecyclePolicy } from '../../persistence/decode-stored-group-lifecycle-policy.ts';
import { computeGroupLifecyclePolicyWrite } from '../../persistence/group-lifecycle-policy-repository.ts';
import { computeGroupConnectTrigger } from '../aggregate/compute-group-connect-trigger.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { validateComputedRosterFacts } from '../state-validation/validate-computed-roster-facts.ts';
import { computeGroupStateGuardedBatch } from '../write/compute-group-state-guarded-batch.ts';
import { validateComputedGroupMutationEvent } from './validate-computed-group-mutation-event.ts';
import { validateComputedGroupMutationGuard } from './validate-computed-group-mutation-guard.ts';
import { validateComputedGroupMutationMembers } from './validate-computed-group-mutation-members.ts';
import { validateComputedGroupMutationOutbox } from './validate-computed-group-mutation-outbox.ts';
import { validateComputedGroupMutationReceipt } from './validate-computed-group-mutation-receipt.ts';

export interface ValidateComputedGroupMutationWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly computed: Extract<GroupMutationComputed, { outcome: 'write'; }>;
}

export function validateComputedGroupMutationWrite(
    input: ValidateComputedGroupMutationWriteInput
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateComputedGroupMutationGuard(input));
    issues.push(...validateComputedGroupMutationMembers(input));
    issues.push(...validateComputedGroupMutationEvent(input));
    issues.push(...validateComputedGroupMutationReceipt(input));
    if (input.computed.lifecyclePolicy !== null) {
        issues.push(...validateCurrentGroupLifecyclePolicy(input.computed.lifecyclePolicy));
    }
    if (issues.length === 0) {
        issues.push(...validateComputedRosterFacts(input.read, input.computed));
        issues.push(...validateComputedGroupMutationOutbox(input));
        const expectedTrigger = input.computed.guard.kind === 'group'
            ? computeGroupConnectTrigger({ ...input, next: input.computed.guard.value }).effect
            : null;
        issues.push(...validateAppInboxComputedProjection(
            expectedTrigger,
            input.computed.connectTriggerLatchEffect,
            'computed.connectTriggerLatchEffect'
        ));
        const expected = computeGroupStateGuardedBatch(input.computed);
        issues.push(...validateRuntimeStateGuardedBatch(expected.batch));
        issues.push(
            ...validateAppInboxComputedProjection(expected, input.computed.guardedBatch, 'computed.guardedBatch')
        );
        const expectedPolicyWrite = input.computed.lifecyclePolicy === null
            ? null
            : computeGroupLifecyclePolicyWrite(input.command.aggregateRef, input.computed.lifecyclePolicy);
        issues.push(...validateAppInboxComputedProjection(
            expectedPolicyWrite,
            input.computed.lifecyclePolicyWrite,
            'computed.lifecyclePolicyWrite'
        ));
    }
    return issues;
}

