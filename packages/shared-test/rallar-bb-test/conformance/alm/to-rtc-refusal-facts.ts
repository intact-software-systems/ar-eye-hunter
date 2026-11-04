import type { ALDeliveryRefusalReason } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { AlmConformanceVerdictFact } from './alm-conformance-message-commands.ts';

/**
 * A send refused before its first carrier attempt for `reason`, so no carrier, WS included, carries it. The RTC carrier
 * refuses a send it cannot carry `unsupported` at admission, a carrier-unsupported rejection no carrier attempt follows.
 */
export function toRtcRefusalFacts(reason: ALDeliveryRefusalReason): readonly AlmConformanceVerdictFact[] {
    return [
        ['refused', 'failure.kind', 'equals', 'refused'],
        [reason, 'failure.reason', 'equals', reason],
        ['no-attempt', 'attempts', 'equals', 0]
    ];
}
