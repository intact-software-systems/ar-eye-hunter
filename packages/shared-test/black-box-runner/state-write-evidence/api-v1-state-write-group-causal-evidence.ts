import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import {
    validateAuthoritativeGroupEvent,
    validateAuthoritativeGroupSnapshot
} from '@shared/api/authoritative-state-validation.ts';
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
    GROUP_PUBLICATION_GRANT: { eventTypes: ['publication-grant-changed'], allowsNoOp: true },
    GROUP_PUBLICATION_REVOKE: { eventTypes: ['publication-grant-changed'], allowsNoOp: true },
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

/** The caller holds the parsed result as a record; it is decoded here before any field is compared. */
export function publicResultIdentityMatches(
    resultValue: object,
    receipt: PublicResultReceiptIdentity,
    kind: 'client' | 'group',
    commandType?: string
): boolean {
    const result = decodeJsonRecord(resultValue);
    const written = decodeJsonRecord(result?.result);
    const snapshot = decodeJsonRecord(written?.snapshot);
    const aggregate = decodeJsonRecord(snapshot?.[kind === 'client' ? 'principal' : 'group']);
    const event = written?.event === null ? null : decodeJsonRecord(written?.event);
    if (
        result === undefined ||
        (kind === 'group' && !authoritativeGroupResultContractsAreValid(snapshot, event, receipt.aggregateRef))
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
    event: ApiJsonObject | null | undefined,
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
    const accepted = decodeCausalRevision(receipt.causalRevision);
    const emitted = decodeCausalRevision(event?.causalRevision);
    const eventType = event?.eventType;
    return (
        event !== undefined &&
        accepted !== undefined &&
        emitted !== undefined &&
        receipt.outcome === 'applied' &&
        policy.eventTypes.some((allowed) => allowed === eventType) &&
        event.eventId === receipt.eventId &&
        event.requestId === receipt.requestId &&
        event.snapshotVersion === receipt.snapshotVersion &&
        emitted.groupRevision === accepted.groupRevision &&
        emitted.presenceRevision === accepted.presenceRevision
    );
}

function authoritativeGroupResultContractsAreValid(
    snapshot: ApiJsonObject | undefined,
    event: ApiJsonObject | null | undefined,
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
    snapshot: ApiJsonObject | undefined,
    receipt: PublicResultReceiptIdentity
): boolean {
    const accepted = decodeCausalRevision(receipt.causalRevision);
    const observed = decodeCausalRevision(snapshot?.causalRevision);
    if (!snapshot || !accepted || !observed) {
        return false;
    }
    if (
        !Number.isSafeInteger(receipt.snapshotVersion) ||
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
    return causalOrderMatches;
}

function decodeCausalRevision(value: GroupCausalRevision | ApiJsonValue | undefined): GroupCausalRevision | undefined {
    const candidate = decodeJsonRecord(value);
    const { groupRevision, presenceRevision } = candidate ?? {};
    return candidate !== undefined &&
            exactKeys(candidate, ['groupRevision', 'presenceRevision']) &&
            typeof groupRevision === 'number' &&
            Number.isSafeInteger(groupRevision) &&
            groupRevision >= 0 &&
            typeof presenceRevision === 'number' &&
            Number.isSafeInteger(presenceRevision) &&
            presenceRevision >= 0
        ? { groupRevision, presenceRevision }
        : undefined;
}

/** Evidence results are parsed JSON, so an object here is a JSON object. */
function decodeJsonRecord(value: unknown): ApiJsonObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as ApiJsonObject)
        : undefined;
}

function exactKeys(value: ApiJsonObject, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
