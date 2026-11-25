import type { PracticeInput } from '../practice-rules.ts';
import { TownMatchCheckpoints, type TownCheckpoint, type TownMatchAuthority } from './agreement/match-checkpoints.ts';
import { TownMatchRecoveryWindow } from './agreement/town-match-recovery-window.ts';
import type { TownMatchFrame } from './match-protocol.ts';
import { TownMatchLivePoses } from './realtime/town-match-live-poses.ts';
import type { TownMatchRoom } from './town-match-room.ts';
import type { TownMatchSession } from './town-match-session.ts';
import { TownMatchSimulation } from './town-match-simulation.ts';
import {
    computeTownMatchRecovery,
    computeTownMatchRoster,
    createTownMatch,
    type TownMatchIdentity,
    type TownMatchState
} from './town-match.ts';

export class TownMatchRound {
    readonly livePoses = new TownMatchLivePoses();
    readonly recovery = new TownMatchRecoveryWindow();
    inputTransport: 'rtc' | 'ws' | 'none' = 'none';
    checkpoints: TownMatchCheckpoints | undefined;
    simulation: TownMatchSimulation | undefined;
    members: readonly TownMatchIdentity[] = [];
    controls: PracticeInput = { x: 0, z: 0, dash: 0 };
    generation = 0;
    private authorityKey = '';
    private readonly dependencies: TownMatchSession.Dependencies;
    private readonly room: TownMatchRoom;
    private readonly signal: AbortSignal;
    intent: { readonly frame: TownMatchFrame; readonly sessionId: string; } | undefined;
    lastProposal: TownMatchFrame | undefined;
    committedProposal: TownMatchFrame | undefined;

    constructor(
        dependencies: TownMatchSession.Dependencies,
        room: TownMatchRoom,
        signal: AbortSignal
    ) {
        this.dependencies = dependencies;
        this.room = room;
        this.signal = signal;
    }

    reconcileAuthority({ director, members, departedIds }: TownMatchRoom.View): void {
        if (this.signal.aborted) {
            return;
        }
        const localSessionId = this.dependencies.browser.session()?.sessionId;
        if (localSessionId && !members.some((member) => member.sessionId === localSessionId)) {
            // Presence expiry can fence our transport before the browser receives a socket-close event.
            this.checkpoints?.interruptTransport();
        }
        if (!director.appointment) {
            return;
        }
        const authority = {
            epoch: director.appointment.epoch,
            sessionId: director.appointment.sessionId,
            members
        };
        const key = JSON.stringify([
            authority.epoch,
            authority.sessionId,
            members.map((member) => [member.id, member.sessionId])
        ]);
        if (key === this.authorityKey || !director.isFresh || members.length === 0) {
            return;
        }
        const previous = this.checkpoints?.getState();
        const source = previous?.committed?.state;
        const active = source?.phase === 'playing' || source?.phase === 'countdown';
        const working = active
            ? computeTownMatchRecovery({ state: source, members, departedIds, clock: this.dependencies.browser })
                .right ?? source
            : source
            ? computeTownMatchRoster(source, members).right
            : createTownMatch(this.dependencies.newMatchId(), members).right;
        this.changeAuthority(authority, key, working);
    }

    private changeAuthority(authority: TownMatchAuthority, key: string, working: TownMatchState | undefined): void {
        const session = this.dependencies.browser.session();
        if (!session) {
            return;
        }
        // A ready choice may still be in flight when another player joins or leaves.
        const retryReady = this.intent?.frame.action.kind === 'ready' && working?.phase === 'lobby' &&
            this.intent.frame.matchId === working.matchId && this.intent.frame.epoch === authority.epoch &&
            this.intent.sessionId === session.sessionId;
        if (!retryReady) {
            this.intent = undefined;
        }
        this.lastProposal = undefined;
        // A reloading peer has no in-memory state and needs the full agreed snapshot to rejoin.
        // Only the same appointed host can replay its original proposal in the same epoch.
        if (authority.sessionId !== session.sessionId || this.committedProposal?.epoch !== authority.epoch) {
            this.committedProposal = undefined;
        }
        this.members = authority.members;
        this.authorityKey = key;
        this.generation += 1;
        this.livePoses.clear();
        this.inputTransport = 'none';
        if (this.checkpoints) {
            this.checkpoints.changeAuthority(authority);
        }
        else {
            this.checkpoints = new TownMatchCheckpoints(authority, session.sessionId);
        }
        this.simulation?.stop();
        this.simulation = working ? new TownMatchSimulation(working, this.dependencies.timers.nowMs()) : undefined;
        this.controls = {
            x: 0,
            z: 0,
            dash: working?.players.find((player) => player.id === session.clientId)
                ?.consumedDash ?? 0
        };
    }

    interruptTransport(): void {
        this.generation += 1;
        this.livePoses.clear();
        this.inputTransport = 'none';
        const authority = this.checkpoints?.getState().authority;
        this.checkpoints?.interruptTransport();
        if (authority?.sessionId !== this.dependencies.browser.session()?.sessionId) {
            this.lastProposal = undefined;
            this.committedProposal = undefined;
        }
        if (this.intent?.frame.action.kind !== 'ready') {
            this.intent = undefined;
        }
        this.simulation?.pause(this.dependencies.timers.nowMs());
        this.controls = { x: 0, z: 0, dash: this.controls.dash };
    }

    interruptSimulation(view: TownMatchSession.View): void {
        if (this.signal.aborted || !view.interruption || !view.isDirector || !view.match) {
            return;
        }
        const source = this.checkpoints?.getState().recoveryCheckpoint?.state ?? view.match;
        if (source.matchId !== view.match.matchId) {
            return;
        }
        const state = computeTownMatchRoster(source, this.members).right;
        const working = this.simulation?.getState();
        const phase = source.phase === 'finished' ? 'finished' : 'interrupted';
        if (
            state &&
            (working?.phase !== phase || working.tick !== state.tick ||
                working.countdownTicks !== state.countdownTicks)
        ) {
            this.simulation?.stop();
            this.simulation = new TownMatchSimulation({
                ...state,
                phase,
                interruption: source.phase === 'finished' ? undefined : view.interruption
            }, this.dependencies.timers.nowMs());
        }
    }

    restoreRecovery(recovery: TownMatchCheckpoints.State, view: TownMatchSession.View): boolean {
        const source = recovery.recoveryCheckpoint?.state;
        if (
            !recovery.recoveryRequired || !recovery.recovered || !source ||
            (view.interruption && source.matchId === view.match?.matchId)
        ) {
            return true;
        }
        const working = source.phase === 'playing' || source.phase === 'countdown'
            ? computeTownMatchRecovery({
                state: source,
                members: this.members,
                departedIds: this.room.getView().departedIds,
                clock: this.dependencies.browser
            }).right
            : computeTownMatchRoster(source, this.members).right;
        if (!working) {
            return false;
        }
        this.simulation?.stop();
        this.simulation = new TownMatchSimulation(working, this.dependencies.timers.nowMs());
        return true;
    }

    confirmReplayedFrames(committed: TownCheckpoint | undefined, localId: string | undefined): void {
        if (!committed) return;
        if (this.lastProposal?.sequence === committed.sequence) {
            this.committedProposal = this.lastProposal;
            this.lastProposal = undefined;
        }
        const action = this.intent?.frame.action;
        if (!action) return;
        const state = committed.state;
        const local = state.members.find((member) => member.id === localId);
        if (
            (action.kind === 'ready' && local?.ready === action.ready) ||
            (action.kind === 'start' && state.phase !== 'lobby') ||
            (action.kind === 'extend' && (state.phase !== 'playing' ||
                state.tick + state.remainingTicks > action.expectedDurationTicks)) ||
            (action.kind === 'rematch' && state.matchId === action.nextMatchId)
        ) {
            this.intent = undefined;
        }
    }
}
