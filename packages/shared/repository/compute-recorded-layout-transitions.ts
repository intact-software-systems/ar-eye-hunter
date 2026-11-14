import { MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS } from '../api/api-config.ts';
import { isSameGroupLayoutIdentity } from '../api/group-lifecycle/group-layout-identity.ts';
import type { OverlayLayoutTransition } from './overlay-layout-transition.ts';

/**
 * A memory guard, not a timing bound: fifteen layouts a second apart inside the largest overlap, plus one. Time bounds
 * the history; this count only keeps a clock that never advances from growing it, and drops the oldest first.
 */
export const MAX_RECORDED_LAYOUT_TRANSITIONS = 16;

/**
 * The history after `transition` is recorded, newest first. An entry stays while the largest overlap any session may
 * be served, measured from its own replacement instant, has not passed; an entry stamped after the new one (a clock
 * that stepped back) goes. A replacement already recorded is recorded once, with the newer stamp.
 */
export function computeRecordedLayoutTransitions(
    recorded: readonly OverlayLayoutTransition[],
    transition: OverlayLayoutTransition
): readonly OverlayLayoutTransition[] {
    const nowEpochMs = transition.replacedAtEpochMs;
    const kept = recorded.filter((entry) =>
        entry.replacedAtEpochMs <= nowEpochMs &&
        nowEpochMs < entry.replacedAtEpochMs + MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS &&
        !isSameGroupLayoutIdentity(entry.replacedBy, transition.replacedBy)
    );
    return [transition, ...kept].slice(0, MAX_RECORDED_LAYOUT_TRANSITIONS);
}
