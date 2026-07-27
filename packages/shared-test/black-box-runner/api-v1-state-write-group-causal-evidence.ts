import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import {
    validateAuthoritativeGroupEvent,
    validateAuthoritativeGroupSnapshot,
} from '@shared/api/authoritative-state-validation.ts';

export type GroupCausalRevision = Readonly<{
    groupRevision: number;
    presenceRevision: number;
}>;

export interface PublicResultReceiptIdentity {
    readonly requestId?: string | null;
    readonly aggregateRef?: Readonly<{
        applicationId: string;
        workspaceId: string;
        principalId?: string;
        groupId?: string;
    }>;
    readonly stateRevision?: number;
    readonly causalRevision?: GroupCausalRevision;
    readonly snapshotVersion?: number;
    readonly eventId?: string | null;
}

export function publicResultIdentityMatches(
    resultValue: unknown,
    receipt: PublicResultReceiptIdentity,
    kind: 'client' | 'group',
): boolean {
    const result = record(resultValue);
    const right = record(record(result?.result)?.right);
    const snapshot = record(right?.snapshot);
    const aggregate = record(snapshot?.[kind === 'client' ? 'principal' : 'group']);
    const event = right?.event === null ? null : record(right?.event);
    if (kind === 'group' && !authoritativeGroupResultContractsAreValid(
        snapshot,
        event,
        receipt.aggregateRef,
    )) return false;
    const aggregateMatches = receipt.aggregateRef !== undefined && aggregate !== undefined &&
        Object.entries(receipt.aggregateRef).every(([key, value]) => aggregate[key] === value);
    const eventMatches = receipt.eventId === null
        ? event === null
        : event !== undefined && event?.eventId === receipt.eventId &&
            event?.requestId === receipt.requestId &&
            event?.snapshotVersion === receipt.snapshotVersion;
    const revisionMatches = kind === 'group'
        ? groupPublicResultRevisionMatches(snapshot, receipt)
        : snapshot?.stateRevision === receipt.stateRevision;
    return aggregateMatches && eventMatches && revisionMatches;
}

function authoritativeGroupResultContractsAreValid(
    snapshot: unknown,
    event: unknown,
    aggregateRef: PublicResultReceiptIdentity['aggregateRef'],
): boolean {
    try {
        validateAuthoritativeGroupSnapshot(snapshot, aggregateRef);
        if (event !== null) validateAuthoritativeGroupEvent(event, aggregateRef);
        return true;
    } catch {
        return false;
    }
}

function groupPublicResultRevisionMatches(
    snapshotValue: unknown,
    receipt: PublicResultReceiptIdentity,
): boolean {
    const snapshot = record(snapshotValue);
    const accepted = causalRevision(receipt.causalRevision);
    const observed = causalRevision(snapshot?.causalRevision);
    if (!snapshot || !accepted || !observed) return false;
    if (!Number.isSafeInteger(receipt.stateRevision) ||
        !Number.isSafeInteger(snapshot.stateRevision)) return false;
    return receipt.stateRevision === toGroupSnapshotStateRevision(
            accepted.groupRevision,
            accepted.presenceRevision,
        ) && snapshot.stateRevision === toGroupSnapshotStateRevision(
            observed.groupRevision,
            observed.presenceRevision,
        ) && observed.groupRevision === accepted.groupRevision &&
        observed.presenceRevision >= accepted.presenceRevision;
}

function causalRevision(value: unknown): GroupCausalRevision | undefined {
    const candidate = record(value);
    const groupRevision = Number(candidate?.groupRevision);
    const presenceRevision = Number(candidate?.presenceRevision);
    return candidate && exactKeys(candidate, ['groupRevision', 'presenceRevision']) &&
            Number.isSafeInteger(candidate.groupRevision) && groupRevision >= 0 &&
            Number.isSafeInteger(candidate.presenceRevision) && presenceRevision >= 0 &&
            groupRevision <= Number.MAX_SAFE_INTEGER - presenceRevision
        ? { groupRevision, presenceRevision }
        : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) =>
        key === expected[index]);
}
