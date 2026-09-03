import { Temporal } from '@js-temporal/polyfill';
import type { ALInboundComputationFacts } from './compute-al-inbound-admission.ts';

export interface ALInboundComputationFactSource {
    readonly selfPeerId: string;
    readonly inboxEntryTypeId: string;
    readonly clock: { nowMs(): number; };
}

export function readALInboundComputationFacts(
    source: ALInboundComputationFactSource
): ALInboundComputationFacts {
    return {
        selfPeerId: source.selfPeerId,
        inboxEntryTypeId: source.inboxEntryTypeId,
        messageIdentitySeed: crypto.randomUUID(),
        observedAtEpochMs: source.clock.nowMs(),
        inboxAudit: {
            date: Temporal.Now.plainTimeISO(),
            createdTs: Temporal.Now.plainDateTimeISO()
        }
    };
}
