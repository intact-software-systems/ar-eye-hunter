import { FORMATION_LAYOUT_QUIET_WINDOW_MS } from '../../black-box-runner/browser/rallar-browser-runtime/formation/formation-held-reshape-reading.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import type { RallarBlackBoxTestLoopCommand } from '../rallar-black-box-test-contracts.ts';

const LAYOUT_RECHECK_INTERVAL_MS = 500;
const LAYOUT_READINESS_TIMEOUT_MS = 5_000;
// The default group lifecycle policy's `topology.reshapeMaxIntervalMs`; the policy presets stay out of the
// browser agents' ratcheted bundles.
const DEFAULT_RESHAPE_MAX_INTERVAL_MS = 60_000;

interface StableRtcLayoutWaitInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly prefix: string;
    /** How long the page may take to settle on a layout; the wait adds one held reshape to it. */
    readonly settleTimeoutMs: number;
}

/** The wait's whole limit: the settle allowance and one hold at the default policy's upper bound. */
export function toStableRtcLayoutWaitTimeoutMs(settleTimeoutMs: number): number {
    return settleTimeoutMs + DEFAULT_RESHAPE_MAX_INTERVAL_MS;
}

/**
 * Observe the current accepted layout throughout setup. Readiness is a point observation, so a planned-event
 * absence alone cannot prove it survived a group-first authority change. The formation owner resets the hold
 * when authority advances or the accepted body disappears. A reshape the gate holds publishes nothing, so the wait
 * also requires the formation view to state none. This bounds fixture setup, never message retries.
 */
export function createStableRtcLayoutWait(input: StableRtcLayoutWaitInput): RallarBlackBoxTestLoopCommand {
    const { prefix } = input;
    const timeoutMs = toStableRtcLayoutWaitTimeoutMs(input.settleTimeoutMs);
    return {
        kind: 'loop',
        commandId: `${prefix}-layout-stable`,
        count: Math.ceil(timeoutMs / LAYOUT_RECHECK_INTERVAL_MS),
        intervalMs: LAYOUT_RECHECK_INTERVAL_MS,
        timeoutMs,
        until: 'first-success',
        commands: [
            {
                kind: 'formation.readiness',
                commandId: `${prefix}-layout-readiness`,
                roomRef: { ...input.group },
                timeoutMs: LAYOUT_READINESS_TIMEOUT_MS
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-no-pending-layout`,
                operator: 'equals',
                source: `resultCache.${prefix}-layout-stable:i{loop.iteration}:c1:` +
                    `${prefix}-layout-readiness.value.hasPendingLayout`,
                expected: false
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-layout-stable`,
                operator: 'gte',
                source: `resultCache.${prefix}-layout-stable:i{loop.iteration}:c1:` +
                    `${prefix}-layout-readiness.value.acceptedHeldForMs`,
                expected: FORMATION_LAYOUT_QUIET_WINDOW_MS
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-no-held-reshape`,
                operator: 'equals',
                source: `resultCache.${prefix}-layout-stable:i{loop.iteration}:c1:` +
                    `${prefix}-layout-readiness.value.heldReshape.reading`,
                expected: 'none'
            }
        ]
    };
}
