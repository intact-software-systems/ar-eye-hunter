import {
    validateAuthoritativeGroupEvent,
    validateAuthoritativeGroupSnapshot
} from '@shared/api/authoritative-state-validation.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import type { GroupEventType } from '@shared/api/group-types.ts';

type GroupPublicResultEventPolicy = Readonly<{
    eventTypes: readonly GroupEventType[];
    allowsNoOp: boolean;
}>;

const GROUP_PUBLIC_RESULT_EVENT_POLICY: Readonly<Record<string, GroupPublicResultEventPolicy>> = {
    GROUP_CREATE: { eventTypes: ['group-created'], allowsNoOp: false },
    GROUP_UPDATE: {
        eventTypes: ['group-updated', 'group-archived', 'group-deleted'],
        allowsNoOp: true
    },
    GROUP_DIRECTOR_APPOINT: { eventTypes: ['group-updated'], allowsNoOp: false },
    GROUP_JOIN: {
        eventTypes: ['member-joined', 'member-admission-requested'],
        allowsNoOp: true
    },
    GROUP_INVITE_CREATE: { eventTypes: ['member-invited'], allowsNoOp: true },
    GROUP_INVITE_REVOKE: { eventTypes: ['member-left'], allowsNoOp: true },
    // Acceptance shares computeJoin: an uninvited caller on an open-join
    // manager-approval group parks here exactly as a plain join would.
    GROUP_INVITE_ACCEPT: {
        eventTypes: ['member-joined', 'member-admission-requested'],
        allowsNoOp: true
    },
    GROUP_ADMISSION_GRANT: { eventTypes: ['member-joined'], allowsNoOp: true },
    GROUP_ADMISSION_DECLINE: { eventTypes: ['member-left'], allowsNoOp: true },
    GROUP_JOIN_CODE_ROTATE: { eventTypes: ['group-updated'], allowsNoOp: false },
    GROUP_MEMBER_REMOVE: { eventTypes: ['member-removed'], allowsNoOp: true },
    GROUP_MEMBER_BAN: { eventTypes: ['member-banned'], allowsNoOp: true },
    GROUP_MEMBER_UNBAN: { eventTypes: ['member-unbanned'], allowsNoOp: true },
    GROUP_MEMBER_ROLE_SET: {
        eventTypes: ['member-role-changed'],
        allowsNoOp: true
    },
    GROUP_OWNERSHIP_TRANSFER: {
        eventTypes: ['ownership-transferred'],
        allowsNoOp: true
    },
    GROUP_MEMBER_UPSERT: {
        eventTypes: [
            'member-invited',
            'member-admission-requested',
            'member-joined',
            'member-left',
            'member-removed',
            'member-banned'
        ],
        allowsNoOp: true
    }
};

export type GroupCausalRevision = Readonly<{
    groupRevision: number;
    presenceRevision: number;
}>;

export interface PublicResultReceiptIdentity {
    readonly outcome?: string;
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
    commandType?: string
): boolean {
    const result = record(resultValue);
    const right = record(record(result?.result)?.right);
    const snapshot = record(right?.snapshot);
    const aggregate = record(snapshot?.[kind === 'client' ? 'principal' : 'group']);
    const event = right?.event === null ? null : record(right?.event);
    if (
        kind === 'group' &&
        !authoritativeGroupResultContractsAreValid(snapshot, event, receipt.aggregateRef)
    ) {
        return false;
    }
    const aggregateMatches = receipt.aggregateRef !== undefined &&
        aggregate !== undefined &&
        Object.entries(receipt.aggregateRef).every(([key, value]) => aggregate[key] === value);
    const eventMatches = kind === 'group'
        ? groupPublicResultEventMatches(event, receipt, commandType)
        : receipt.eventId === null
        ? event === null
        : event !== undefined &&
            event?.eventId === receipt.eventId &&
            event?.requestId === receipt.requestId &&
            event?.snapshotVersion === receipt.snapshotVersion;
    const revisionMatches = kind === 'group'
        ? groupPublicResultRevisionMatches(snapshot, receipt)
        : snapshot?.stateRevision === receipt.stateRevision;
    return aggregateMatches && eventMatches && revisionMatches;
}

function groupPublicResultEventMatches(
    event: Record<string, unknown> | null | undefined,
    receipt: PublicResultReceiptIdentity,
    commandType: string | undefined
): boolean {
    const policy = commandType === undefined ? undefined : GROUP_PUBLIC_RESULT_EVENT_POLICY[commandType];
    if (!policy) {
        return false;
    }
    if (event === null || receipt.eventId === null) {
        return (
            event === null && receipt.eventId === null && receipt.outcome === 'no-op' && policy.allowsNoOp
        );
    }
    const accepted = causalRevision(receipt.causalRevision);
    const emitted = causalRevision(event?.causalRevision);
    return (
        event !== undefined &&
        accepted !== undefined &&
        emitted !== undefined &&
        receipt.outcome === 'applied' &&
        policy.eventTypes.includes(event.eventType as GroupEventType) &&
        event.eventId === receipt.eventId &&
        event.requestId === receipt.requestId &&
        event.snapshotVersion === receipt.snapshotVersion &&
        emitted.groupRevision === accepted.groupRevision &&
        emitted.presenceRevision === accepted.presenceRevision
    );
}

function authoritativeGroupResultContractsAreValid(
    snapshot: unknown,
    event: unknown,
    aggregateRef: PublicResultReceiptIdentity['aggregateRef']
): boolean {
    try {
        validateAuthoritativeGroupSnapshot(snapshot, aggregateRef);
        if (event !== null) {
            validateAuthoritativeGroupEvent(event, aggregateRef);
        }
        return true;
    }
    catch {
        return false;
    }
}

function groupPublicResultRevisionMatches(
    snapshotValue: unknown,
    receipt: PublicResultReceiptIdentity
): boolean {
    const snapshot = record(snapshotValue);
    const accepted = causalRevision(receipt.causalRevision);
    const observed = causalRevision(snapshot?.causalRevision);
    if (!snapshot || !accepted || !observed) {
        return false;
    }
    if (
        !Number.isSafeInteger(receipt.stateRevision) ||
        !Number.isSafeInteger(receipt.snapshotVersion) ||
        !Number.isSafeInteger(snapshot.stateRevision) ||
        receipt.snapshotVersion !== accepted.groupRevision
    ) {
        return false;
    }
    const causalOrderMatches = receipt.outcome === 'applied'
        ? observed.groupRevision === accepted.groupRevision &&
            observed.presenceRevision >= accepted.presenceRevision
        : receipt.outcome === 'no-op'
        ? observed.groupRevision >= accepted.groupRevision &&
            observed.presenceRevision >= accepted.presenceRevision
        : false;
    return (
        receipt.stateRevision ===
            toGroupSnapshotStateRevision(accepted.groupRevision, accepted.presenceRevision) &&
        snapshot.stateRevision ===
            toGroupSnapshotStateRevision(observed.groupRevision, observed.presenceRevision) &&
        causalOrderMatches
    );
}

function causalRevision(value: unknown): GroupCausalRevision | undefined {
    const candidate = record(value);
    const groupRevision = Number(candidate?.groupRevision);
    const presenceRevision = Number(candidate?.presenceRevision);
    return candidate &&
            exactKeys(candidate, ['groupRevision', 'presenceRevision']) &&
            Number.isSafeInteger(candidate.groupRevision) &&
            groupRevision >= 0 &&
            Number.isSafeInteger(candidate.presenceRevision) &&
            presenceRevision >= 0 &&
            groupRevision <= Number.MAX_SAFE_INTEGER - presenceRevision
        ? { groupRevision, presenceRevision }
        : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
