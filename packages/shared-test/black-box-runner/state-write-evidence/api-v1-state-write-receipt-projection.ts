import type { PublicResultReceiptIdentity } from './api-v1-state-write-group-causal-evidence.ts';
import type { AuthoritativeReceiptEvidence } from './api-v1-state-write-receipt-evidence.ts';
import type { AuthoritativeTopologyReceipt, ReceiptEffectIdentityKind } from './api-v1-state-write-result-evidence.ts';

export interface AuthoritativeReceiptProjectionInput {
    readonly commandId: string;
    readonly commandHash: string;
    readonly outcome: string;
    readonly outboxIds: readonly string[];
    readonly requestId?: string | null;
    readonly aggregateRef?: Readonly<{
        applicationId: string;
        workspaceId: string;
        principalId?: string;
        groupId?: string;
    }>;
    readonly stateRevision?: number;
    readonly snapshotVersion?: number;
    readonly eventId?: string | null;
    readonly causalRevision?: PublicResultReceiptIdentity['causalRevision'];
    readonly operation?: string;
    readonly target?: 'config' | 'override';
    readonly groupRef?: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId: string;
    }>;
    readonly acceptedVersion?: number;
    readonly acceptedStorageRevision?: number | null;
    readonly acceptedCreatedAtEpochMs?: number | null;
    readonly acceptedUpdatedAtEpochMs?: number | null;
    readonly acceptedExpiresAtEpochMs?: number | null;
    readonly acceptedConfig?: AuthoritativeTopologyReceipt['acceptedConfig'];
}

export function toAuthoritativeReceiptEvidence(
    appInboxResourceId: string,
    receipt: Readonly<AuthoritativeReceiptProjectionInput>,
    identityKind: ReceiptEffectIdentityKind
): AuthoritativeReceiptEvidence {
    return {
        appInboxResourceId,
        commandId: receipt.commandId,
        commandHash: receipt.commandHash,
        outcome: receipt.outcome,
        outboxIds: [...receipt.outboxIds],
        identityKind,
        ...(receipt.requestId !== undefined ? { requestId: receipt.requestId } : {}),
        ...(receipt.aggregateRef ? { aggregateRef: { ...receipt.aggregateRef } } : {}),
        ...(receipt.stateRevision !== undefined ? { stateRevision: receipt.stateRevision } : {}),
        ...(receipt.causalRevision ? { causalRevision: { ...receipt.causalRevision } } : {}),
        ...(receipt.snapshotVersion !== undefined ? { snapshotVersion: receipt.snapshotVersion } : {}),
        ...(receipt.eventId !== undefined ? { eventId: receipt.eventId } : {}),
        ...(receipt.operation &&
                receipt.target &&
                receipt.groupRef &&
                receipt.acceptedVersion !== undefined
            ? {
                topology: {
                    operation: receipt.operation,
                    target: receipt.target,
                    groupRef: { ...receipt.groupRef },
                    acceptedVersion: receipt.acceptedVersion,
                    acceptedStorageRevision: receipt.acceptedStorageRevision ?? null,
                    acceptedCreatedAtEpochMs: receipt.acceptedCreatedAtEpochMs ?? null,
                    acceptedUpdatedAtEpochMs: receipt.acceptedUpdatedAtEpochMs ?? null,
                    acceptedExpiresAtEpochMs: receipt.acceptedExpiresAtEpochMs ?? null,
                    acceptedConfig: receipt.acceptedConfig ?? null
                }
            }
            : {})
    };
}
