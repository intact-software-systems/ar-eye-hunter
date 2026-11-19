import { toALGapRequestNumberField } from '../../../al-contracts/al-control-value-codec.ts';
import type { ALNackPayload, ALRepairPayload } from '../../../al-contracts/al-control.ts';

/** A hint's gap request number: the control's when the control names a missing range; a hint naming none carries none. */
export function toALOutboundRepairHintGapRequestNumber(
    payload: ALNackPayload | ALRepairPayload
): Readonly<{ gapRequestNumber?: number; }> {
    return (payload.missingRanges ?? []).length > 0 ? toALGapRequestNumberField(payload.gapRequestNumber) : {};
}
