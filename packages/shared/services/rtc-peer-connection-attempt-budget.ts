import type { PeerId } from '../api/api-config.ts';
import type { WebRtcConnectionService } from './web-rtc-connection-service.ts';

interface PeerConnectionAttemptState {
    readonly peerId: PeerId;
    readonly attempts: number;
    readonly firstAttemptAtEpochMs: number;
    readonly lastAttemptAtEpochMs: number;
    readonly exhaustedAtEpochMs?: number;
    readonly retryAfterEpochMs?: number;
}

interface ExhaustedPeerConnectionAttemptState extends PeerConnectionAttemptState {
    readonly exhaustedAtEpochMs: number;
    readonly retryAfterEpochMs: number;
}

type PeerConnectionAttemptStanding =
    | { readonly kind: 'within-budget'; }
    | { readonly kind: 'exhausted'; readonly state: PeerConnectionAttemptState; }
    | { readonly kind: 'cooling-down'; readonly state: ExhaustedPeerConnectionAttemptState; }
    | { readonly kind: 'cooldown-ended'; };

export namespace RtcPeerConnectionAttemptBudget {
    export interface Input {
        readonly nowEpochMs: () => number;
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

        const policy = this.input.readPolicy();
        return this.toPeerConnectionAttemptDiagnostics(state, policy);
    }

    readDiagnostics(): WebRtcConnectionService.PeerConnectionAttemptBudgetDiagnostics {
        return { ...this.attemptBudgetDiagnostics };
    }

    /** Whether `consume` would refuse this peer now; it changes nothing. */
    wouldRefuse(peerId: PeerId): boolean {
        const policy = this.input.readPolicy();
        const standing = this.resolveAttemptStanding(
            this.peerConnectionAttemptStateByPeerId.get(peerId),
            policy,
            this.input.nowEpochMs()
        );
        return standing.kind === 'cooling-down' || standing.kind === 'exhausted';
    }

    consume(
        peerId: PeerId
    ): WebRtcConnectionService.PeerConnectionAttemptExhaustedEvent | undefined {
        const policy = this.input.readPolicy();
        if (!policy.enabled) {
            return undefined;
        }

        const now = this.input.nowEpochMs();
        const standing = this.resolveAttemptStanding(this.peerConnectionAttemptStateByPeerId.get(peerId), policy, now);
        switch (standing.kind) {
            case 'cooling-down':
                return this.toPeerConnectionAttemptExhaustedEvent(standing.state, policy);
            case 'exhausted':
                return this.markPeerConnectionAttemptExhausted(standing.state, policy, now);
            case 'cooldown-ended':
                this.peerConnectionAttemptStateByPeerId.delete(peerId);
                this.attemptBudgetDiagnostics.cooldownExpiredClearCount += 1;
                break;
            case 'within-budget':
                break;
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

    private resolveAttemptStanding(
        current: PeerConnectionAttemptState | undefined,
        policy: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy,
        now: number
    ): PeerConnectionAttemptStanding {
        if (!policy.enabled || !current) {
            return { kind: 'within-budget' };
        }
        if (current.retryAfterEpochMs !== undefined && current.exhaustedAtEpochMs !== undefined) {
            const exhausted: ExhaustedPeerConnectionAttemptState = {
                ...current,
                exhaustedAtEpochMs: current.exhaustedAtEpochMs,
                retryAfterEpochMs: current.retryAfterEpochMs
            };
            return now < exhausted.retryAfterEpochMs
                ? { kind: 'cooling-down', state: exhausted }
                : { kind: 'cooldown-ended' };
        }
        return this.isPeerConnectionAttemptBudgetExhausted(current, policy, now)
            ? { kind: 'exhausted', state: current }
            : { kind: 'within-budget' };
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
        const exhausted: ExhaustedPeerConnectionAttemptState = {
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
        state: ExhaustedPeerConnectionAttemptState,
        policy: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy
    ): WebRtcConnectionService.PeerConnectionAttemptExhaustedEvent {
        return {
            ...this.toPeerConnectionAttemptDiagnostics(state, policy),
            exhaustedAtEpochMs: state.exhaustedAtEpochMs,
            retryAfterEpochMs: state.retryAfterEpochMs,
            reason: 'peer-connection-attempt-budget-exhausted'
        };
    }

    private toPeerConnectionAttemptDiagnostics(
        state: PeerConnectionAttemptState,
        policy: WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy
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
