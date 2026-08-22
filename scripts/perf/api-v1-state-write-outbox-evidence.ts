import type { ProductionOutboxRecord } from './api-v1-state-write-outbox-repository.ts';
import type { ProductionReceiptEvidence } from './api-v1-state-write-receipt-evidence.ts';

export { computeProductionOutboxExpectations } from './api-v1-state-write-outbox-expectations.ts';
export {
    createProductionOutboxRepository,
    readAllCommandIds,
    readCanonicalEffectCommandId,
    readReferencedProductionOutboxRecords,
    readResourceEffectKind
} from './api-v1-state-write-outbox-repository.ts';

export interface StateWriteOutboxCommand {
    readonly commandId: string;
    readonly kind:
        | 'profile-instance'
        | 'membership'
        | 'presence-connect'
        | 'presence-heartbeat'
        | 'presence-disconnect'
        | 'config'
        | 'topology-source';
}

export interface StateWriteResourceOutboxEvidence {
    readonly effectId: string;
    readonly resourceId: string;
    readonly outboxId: string;
    readonly commandId: string;
    readonly effectKind: string;
    readonly typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
    readonly topicId: string;
}

export function productionCommandIdsForRaw(command: StateWriteOutboxCommand): readonly string[] {
    return command.kind === 'profile-instance'
        ? [`${command.commandId}-profile`, `${command.commandId}-instance`]
        : [command.commandId];
}

export interface ProjectProductionOutboxEvidenceInput {
    readonly commands: readonly StateWriteOutboxCommand[];
    readonly receipts: readonly ProductionReceiptEvidence[];
    readonly records: readonly ProductionOutboxRecord[];
}

export function computeProductionOutboxEvidence({
    commands,
    receipts,
    records
}: ProjectProductionOutboxEvidenceInput): readonly StateWriteResourceOutboxEvidence[] {
    const rawByProductionId = new Map(
        [
            ...commands.flatMap((command) =>
                productionCommandIdsForRaw(command).map(
                    (productionId) => [productionId, command.commandId] as const
                )
            ),
            ...receipts.flatMap((receipt) =>
                receipt.receiptIds.map((receiptId) => [receiptId, receipt.commandId] as const)
            )
        ]
    );
    const receiptByCommand = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
    const known = new Set(commands.map((command) => command.commandId));
    return records.flatMap((record) => {
        const commandId = record.canonicalCommandId === undefined
            ? undefined
            : rawByProductionId.get(record.canonicalCommandId);
        const receipt = commandId === undefined ? undefined : receiptByCommand.get(commandId);
        const effectId = receipt?.identityKind === 'logical-msg-id'
            ? record.outboxId
            : record.resourceId;
        if (!commandId || !known.has(commandId) || !receipt?.outboxIds.includes(effectId)) {
            return [];
        }
        return [
            {
                effectId,
                resourceId: record.resourceId,
                outboxId: record.outboxId,
                commandId,
                effectKind: record.effectKind,
                typeId: record.typeId,
                topicId: record.topicId
            }
        ];
    });
}
