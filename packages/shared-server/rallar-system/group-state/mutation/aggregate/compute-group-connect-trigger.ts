import type { Group } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { RuntimeStateGuardedBatchEffect } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { computeGroupConnectTriggerEntry } from '../../group-connect-trigger-outbox-entry.ts';
import { toGroupConnectTriggerLatchEffect } from '../../persistence/group-connect-trigger-latch-repository.ts';
import type { GroupMutationCommand, GroupMutationFacts, GroupMutationRead } from '../group-mutation-contracts.ts';

export interface GroupConnectTriggerComputed {
    readonly effect: RuntimeStateGuardedBatchEffect | null;
    readonly outboxEntries: readonly ResourceEntry[];
}

export interface ComputeGroupConnectTriggerInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly next: Group;
}

export function computeGroupConnectTrigger(input: ComputeGroupConnectTriggerInput): GroupConnectTriggerComputed {
    const { command, read, facts, next } = input;
    if (facts.internalAuthority !== 'formation-automation') {
        return { effect: null, outboxEntries: [] };
    }
    if (command.operation === 'connectGroup' && read.connectTriggerLatch !== null) {
        return {
            effect: toGroupConnectTriggerLatchEffect(
                { ...read.connectTriggerLatch.latch, state: 'consumed' },
                read.connectTriggerLatch.revision
            ),
            outboxEntries: []
        };
    }
    if (command.operation !== 'planGroupLayout') {
        return { effect: null, outboxEntries: [] };
    }
    const latch = {
        groupRef: command.aggregateRef,
        formationEpoch: next.formationEpoch,
        triggerGeneration: command.commandId,
        state: 'awaiting-publication'
    } as const;
    return {
        effect: toGroupConnectTriggerLatchEffect(latch, null),
        outboxEntries: [computeGroupConnectTriggerEntry({
            work: {
                kind: 'intent',
                groupRef: latch.groupRef,
                formationEpoch: latch.formationEpoch,
                triggerGeneration: latch.triggerGeneration,
                wakeIdentity: command.commandId
            },
            senderId: facts.serviceId,
            createdAtEpochMs: facts.nowEpochMs,
            expireAtEpochMs: facts.expireAtEpochMs
        })]
    };
}
