import { AppTopics } from '@shared/api/api-config.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    GROUP_PRESENCE_SUMMARY_OUTBOX_TYPE,
    GROUP_PRESENCE_SUMMARY_TOPIC
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '@shared-server/rallar-system/services/rtc-topology-outbox-entry.ts';

import type { StateWriteOutboxCommand } from './api-v1-state-write-outbox-evidence.ts';
import type { ProductionReceiptEvidence } from './api-v1-state-write-receipt-evidence.ts';

export interface ProductionOutboxExpectation {
    readonly effectId: string;
    readonly physicalKey: Key;
    readonly logicalContextId: string;
    readonly canonicalCommandId: string;
    readonly effectKind: string;
    readonly typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
    readonly payloadTypeId: string;
    readonly identityKind: ProductionReceiptEvidence['identityKind'];
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
    return commands.flatMap((command) => {
        const receipt = receiptByCommand.get(command.commandId);
        if (receipt === undefined) {
            return [];
        }
        const effectKinds = expectedEffectKinds(command.kind);
        return receipt.outboxIds.flatMap((effectId, index) => {
            const effectKind = effectKinds[index];
            const binding = receipt.resultBindings.find((candidate) => candidate.outboxIds.includes(effectId));
            if (effectKind === undefined || binding === undefined) {
                return [];
            }
            const identity = toExpectedOutboxIdentity(effectKind, binding.aggregateRef);
            const physicalKey = toAppQueueKey({
                topicId: identity.topicId,
                resourceId: effectId,
                contextId: identity.logicalContextId
            });
            return [{
                effectId,
                physicalKey,
                logicalContextId: identity.logicalContextId,
                canonicalCommandId: binding.receiptId,
                effectKind,
                typeId: identity.typeId,
                payloadTypeId: identity.payloadTypeId,
                identityKind: receipt.identityKind
            }];
        });
    });
}

function expectedEffectKinds(kind: StateWriteOutboxCommand['kind']): readonly string[] {
    switch (kind) {
        case 'profile-instance':
            return [
                'principal-state:snapshot',
                'principal-state:event',
                'principal-state:snapshot',
                'principal-state:event'
            ];
        case 'membership':
        case 'presence-connect':
        case 'presence-heartbeat':
        case 'presence-disconnect':
        case 'config':
            return ['group-presence-summary'];
        case 'topology-source':
            return ['rtc-topology-recompute'];
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
