import { NonRetryableException } from '../../queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import { decodeALInboundWorkEntry, resolveALInboundWorkReadyAt } from './al-inbound-work-entry.ts';

export interface ALInboundWorkSelectionReadInput {
    readonly entries: readonly ResourceEntry[];
    readonly namespace: string;
    readonly nowMs: number;
}

export interface ALInboundWorkSelection {
    readonly entries: readonly ResourceEntry[];
    readonly rejectedReservations: readonly ResourceEntry[];
    readonly nextReadyAt: number | undefined;
}

/** Reads message eligibility before reservation so waiting work does not spend processing attempts. */
export async function readALInboundWorkSelection(
    input: ALInboundWorkSelectionReadInput,
    delivery: ALInboundAdmittedDelivery
): Promise<ALInboundWorkSelection> {
    const entries: ResourceEntry[] = [];
    const rejectedReservations: ResourceEntry[] = [];
    let nextReadyAt: number | undefined;
    for (const entry of input.entries) {
        if (entry.audit.expiryTs.epochMilliseconds <= input.nowMs) {
            continue;
        }
        try {
            const readyAt = resolveALInboundWorkReadyAt(entry);
            if (readyAt > input.nowMs) {
                nextReadyAt = Math.min(nextReadyAt ?? readyAt, readyAt, entry.audit.expiryTs.epochMilliseconds);
                continue;
            }
            const effect = decodeALInboundWorkEntry(entry, input.namespace);
            if (await delivery.readReadiness(effect, input.nowMs)) {
                entries.push(entry);
            }
        }
        catch (error) {
            if (!(error instanceof ALAdmissionCorruptionError) && !(error instanceof NonRetryableException)) {
                throw error;
            }
            if (entry.status === EntityStatus.RESERVED && entry.dequeueAudit.startTs === undefined) {
                // A missing lease timestamp cannot enter normal timeout reservation.
                rejectedReservations.push(entry);
            }
            else {
                entries.push(entry);
            }
        }
    }
    return { entries, rejectedReservations, nextReadyAt };
}
