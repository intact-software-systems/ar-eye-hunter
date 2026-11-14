import { MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS } from '../api/api-config.ts';
import type { OverlayLayoutTransition } from './overlay-layout-transition.ts';

/**
 * A memory guard, not a timing bound. Time bounds the history; this count only keeps a clock that never advances, or
 * promotions that arrive faster than one a second, from growing it. More than sixteen promotions inside the largest
 * overlap drop the oldest first even while its own window is still open, which is accepted.
 */
export const MAX_RECORDED_LAYOUT_TRANSITIONS = 16;

/**
 * The history after `transition` is recorded, newest first. An entry stays while the largest overlap any session may
 * be served, measured from its own replacement instant, has not passed; an entry stamped after the new one (a clock
 * that stepped back) goes. Layout dominance is a strict order, so a replacement is recorded once and a replaced layout
 * is not replaced by the same layout again until a removal has cleared the history.
 */
export function computeRecordedLayoutTransitions(
    recorded: readonly OverlayLayoutTransition[],
    transition: OverlayLayoutTransition
): readonly OverlayLayoutTransition[] {
    const nowEpochMs = transition.replacedAtEpochMs;
    const kept = recorded.filter((entry) =>
        entry.replacedAtEpochMs <= nowEpochMs &&
        nowEpochMs < entry.replacedAtEpochMs + MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS
    );
    return [transition, ...kept].slice(0, MAX_RECORDED_LAYOUT_TRANSITIONS);
}
