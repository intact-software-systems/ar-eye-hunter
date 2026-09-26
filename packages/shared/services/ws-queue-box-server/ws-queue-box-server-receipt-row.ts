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
 * cluster again: as long as it has already waited, from one second up to the receipt grace. The row
 * expires at its deadline plus that grace, so an origin that reconnects on any instance inside the
 * window receives it on the next publication.
 */
export function toWsQueueBoxServerReceiptRepublishDelayMs(message: ALMessage, nowMs: number): number {
    return Math.min(
        AL_RECEIPT_DEADLINE_GRACE_MS,
        Math.max(WS_QUEUE_BOX_SERVER_RECEIPT_REPUBLISH_MIN_MS, nowMs - message.id.ts)
    );
}
