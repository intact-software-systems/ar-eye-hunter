import { describe, expect, it } from 'vitest';

import { RtcPeerConnectionAttemptBudget } from '@shared/services/rtc-peer-connection-attempt-budget.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';

const POLICY: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy = {
    enabled: true,
    maxAttempts: 3,
    maxTotalDurationMs: 10_000,
    cooldownMs: 5_000
};

interface BudgetState {
    readonly name: string;
    readonly policy: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy;
    // Each entry is the clock advance before one consume of the peer.
    readonly consumeAfterMs: readonly number[];
    readonly finalAdvanceMs: number;
    readonly refused: boolean;
}

const STATES: readonly BudgetState[] = [
    { name: 'a disabled budget', policy: { ...POLICY, enabled: false }, consumeAfterMs: [0, 0, 0, 0], finalAdvanceMs: 0, refused: false },
    { name: 'a peer with no attempt', policy: POLICY, consumeAfterMs: [], finalAdvanceMs: 0, refused: false },
    { name: 'a peer under both limits', policy: POLICY, consumeAfterMs: [0, 100], finalAdvanceMs: 100, refused: false },
    { name: 'a peer at its attempt limit', policy: POLICY, consumeAfterMs: [0, 100, 100], finalAdvanceMs: 100, refused: true },
    { name: 'a peer past its total duration', policy: POLICY, consumeAfterMs: [0], finalAdvanceMs: 10_000, refused: true },
    { name: 'an exhausted peer cooling down', policy: POLICY, consumeAfterMs: [0, 0, 0, 0], finalAdvanceMs: 4_999, refused: true },
    { name: 'an exhausted peer whose cooldown ended', policy: POLICY, consumeAfterMs: [0, 0, 0, 0], finalAdvanceMs: 5_000, refused: false }
];

describe('RtcPeerConnectionAttemptBudget', () => {
    it.each(STATES)('wouldRefuse and consume agree for $name', (state) => {
        let nowEpochMs = 1_000;
        const budget = new RtcPeerConnectionAttemptBudget({
            nowEpochMs: () => nowEpochMs,
            readPolicy: () => state.policy,
            onExhausted: () => {}
        });
        for (const advanceMs of state.consumeAfterMs) {
            nowEpochMs += advanceMs;
            budget.consume('peer-a');
        }
        nowEpochMs += state.finalAdvanceMs;

        const wouldRefuse = budget.wouldRefuse('peer-a');
        const refusal = budget.consume('peer-a');

        expect(wouldRefuse).toBe(state.refused);
        expect(refusal !== undefined).toBe(state.refused);
    });
});
