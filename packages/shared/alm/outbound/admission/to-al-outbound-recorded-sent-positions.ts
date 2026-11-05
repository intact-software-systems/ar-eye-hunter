import type { ALOutboundMessageReadDto } from './al-outbound-admission-store.ts';

/** The positions this read recorded, else those the row's first recording kept: each copy's entry derives from them. */
export function toALOutboundRecordedSentPositions<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>
): Readonly<Record<string, number>> | null {
    return read.sentPositions?.priorSeqByRecipient ?? read.storedMessage?.sentPositions ?? null;
}
