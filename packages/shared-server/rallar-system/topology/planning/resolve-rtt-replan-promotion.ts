import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

/** The browser's overlay transition grace: a layout replaced sooner churns edges still inside it. */
export const DEFAULT_RTT_REPLAN_MINIMUM_LAYOUT_AGE_MS = 15_000;
export const MAX_RTT_REPLAN_MINIMUM_LAYOUT_AGE_MS = 120_000;

export type RttReplanPromotion =
    | Readonly<{
        decision: 'hold';
        reason: 'layout-younger-than-minimum-age';
        layoutAgeMs: number;
    }>
    | Readonly<{
        decision: 'promote';
        reason: 'no-active-layout' | 'topology-inputs-changed' | 'presence-advanced' | 'layout-at-minimum-age';
        layoutAgeMs: number | null;
    }>;

export interface ResolveRttReplanPromotionInput {
    /** The stored planned layout the replan would replace; null before the first layout. */
    readonly stored: RallarOverlayTopologySnapshot | null;
    /** The topology inputs the stored layout was planned from; null when none were recorded. */
    readonly storedInputFingerprint: string | null;
    readonly inputFingerprint: string;
    readonly presenceRevision: number;
    readonly minimumLayoutAgeMs: number;
    readonly nowEpochMs: number;
}

/**
 * An RTT measurement changes no topology input the fingerprint names, so a replan it causes waits until the stored
 * layout has stood for the minimum age. A changed member, leader or configuration, or presence the stored layout
 * has not seen, promotes at once.
 */
export function resolveRttReplanPromotion(input: ResolveRttReplanPromotionInput): RttReplanPromotion {
    const { stored } = input;
    if (stored?.state !== 'active') {
        return { decision: 'promote', reason: 'no-active-layout', layoutAgeMs: null };
    }
    const layoutAgeMs = input.nowEpochMs - stored.updatedAtEpochMs;
    if (input.storedInputFingerprint !== input.inputFingerprint) {
        return { decision: 'promote', reason: 'topology-inputs-changed', layoutAgeMs };
    }
    if (stored.sourceGroupStateCausalRevision.presenceRevision < input.presenceRevision) {
        return { decision: 'promote', reason: 'presence-advanced', layoutAgeMs };
    }
    return layoutAgeMs < input.minimumLayoutAgeMs
        ? { decision: 'hold', reason: 'layout-younger-than-minimum-age', layoutAgeMs }
        : { decision: 'promote', reason: 'layout-at-minimum-age', layoutAgeMs };
}
