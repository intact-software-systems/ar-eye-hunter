import { AppTopics } from '@shared/api/api-config.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    GROUP_PRESENCE_SUMMARY_OUTBOX_TYPE,
    GROUP_PRESENCE_SUMMARY_TOPIC
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';

import type { StateWriteOutboxCommand } from './api-v1-state-write-outbox-evidence.ts';
import type { AuthoritativeResultBinding, ProductionReceiptEvidence } from './api-v1-state-write-receipt-evidence.ts';

export interface ProductionOutboxExpectation {
    readonly effectId: string;
    readonly physicalKey: Key;
    readonly logicalContextId: string;
    readonly canonicalCommandId: string;
    readonly effectKind: string;
    readonly typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
    readonly payloadTypeId: string;
    readonly identityKind: ProductionReceiptEvidence['identityKind'];
    readonly aggregateRef: AuthoritativeResultBinding['aggregateRef'];
    readonly sourceMessageId: string | null;
    readonly stateRevision: AuthoritativeResultBinding['stateRevision'];
}

interface ExpectedOutboxIdentity {
    readonly typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
    readonly topicId: string;
    readonly logicalContextId: string;
    readonly payloadTypeId: string;
}

export function computeProductionOutboxExpectations(
    commands: readonly StateWriteOutboxCommand[],
    receipts: readonly ProductionReceiptEvidence[]
): readonly ProductionOutboxExpectation[] {
    const receiptByCommand = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
    const expectations: ProductionOutboxExpectation[] = [];
    for (const command of commands) {
        const receipt = receiptByCommand.get(command.commandId);
        if (receipt === undefined) {
            continue;
        }
        for (const effectId of receipt.outboxIds) {
            const bindings = receipt.resultBindings.filter((candidate) => candidate.outboxIds.includes(effectId));
            if (bindings.length === 1) {
                expectations.push(computeOutboxExpectation(command, bindings[0]!, {
                    effectId,
                    identityKind: receipt.identityKind
                }));
            }
        }
    }
    return expectations;
}

interface ReceiptOutboxEffect {
    readonly effectId: string;
    readonly identityKind: ProductionReceiptEvidence['identityKind'];
}

function computeOutboxExpectation(
    command: StateWriteOutboxCommand,
    binding: AuthoritativeResultBinding,
    effect: ReceiptOutboxEffect
): ProductionOutboxExpectation {
    const effectKind = expectedEffectKind(command, binding, effect.effectId);
    const identity = toExpectedOutboxIdentity(effectKind, binding.aggregateRef);
    return {
        effectId: effect.effectId,
        physicalKey: toAppQueueKey({
            topicId: identity.topicId,
            resourceId: effect.effectId,
            contextId: identity.logicalContextId
        }),
        logicalContextId: identity.logicalContextId,
        canonicalCommandId: binding.receiptId,
        effectKind,
        typeId: identity.typeId,
        payloadTypeId: identity.payloadTypeId,
        identityKind: effect.identityKind,
        aggregateRef: binding.aggregateRef,
        stateRevision: binding.stateRevision,
        sourceMessageId: command.kind === 'profile-instance'
            ? `${binding.receiptId}:${effectKind}:revision=${binding.stateRevision}`
            : null
    };
}

function expectedEffectKind(
    command: StateWriteOutboxCommand,
    binding: AuthoritativeResultBinding,
    effectId: string
): string {
    switch (command.kind) {
        case 'profile-instance':
            return effectId === toAppQueueKey({
                    resourceId: `${binding.receiptId}:principal-state:event:revision=${binding.stateRevision}`,
                    topicId: AppTopics.clientStateEvent,
                    contextId: ''
                }).resourceId
                ? 'principal-state:event'
                : 'principal-state:snapshot';
        case 'membership':
        case 'presence-connect':
        case 'presence-heartbeat':
        case 'presence-disconnect':
        case 'config':
            return 'group-presence-summary';
        case 'topology-source':
            return 'rtc-topology-recompute';
    }
}

function toExpectedOutboxIdentity(
    effectKind: string,
    aggregateRef: ProductionReceiptEvidence['resultBindings'][number]['aggregateRef']
): ExpectedOutboxIdentity {
    if (effectKind === 'principal-state:snapshot' || effectKind === 'principal-state:event') {
        if (aggregateRef.principalId === undefined) {
            throw new TypeError('Principal state effect has no principal aggregate identity');
        }
        const topicId = effectKind === 'principal-state:snapshot'
            ? AppTopics.clientStateSnapshot
            : AppTopics.clientStateEvent;
        return {
            typeId: 'WS_OUTBOX',
            topicId,
            logicalContextId: JSON.stringify([
                'principal',
                aggregateRef.applicationId,
                aggregateRef.workspaceId,
                aggregateRef.principalId
            ]),
            payloadTypeId: topicId
        };
    }
    if (aggregateRef.groupId === undefined) {
        throw new TypeError('Group state effect has no group aggregate identity');
    }
    if (effectKind === 'group-presence-summary') {
        return {
            typeId: 'APP_OUTBOX',
            topicId: GROUP_PRESENCE_SUMMARY_TOPIC,
            logicalContextId: JSON.stringify([
                aggregateRef.applicationId,
                aggregateRef.workspaceId,
                aggregateRef.groupId
            ]),
            payloadTypeId: GROUP_PRESENCE_SUMMARY_OUTBOX_TYPE
        };
    }
    if (effectKind === 'rtc-topology-recompute') {
        return {
            typeId: 'APP_OUTBOX',
            topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
            logicalContextId: groupStateGroupStorageKey({
                applicationId: aggregateRef.applicationId,
                workspaceId: aggregateRef.workspaceId,
                groupId: aggregateRef.groupId
            }),
            payloadTypeId: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
        };
    }
    throw new TypeError(`Unsupported benchmark effect kind: ${effectKind}`);
}
