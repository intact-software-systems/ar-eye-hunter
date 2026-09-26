import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '../../al-contracts/al-control-type-ids.ts';
import { AL_RECEIPT_DEADLINE_GRACE_MS } from '../../al-contracts/al-control.ts';

const WS_QUEUE_BOX_SERVER_RECEIPT_REPUBLISH_MIN_MS = 1_000;

/** A receipt the server answered an origin with, travelling as one durable `WS_OUTBOX` row. */
export function isWsQueueBoxServerReceiptRow(message: ALMessage): boolean {
    return message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID;
}

/**
 * How long a receipt whose origin has no session on this instance waits before it is published to the
 * cluster again: as long as it has already waited, from one second up to the receipt grace, and never
 * past a last publication one second before the row expires at its deadline plus that grace. An origin
 * that reconnects on any instance inside the window therefore receives it.
 */
export function toWsQueueBoxServerReceiptRepublishDelayMs(message: ALMessage, nowMs: number): number {
    const waitedMs = Math.min(
        AL_RECEIPT_DEADLINE_GRACE_MS,
        Math.max(WS_QUEUE_BOX_SERVER_RECEIPT_REPUBLISH_MIN_MS, nowMs - message.id.ts)
    );
    const lastPublicationAtMs = (message.constraints?.expiresAtMs ?? Number.POSITIVE_INFINITY) -
        WS_QUEUE_BOX_SERVER_RECEIPT_REPUBLISH_MIN_MS;
    return nowMs < lastPublicationAtMs
        ? Math.min(waitedMs, lastPublicationAtMs - nowMs)
        : WS_QUEUE_BOX_SERVER_RECEIPT_REPUBLISH_MIN_MS;
}
