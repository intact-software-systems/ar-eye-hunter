import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    isFailed,
    type ResourceEntry,
} from './ResourceEntry.ts';

export const COALESCED_APP_OUTBOX_WORK_FIELD = '__rallarCoalescedWork';

export type CoalescedAppOutboxWorkMetadata = Readonly<{
    generation: number;
    requestedAtEpochMs: number;
    dueAtEpochMs: number;
    reasons: readonly string[];
}>;

export type CoalescedAppOutboxWorkData<T extends object> =
    & T
    & Readonly<{
    [COALESCED_APP_OUTBOX_WORK_FIELD]: CoalescedAppOutboxWorkMetadata;
}>;

export type CoalescedAppOutboxWorkEnvelope<T extends object> = Readonly<{
    type: string;
    topicId: string;
    resourceId: string;
    contextId: string;
    senderId: string;
    data: CoalescedAppOutboxWorkData<T>;
}>;

export function isTerminalCoalescedStatus(status: EntityStatus): boolean {
    return COMPLETED_STATUSES.has(status) || isFailed(status);
}

export function isMutableCoalescedStatus(status: EntityStatus): boolean {
    return status === EntityStatus.NEW || status === EntityStatus.RETRY;
}

export function tryReadCoalescedAppOutboxWorkEnvelope<T extends object>(
    entry: ResourceEntry,
): CoalescedAppOutboxWorkEnvelope<T> | undefined {
    try {
        const message = JSON.parse(entry.resource) as ALMessage;
        const envelope = JSON.parse(
            message.payload.resource,
        ) as CoalescedAppOutboxWorkEnvelope<T>;
        return isCoalescedEnvelope(envelope) ? envelope : undefined;
    } catch {
        return undefined;
    }
}

function isCoalescedEnvelope(
    value: unknown,
): value is CoalescedAppOutboxWorkEnvelope<object> {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const maybe = value as Partial<CoalescedAppOutboxWorkEnvelope<object>>;
    const data = maybe.data as Record<string, unknown> | undefined;
    const metadata = data?.[COALESCED_APP_OUTBOX_WORK_FIELD] as
        | Partial<CoalescedAppOutboxWorkMetadata>
        | undefined;

    return typeof maybe.type === 'string' &&
        typeof maybe.topicId === 'string' &&
        typeof maybe.resourceId === 'string' &&
        typeof maybe.contextId === 'string' &&
        typeof maybe.senderId === 'string' &&
        typeof metadata?.generation === 'number' &&
        typeof metadata.requestedAtEpochMs === 'number' &&
        typeof metadata.dueAtEpochMs === 'number';
}
