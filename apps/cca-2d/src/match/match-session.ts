import type {
    RallarMessage,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';

import type { PracticeInput } from '../practice-rules.ts';
import { TownMatchCheckpoints, type TownMatchAuthority } from './match-checkpoints.ts';
import {
    decodeTownMatchFrame,
    TOWN_MATCH_BUILD,
    TOWN_MATCH_PROTOCOL,
    validateTownMatchFrame,
    type TownMatchAction,
    type TownMatchFrame
} from './match-protocol.ts';
import { TownMatchRoom } from './match-room.ts';
import { TownMatchSimulation } from './match-simulation.ts';
import { createTownMatchSnapshot, decodeTownCheckpoint } from './match-snapshot.ts';
import {
    computeTownMatchRecovery,
    computeTownMatchRoster,
    createTownMatch,
    type TownMatchIdentity,
    type TownMatchState
} from './town-match.ts';

export namespace TownMatchSession {
    export type Intent =
        | Exclude<TownMatchAction, { readonly kind: 'ready'; }>
        | { readonly kind: 'ready'; readonly ready: boolean; };
    export interface Dependencies {
        readonly browser: Pick<RallarFacade, 'director' | 'messages' | 'rooms' | 'session' | 'isConnected' | 'ws'>;
        readonly timers: Timers;
        readonly subtle: Pick<SubtleCrypto, 'digest'>;
        readonly newMatchId: () => string;
    }
    export interface View {
        readonly match: TownMatchState | undefined;
        readonly localId: string | undefined;
        readonly isDirector: boolean;
        readonly available: boolean;
        readonly recovering: boolean;
        readonly observing: boolean;
        readonly interruption: string | undefined;
        readonly inputGeneration: number;
        readonly error: string;
    }
}

/** One room's authenticated match transport, director simulation and committed presentation state. */
export class TownMatchSession {
    private readonly subscriptions = new SubscriptionScope();
    private readonly verification = new SingleFlight<string, void>();
    private readonly changes = new SynchronousNotifications<void>((error) =>
        console.error('Match listener failed', error)
    );
    private readonly lifetime = new AbortController();
    private readonly channel: RallarTypedMessageChannel<string>;
    private readonly room: TownMatchRoom;
    private checkpoints: TownMatchCheckpoints | undefined;
    private simulation: TownMatchSimulation | undefined;
    private members: readonly TownMatchIdentity[] = [];
    private controls: PracticeInput = { x: 0, z: 0, dash: 0 };
    private sequence = 0;
    private generation = 0;
    private authorityKey = '';
    private error = '';
    private lastInput = 0;
    private lastExchange = 0;
    private lastCommitAt: number | undefined;
    private recoveryStartedAt: number | undefined;
    private interruptedMatchId: string | undefined;
    private intent: TownMatchFrame | undefined;
    private lastProposal: TownMatchFrame | undefined;
    private committedProposal: TownMatchFrame | undefined;

    private readonly dependencies: TownMatchSession.Dependencies;
    readonly roomRef: GroupRef;

    constructor(dependencies: TownMatchSession.Dependencies, roomRef: GroupRef) {
        this.dependencies = dependencies;
        this.roomRef = roomRef;
        this.channel = dependencies.browser.messages.room<string>({
            roomRef,
            topicId: 'app.cca.match',
            typeId: 'cca.match.frame',
            purpose: 'notification',
            access: 'members'
        });
        this.room = new TownMatchRoom(dependencies, roomRef);
    }

    start(): void {
        this.subscriptions.add(this.channel.onWs((payload, message) => this.receive(payload, message)));
        this.subscriptions.add(this.dependencies.browser.ws.onLifecycle((event) => {
            if (event.kind === 'close' || event.kind === 'disconnected') {
                this.interruptTransport();
            }
        }, { emitCurrent: false }));
        this.subscriptions.add(startRepeating({
            timers: this.dependencies.timers,
            intervalMs: 16,
            firstRun: 'after-interval',
            run: () => this.advance()
        }));
    }

    onChange(listener: () => void): () => void {
        return this.changes.subscribeAndNotify(listener, undefined).unsubscribe;
    }

    getView(): TownMatchSession.View {
        const director = this.dependencies.browser.director.status(this.roomRef);
        const available = !this.lifetime.signal.aborted && this.dependencies.browser.isConnected() && director.isFresh;
        const checkpoint = this.checkpoints?.getState();
        const match = checkpoint?.committed?.state;
        const authorityAligned = checkpoint?.authority.epoch === director.appointment?.epoch &&
            checkpoint?.authority.sessionId === director.appointment?.sessionId;
        const interruption = match && this.interruptedMatchId === match.matchId
            ? 'Round interrupted: recovery could not be confirmed. Your last confirmed points are preserved.'
            : undefined;
        return {
            match,
            localId: this.dependencies.browser.session()?.clientId,
            isDirector: director.isDirector,
            available,
            observing: Boolean(
                match &&
                    !match.seats.some((seat) =>
                        seat.id === this.dependencies.browser.session()?.clientId && seat.status === 'active'
                    )
            ),
            recovering: (match?.phase === 'playing' || match?.phase === 'countdown') &&
                (!available || !authorityAligned || Boolean(interruption) || checkpoint?.recoveryRequired === true ||
                    (this.lastCommitAt !== undefined &&
                        this.dependencies.timers.nowMs() - this.lastCommitAt >= 1500)),
            interruption,
            inputGeneration: this.generation,
            error: this.error
        };
    }

    setControls(controls: PracticeInput): void {
        this.controls = controls;
    }

    async appoint(): Promise<void> {
        try {
            await this.room.appoint();
            if (!this.lifetime.signal.aborted) {
                this.error = '';
                this.reconcileAuthority();
            }
        }
        catch (error) {
            this.report(error);
        }
    }

    async act(action: TownMatchSession.Intent): Promise<void> {
        const state = this.checkpoints?.getState().committed?.state;
        const view = this.getView();
        if (!state || !view.available || (action.kind === 'controls' && (view.recovering || view.observing))) {
            return;
        }
        const frame = this.createFrame(
            state.matchId,
            action.kind === 'ready'
                ? { ...action, displayName: this.dependencies.browser.session()?.username ?? '' }
                : action
        );
        if (action.kind === 'ready' || action.kind === 'start' || action.kind === 'rematch') {
            this.intent = frame;
        }
        await this.write(frame);
    }

    stop(): void {
        if (this.lifetime.signal.aborted) {
            return;
        }
        this.lifetime.abort();
        this.generation += 1;
        this.subscriptions.unsubscribe();
        this.room.stop();
        this.simulation?.stop();
    }

    private async advance(): Promise<void> {
        try {
            this.reconcileAuthority();
            await this.recoverConnection();
            if (this.lifetime.signal.aborted) {
                return;
            }
            if (!this.getView().available || !this.checkpoints) {
                this.simulation?.pause(this.dependencies.timers.nowMs());
                this.controls = { x: 0, z: 0, dash: this.controls.dash };
                this.changes.publishLatest(undefined);
                return;
            }
            const now = this.dependencies.timers.nowMs();
            const view = this.getView();
            if (view.recovering) {
                this.simulation?.pause(now);
                this.controls = { x: 0, z: 0, dash: this.controls.dash };
            }
            else if (view.isDirector) {
                this.simulation?.advance(now, this.checkpoints.getState().committed?.state);
            }
            const match = this.checkpoints.getState().committed?.state;
            if (match?.phase === 'playing' && now - this.lastInput >= 50) {
                this.lastInput = now;
                await this.act({ kind: 'controls', ...this.controls });
            }
            if (now - this.lastExchange >= 100) {
                this.lastExchange = now;
                await this.exchangeCheckpoints();
            }
            this.changes.publishLatest(undefined);
        }
        catch (error) {
            this.report(error);
        }
    }

    private interruptTransport(): void {
        this.generation += 1;
        const authority = this.checkpoints?.getState().authority;
        this.checkpoints?.interruptTransport();
        if (authority?.sessionId !== this.dependencies.browser.session()?.sessionId) {
            this.lastProposal = undefined;
            this.committedProposal = undefined;
        }
        this.simulation?.pause(this.dependencies.timers.nowMs());
        this.controls = { x: 0, z: 0, dash: this.controls.dash };
        this.intent = undefined;
        this.changes.publishLatest(undefined);
    }

    private reconcileAuthority(): void {
        if (this.lifetime.signal.aborted) {
            return;
        }
        const { director, members, departedIds } = this.room.getView();
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
            ? computeTownMatchRecovery({ state: source, members, departedIds, now: this.dependencies.timers.nowMs() })
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
        this.members = authority.members;
        this.authorityKey = key;
        this.generation += 1;
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
            dash: working?.players.find((player) => player.id === this.dependencies.browser.session()?.clientId)
                ?.consumedDash ?? 0
        };
        this.intent = undefined;
        this.lastProposal = undefined;
        this.committedProposal = undefined;
    }

    private async recoverConnection(): Promise<void> {
        const view = this.getView();
        if (!view.recovering) {
            this.recoveryStartedAt = undefined;
            if (view.match && !view.available) {
                await this.room.refreshForRecovery();
                this.reconcileAuthority();
            }
            return;
        }
        const now = this.dependencies.timers.nowMs();
        this.expireRecovery(view, now);
        this.simulation?.pause(now);
        await this.room.refreshForRecovery();
        this.reconcileAuthority();
        this.interruptSimulation();
    }

    private expireRecovery(view: TownMatchSession.View, now: number): void {
        if (!view.recovering || !view.match || this.lastCommitAt === undefined) {
            return;
        }
        this.recoveryStartedAt ??= Math.min(now, this.lastCommitAt + 1500);
        if (now - this.recoveryStartedAt >= 10000) {
            this.interruptedMatchId = view.match.matchId;
        }
    }

    private interruptSimulation(): void {
        const view = this.getView();
        if (this.lifetime.signal.aborted || !view.interruption || !view.isDirector || !view.match) {
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

    private async exchangeCheckpoints(): Promise<void> {
        if (!this.checkpoints) {
            return;
        }
        const state = this.checkpoints.getState();
        if (state.recoveryRequired && state.recoveryCheckpoint) {
            const recovery = state.recoveryCheckpoint;
            await this.write(this.createFrame(recovery.state.matchId, {
                kind: 'recover',
                digest: recovery.digest,
                proposalSequence: recovery.sequence,
                checkpointEpoch: recovery.epoch,
                committed: recovery === state.committed
            }));
        }
        if (this.intent) {
            await this.write(this.intent);
        }
        if (this.getView().isDirector) {
            if (state.committed?.epoch === state.authority.epoch) {
                await this.write(this.createFrame(state.committed.state.matchId, {
                    kind: 'commit',
                    digest: state.committed.digest,
                    proposalSequence: state.committed.sequence
                }));
            }
            const recovery = this.checkpoints.getState();
            const phase = this.simulation?.getState().phase;
            if (
                !state.pending && this.simulation &&
                (!recovery.recoveryRequired || recovery.recovered || phase === 'lobby' || phase === 'interrupted')
            ) {
                this.restoreRecovery(recovery);
                await this.propose();
            }
            const committedProposal = this.committedProposal;
            if (committedProposal) {
                await this.write(committedProposal);
                await this.writeCheckpointAction('commit', committedProposal);
            }
            const lastProposal = this.lastProposal;
            if (lastProposal) {
                await this.write(lastProposal);
                await this.writeCheckpointAction('commit', lastProposal);
            }
        }
        const current = this.checkpoints.getState();
        for (const checkpoint of [current.committed, current.pending?.checkpoint]) {
            if (checkpoint) {
                await this.write(this.createFrame(checkpoint.state.matchId, {
                    kind: 'ack',
                    digest: checkpoint.digest,
                    proposalSequence: checkpoint.sequence
                }));
            }
        }
    }

    private restoreRecovery(recovery: TownMatchCheckpoints.State): void {
        const source = recovery.recoveryCheckpoint?.state;
        const view = this.getView();
        if (
            !recovery.recoveryRequired || !recovery.recovered || !source ||
            (view.interruption && source.matchId === view.match?.matchId)
        ) {
            return;
        }
        const working = source.phase === 'playing' || source.phase === 'countdown'
            ? computeTownMatchRecovery({
                state: source,
                members: this.members,
                departedIds: this.room.getView().departedIds,
                now: this.dependencies.timers.nowMs()
            }).right
            : computeTownMatchRoster(source, this.members).right;
        if (working) {
            this.simulation?.stop();
            this.simulation = new TownMatchSimulation(working, this.dependencies.timers.nowMs());
        }
    }

    private async propose(): Promise<void> {
        const working = this.simulation?.getState();
        if (!working) {
            return;
        }
        const generation = this.generation;
        const snapshot = await createTownMatchSnapshot(working, this.dependencies.subtle);
        this.reconcileAuthority();
        if (!this.isCurrent(generation) || !this.getView().isDirector) {
            return;
        }
        if (snapshot.left) {
            this.error = snapshot.left.join(' ');
            return;
        }
        const frame = this.createFrame(working.matchId, { kind: 'proposal', ...snapshot.right! });
        const accepted = this.checkpoints?.propose({
            epoch: frame.epoch,
            sequence: frame.sequence,
            digest: snapshot.right!.digest,
            state: working
        }, this.dependencies.browser.session()!.sessionId);
        if (accepted?.right) {
            this.lastProposal = frame;
        }
    }

    private createFrame(matchId: string, action: TownMatchAction): TownMatchFrame {
        return {
            protocol: TOWN_MATCH_PROTOCOL,
            build: TOWN_MATCH_BUILD,
            roomRef: this.roomRef,
            epoch: this.dependencies.browser.director.status(this.roomRef).appointment?.epoch ?? 0,
            matchId,
            sequence: ++this.sequence,
            action
        };
    }

    private async writeCheckpointAction(kind: 'commit', proposal: TownMatchFrame): Promise<void> {
        if (proposal.action.kind === 'proposal') {
            await this.write(this.createFrame(proposal.matchId, {
                kind,
                digest: proposal.action.digest,
                proposalSequence: proposal.sequence
            }));
        }
    }

    private async write(frame: TownMatchFrame): Promise<void> {
        if (this.lifetime.signal.aborted || !this.getView().available) {
            return;
        }
        const senderId = this.dependencies.browser.session()?.sessionId;
        if (!senderId) {
            return;
        }
        await this.accept(frame, senderId);
        if (!this.validateReception(frame, senderId, this.roomRef) || this.members.length < 2) {
            return;
        }
        try {
            const sent = await this.channel.sendWs(JSON.stringify(frame), {
                ttlMs: frame.action.kind === 'controls' ? 250 : 2000,
                reliability: 'best-effort',
                ack: 'none'
            });
            const delivery = sent.lifecycle();
            if (delivery.state === 'failed' || delivery.state === 'rejected') {
                this.error = 'Match traffic could not reach Rallar. Waiting to reconnect.';
            }
        }
        catch (error) {
            this.report(error);
        }
    }

    private async receive(payload: string, message: RallarMessage<string>): Promise<void> {
        const decoded = decodeTownMatchFrame(payload);
        if (
            !decoded.right ||
            !this.validateReception(decoded.right, message.senderId, readALTargetGroupRef(message.raw))
        ) {
            return;
        }
        await this.accept(decoded.right, message.senderId);
    }

    private validateReception(frame: TownMatchFrame, senderId: string, targetRoomRef: GroupRef | undefined): boolean {
        const checkpointState = this.checkpoints?.getState();
        const current = checkpointState?.pending?.checkpoint.state ?? checkpointState?.committed?.state;
        const retained = checkpointState?.committed;
        const action = frame.action;
        const recoveryIdentity = action.kind === 'recover' &&
            [retained, checkpointState?.recoveryCheckpoint, ...checkpointState?.retainedProposals ?? []].some((
                checkpoint
            ) => checkpoint?.state.matchId === frame.matchId && checkpoint.epoch === action.checkpointEpoch &&
                checkpoint.sequence === action.proposalSequence && checkpoint.digest === action.digest
            );
        const retainedIdentity = retained && frame.epoch === retained.epoch &&
            frame.matchId === retained.state.matchId &&
            ((action.kind === 'proposal' && frame.sequence === retained.sequence &&
                action.digest === retained.digest) ||
                ((action.kind === 'ack' || action.kind === 'commit') && action.proposalSequence === retained.sequence &&
                    action.digest === retained.digest));
        const nextLobby = current && (current.phase === 'finished' || current.phase === 'interrupted') &&
            frame.action.kind === 'proposal';
        return !this.lifetime.signal.aborted && validateTownMatchFrame(frame, {
                    roomRef: this.roomRef,
                    targetRoomRef,
                    director: this.dependencies.browser.director.status(this.roomRef),
                    members: this.members,
                    senderId,
                    matchId: recoveryIdentity
                        ? frame.matchId
                        : retainedIdentity
                        ? retained.state.matchId
                        : nextLobby
                        ? undefined
                        : current?.matchId
                }).length === 0;
    }

    private async accept(frame: TownMatchFrame, senderId: string): Promise<void> {
        this.reconcileAuthority();
        if (!this.validateReception(frame, senderId, this.roomRef) || !this.checkpoints) {
            return;
        }
        if (frame.action.kind === 'proposal') {
            await this.receiveProposal(frame, senderId);
            return;
        }
        const action = frame.action;
        if (action.kind === 'recover') {
            this.checkpoints.recover(senderId, {
                epoch: action.checkpointEpoch,
                sequence: action.proposalSequence,
                digest: action.digest
            }, action.committed);
            return;
        }
        if (action.kind === 'ack' || action.kind === 'commit') {
            const identity = { epoch: frame.epoch, sequence: action.proposalSequence, digest: action.digest };
            const result = action.kind === 'ack'
                ? this.checkpoints.acknowledge(identity, senderId)
                : this.checkpoints.commit(identity, senderId);
            if (result.right) {
                this.publishCommit();
            }
            return;
        }
        if (this.getView().isDirector) {
            this.simulation?.accept(frame, senderId, this.dependencies.timers.nowMs());
        }
    }

    private async receiveProposal(frame: TownMatchFrame, senderId: string): Promise<void> {
        if (frame.action.kind !== 'proposal') {
            return;
        }
        const known = this.checkpoints?.getState();
        const proposal = frame.action;
        const digest = proposal.digest;
        if (
            [known?.committed, known?.pending?.checkpoint].some((checkpoint) =>
                checkpoint?.epoch === frame.epoch && checkpoint.sequence === frame.sequence &&
                checkpoint.digest === digest
            )
        ) {
            return;
        }
        const generation = this.generation;
        await this.verification.run('proposal', async () => {
            const checkpoint = await decodeTownCheckpoint({
                ...proposal,
                epoch: frame.epoch,
                sequence: frame.sequence,
                matchId: frame.matchId
            }, this.dependencies.subtle);
            this.reconcileAuthority();
            if (
                checkpoint.right && this.isCurrent(generation) && this.validateReception(frame, senderId, this.roomRef)
            ) {
                this.checkpoints?.propose(checkpoint.right, senderId);
            }
        });
    }

    private publishCommit(): void {
        const committed = this.checkpoints?.getState().committed;
        const now = this.dependencies.timers.nowMs();
        this.expireRecovery(this.getView(), now);
        this.lastCommitAt = now;
        if (
            committed?.state.seats.some((seat) =>
                seat.id === this.dependencies.browser.session()?.clientId && seat.status === 'observer'
            )
        ) {
            this.interruptedMatchId = undefined;
            this.recoveryStartedAt = undefined;
        }
        this.interruptSimulation();
        if (committed && this.lastProposal?.sequence === committed.sequence) {
            this.committedProposal = this.lastProposal;
            this.lastProposal = undefined;
        }
        const action = this.intent?.action;
        if (committed && action) {
            const state = committed.state;
            const local = state.members.find((member) => member.id === this.dependencies.browser.session()?.clientId);
            if (
                (action.kind === 'ready' && local?.ready === action.ready) ||
                (action.kind === 'start' && state.phase !== 'lobby') ||
                (action.kind === 'rematch' && state.matchId === action.nextMatchId)
            ) {
                this.intent = undefined;
            }
        }
        this.changes.publishLatest(undefined);
    }

    private isCurrent(generation: number): boolean {
        return !this.lifetime.signal.aborted && generation === this.generation && this.getView().available;
    }

    private report(error: unknown): void {
        if (!this.lifetime.signal.aborted) {
            this.error = error instanceof Error ? error.message : 'The match connection failed.';
            this.changes.publishLatest(undefined);
        }
    }
}
