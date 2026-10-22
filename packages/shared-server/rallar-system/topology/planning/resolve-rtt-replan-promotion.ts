import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export const MAX_RTT_REPLAN_MINIMUM_LAYOUT_AGE_MS = 120_000;

export type RttReplanPromotion =
    | Readonly<{
        decision: 'hold';
        reason: 'layout-younger-than-minimum-age';
        layoutAgeMs: number;
    }>
    | Readonly<{
        decision: 'promote';
        reason: 'no-active-layout';
    }>
    | Readonly<{
        decision: 'promote';
        reason: 'topology-inputs-changed' | 'presence-advanced' | 'layout-at-minimum-age';
        layoutAgeMs: number;
    }>;

export type PromotedRttReplan = Extract<RttReplanPromotion, { decision: 'promote'; }>;

export type HeldRttReplan = Extract<RttReplanPromotion, { decision: 'hold'; }>;

/** What the age of an active stored layout decides; without one, a replan promotes at once. */
export type JudgedRttReplan = Exclude<RttReplanPromotion, { reason: 'no-active-layout'; }>;

export interface ResolveRttReplanPromotionInput {
    /** The active stored layout the replan would replace. */
    readonly stored: RallarOverlayTopologySnapshot;
    /** The topology inputs the stored layout was planned from; null when none were recorded. */
    readonly storedInputFingerprint: string | null;
    readonly inputFingerprint: string;
    readonly presenceRevision: number;
    readonly rttReplanMinimumLayoutAgeMs: number;
    readonly nowEpochMs: number;
}

/**
 * An RTT measurement changes no topology input the fingerprint names, so a replan it causes waits until the stored
 * layout has stood for the minimum age. A changed member, leader or configuration, or presence the stored layout
 * has not seen, promotes at once.
 */
export function resolveRttReplanPromotion(input: ResolveRttReplanPromotionInput): JudgedRttReplan {
    const { stored } = input;
    const layoutAgeMs = input.nowEpochMs - stored.updatedAtEpochMs;
    if (input.storedInputFingerprint !== input.inputFingerprint) {
        return { decision: 'promote', reason: 'topology-inputs-changed', layoutAgeMs };
    }
    if (stored.sourceGroupStateCausalRevision.presenceRevision < input.presenceRevision) {
        return { decision: 'promote', reason: 'presence-advanced', layoutAgeMs };
    }
    return layoutAgeMs < input.rttReplanMinimumLayoutAgeMs
        ? { decision: 'hold', reason: 'layout-younger-than-minimum-age', layoutAgeMs }
        : { decision: 'promote', reason: 'layout-at-minimum-age', layoutAgeMs };
}
