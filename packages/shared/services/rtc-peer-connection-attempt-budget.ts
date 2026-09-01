import { PeerId } from '../api/api-config.ts';
import type { WebRtcConnectionService } from './web-rtc-connection-service.ts';

interface PeerConnectionAttemptState {
    peerId: PeerId;
    attempts: number;
    firstAttemptAtEpochMs: number;
    lastAttemptAtEpochMs: number;
    exhaustedAtEpochMs?: number;
    retryAfterEpochMs?: number;
}

export namespace RtcPeerConnectionAttemptBudget {
    export interface Input {
        readonly readPolicy: () => WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy;
        readonly onExhausted: (event: WebRtcConnectionService.PeerConnectionAttemptExhaustedEvent) => void;
    }
}

export class RtcPeerConnectionAttemptBudget {
    private readonly peerConnectionAttemptStateByPeerId = new Map<PeerId, PeerConnectionAttemptState>();
    private readonly attemptBudgetDiagnostics = {
        consumedCount: 0,
        resetOnSuccessCount: 0,
        resetOnRemovalCount: 0,
        cooldownExpiredClearCount: 0,
        exhaustedCount: 0
    };
    private readonly input: RtcPeerConnectionAttemptBudget.Input;

    constructor(input: RtcPeerConnectionAttemptBudget.Input) {
        this.input = input;
    }

    readPeer(
        peerId: PeerId
    ): WebRtcConnectionService.PeerConnectionAttemptDiagnostics | undefined {
        const state = this.peerConnectionAttemptStateByPeerId.get(peerId);
        if (!state) {
            return undefined;
        }

        return this.toPeerConnectionAttemptDiagnostics(state);
    }

    readDiagnostics(): WebRtcConnectionService.PeerConnectionAttemptBudgetDiagnostics {
        return { ...this.attemptBudgetDiagnostics };
    }

    consume(
        peerId: PeerId
    ): WebRtcConnectionService.PeerConnectionAttemptExhaustedEvent | undefined {
        const policy = this.input.readPolicy();
        if (!policy.enabled) {
            return undefined;
        }

        const now = Date.now();
        const current = this.peerConnectionAttemptStateByPeerId.get(peerId);
        if (
            current?.retryAfterEpochMs !== undefined &&
            current.exhaustedAtEpochMs !== undefined
        ) {
            if (now < current.retryAfterEpochMs) {
                return this.toPeerConnectionAttemptExhaustedEvent(
                    current,
                    policy
                );
            }

            this.peerConnectionAttemptStateByPeerId.delete(peerId);
            this.attemptBudgetDiagnostics.cooldownExpiredClearCount += 1;
        }
        else if (
            current &&
            this.isPeerConnectionAttemptBudgetExhausted(current, policy, now)
        ) {
            return this.markPeerConnectionAttemptExhausted(
                current,
                policy,
                now
            );
        }

        const latest = this.peerConnectionAttemptStateByPeerId.get(peerId);
        const next: PeerConnectionAttemptState = latest
            ? {
                ...latest,
                attempts: latest.attempts + 1,
                lastAttemptAtEpochMs: now
            }
            : {
                peerId,
                attempts: 1,
                firstAttemptAtEpochMs: now,
                lastAttemptAtEpochMs: now
            };
        this.peerConnectionAttemptStateByPeerId.set(peerId, next);
        this.attemptBudgetDiagnostics.consumedCount += 1;
        return undefined;
    }

    private isPeerConnectionAttemptBudgetExhausted(
        state: PeerConnectionAttemptState,
        policy: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy,
        now: number
    ): boolean {
        return state.attempts >= policy.maxAttempts ||
            now - state.firstAttemptAtEpochMs >= policy.maxTotalDurationMs;
    }

    private markPeerConnectionAttemptExhausted(
        state: PeerConnectionAttemptState,
        policy: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy,
        exhaustedAtEpochMs: number
    ): WebRtcConnectionService.PeerConnectionAttemptExhaustedEvent {
        const exhausted: PeerConnectionAttemptState = {
            ...state,
            exhaustedAtEpochMs,
            retryAfterEpochMs: exhaustedAtEpochMs + policy.cooldownMs
        };
        this.peerConnectionAttemptStateByPeerId.set(state.peerId, exhausted);
        this.attemptBudgetDiagnostics.exhaustedCount += 1;
        const event = this.toPeerConnectionAttemptExhaustedEvent(
            exhausted,
            policy
        );
        this.input.onExhausted(event);
        return event;
    }

    private toPeerConnectionAttemptExhaustedEvent(
        state: PeerConnectionAttemptState,
        policy: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy
    ): WebRtcConnectionService.PeerConnectionAttemptExhaustedEvent {
        return {
            ...this.toPeerConnectionAttemptDiagnostics(state, policy),
            exhaustedAtEpochMs: state.exhaustedAtEpochMs ??
                state.lastAttemptAtEpochMs,
            retryAfterEpochMs: state.retryAfterEpochMs ??
                state.lastAttemptAtEpochMs + policy.cooldownMs,
            reason: 'peer-connection-attempt-budget-exhausted'
        };
    }

    private toPeerConnectionAttemptDiagnostics(
        state: PeerConnectionAttemptState,
        policy: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy = this.input.readPolicy()
    ): WebRtcConnectionService.PeerConnectionAttemptDiagnostics {
        return {
            peerId: state.peerId,
            attempts: state.attempts,
            firstAttemptAtEpochMs: state.firstAttemptAtEpochMs,
            lastAttemptAtEpochMs: state.lastAttemptAtEpochMs,
            maxAttempts: policy.maxAttempts,
            maxTotalDurationMs: policy.maxTotalDurationMs,
            cooldownMs: policy.cooldownMs,
            exhaustedAtEpochMs: state.exhaustedAtEpochMs,
            retryAfterEpochMs: state.retryAfterEpochMs
        };
    }

    clear(
        peerId: PeerId,
        reason: 'established' | 'removal'
    ): void {
        if (!this.peerConnectionAttemptStateByPeerId.delete(peerId)) {
            return;
        }
        if (reason === 'established') {
            this.attemptBudgetDiagnostics.resetOnSuccessCount += 1;
        }
        else {
            this.attemptBudgetDiagnostics.resetOnRemovalCount += 1;
        }
    }
}
