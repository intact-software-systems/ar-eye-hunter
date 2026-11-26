import type {
    ALDeliveryFallbackReason,
    ALDeliveryRefusalReason
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { AlmConformanceVerdictFact } from '../alm-conformance-message-commands.ts';
import type { AlmCarrierOutcome } from './alm-carrier-matrix.ts';

/**
 * The outcomes one list of facts on the sender's handle states for every cell that proves them. No other outcome has
 * such a list, so the cell that proves one asserts its evidence itself: a delivery reads a receipt or an arrival; a
 * refusal by the trusted server settles the handle only of a send that asked a receipt; a refusal by a peer or a
 * receiver is stated on the page that refuses; a hand-over at admission is the RTC leg's own attempt row, which no
 * cell reads yet; an undelivered send ends on a failure of its own kind.
 */
export type AlmCarrierHandleOutcome = Extract<
    AlmCarrierOutcome,
    | Readonly<{ kind: 'refused'; by: 'origin'; }>
    | Readonly<{ kind: 'handed-to-ws'; at: 'routing' | 'after-admission'; }>
>;

/** A send a strategy that allows WS routes there at once: one WS attempt and no hand-over from an RTC leg. */
const WS_ROUTE_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['one-attempt', 'attempts', 'equals', 1],
    ['ws-attempt', 'attemptCarriers.0', 'equals', 'ws'],
    ['no-fallback', 'carrierFallback', 'exists', false]
];

/** What the sender's handle holds once its send came to `outcome`, each fact named for the assertion that reads it. */
export function toAlmCarrierOutcomeFacts(outcome: AlmCarrierHandleOutcome): readonly AlmConformanceVerdictFact[] {
    if (outcome.kind === 'refused') {
        return toOriginRefusalFacts(outcome.reason);
    }
    return outcome.at === 'routing' ? WS_ROUTE_FACTS : toHandOverFacts(outcome.reason);
}

/**
 * A send refused before its first carrier attempt for `reason`, so no carrier, WS included, carries it. Called with a
 * bare reason by a cell whose refusal no capability of the matrix states.
 */
export function toOriginRefusalFacts(reason: ALDeliveryRefusalReason): readonly AlmConformanceVerdictFact[] {
    return [
        ['refused', 'failure.kind', 'equals', 'refused'],
        [reason, 'failure.reason', 'equals', reason],
        ['no-attempt', 'attempts', 'equals', 0]
    ];
}

/** The D56 hand-over of a message RTC had admitted: from RTC to WS, for `reason`. */
function toHandOverFacts(reason: ALDeliveryFallbackReason): readonly AlmConformanceVerdictFact[] {
    return [
        ['fallback-from', 'carrierFallback.from', 'equals', 'rtc'],
        ['fallback-to', 'carrierFallback.to', 'equals', 'ws'],
        ['fallback-reason', 'carrierFallback.reason', 'equals', reason]
    ];
}
