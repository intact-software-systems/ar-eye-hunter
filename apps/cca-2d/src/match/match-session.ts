import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import type { RallarGroupDirectorAppointmentEligibility } from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';

import type { PracticeInput } from '../practice-rules.ts';
import { TownMatchCheckpoints, type TownMatchAuthority } from './match-checkpoints.ts';
import { TownMatchLivePoses } from './match-live-poses.ts';
import {
    TOWN_MATCH_BUILD,
    TOWN_MATCH_PROTOCOL,
    validateTownMatchFrame,
    type TownMatchAction,
    type TownMatchFrame
} from './match-protocol.ts';
import { TownMatchRoom } from './match-room.ts';
import { TownMatchSimulation } from './match-simulation.ts';
import { createTownMatchSnapshot, decodeTownCheckpoint } from './match-snapshot.ts';
import { TownMatchTransport } from './match-transport.ts';
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
        readonly browser: Pick<
            RallarFacade,
            'director' | 'messages' | 'realtime' | 'rooms' | 'session' | 'isConnected' | 'ws'
        >;
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
        readonly appointmentEligibility: RallarGroupDirectorAppointmentEligibility;
        readonly appointing: boolean;
        readonly livePoses: TownMatchLivePoses.Sample | undefined;
        readonly liveSend: ReturnType<TownMatchTransport['getLiveSend']>;
        /** Carrier of the last authenticated control frame received by this host, not an acknowledgement. */
        readonly inputTransport: 'rtc' | 'ws' | 'none';
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
    private readonly transport: TownMatchTransport;
    private readonly livePoses = new TownMatchLivePoses();
    private inputTransport: 'rtc' | 'ws' | 'none' = 'none';
    private readonly room: TownMatchRoom;
    private checkpoints: TownMatchCheckpoints | undefined;
    private simulation: TownMatchSimulation | undefined;
    private members: readonly TownMatchIdentity[] = [];
    private controls: PracticeInput = { x: 0, z: 0, dash: 0 };
    private sequence = 0;
    private generation = 0;
    private authorityKey = '';
    private error = '';
    private appointmentError = '';
    private recoveryError = '';
    private appointing = false;
    private lastInput = 0;
    private lastExchange = 0;
    private lastCommit: { readonly at: number; readonly epoch: number; } | undefined;
    private recoveryStartedAt: number | undefined;
    private interruptedMatch: { readonly matchId: string; readonly epoch: number; } | undefined;
    private intent: { readonly frame: TownMatchFrame; readonly sessionId: string; } | undefined;
    private lastProposal: TownMatchFrame | undefined;
    private committedProposal: TownMatchFrame | undefined;

    private readonly dependencies: TownMatchSession.Dependencies;
    readonly roomRef: GroupRef;

    constructor(dependencies: TownMatchSession.Dependencies, roomRef: GroupRef) {
        this.dependencies = dependencies;
        this.roomRef = roomRef;
        this.transport = new TownMatchTransport({
            reliable: dependencies.browser.messages.room<string>({
                roomRef,
                topicId: 'app.cca.match',
                typeId: 'cca.match.frame',
                purpose: 'notification',
                access: 'members'
            }),
            realtime: dependencies.browser.realtime.room<string>({ roomRef, waitForReady: false })
        });
        this.room = new TownMatchRoom(dependencies, roomRef);
    }

    start(): void {
        this.transport.start((reception) => this.receive(reception));
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
        const { director, members, appointmentEligibility } = this.room.getView();
        const localSessionId = this.dependencies.browser.session()?.sessionId;
        const available = !this.lifetime.signal.aborted && this.dependencies.browser.isConnected() &&
            director.isFresh &&
            members.some((member) => member.sessionId === localSessionId);
        const checkpoint = this.checkpoints?.getState();
        const match = checkpoint?.committed?.state;
        const authorityAligned = checkpoint?.authority.epoch === director.appointment?.epoch &&
            checkpoint?.authority.sessionId === director.appointment?.sessionId;
        const interruption = match && this.interruptedMatch?.matchId === match.matchId
            ? 'Round interrupted: recovery could not be confirmed. Your last confirmed points are preserved.'
            : undefined;
        const recovering = (match?.phase === 'playing' || match?.phase === 'countdown') &&
            (!available || !authorityAligned || Boolean(interruption) || checkpoint?.recoveryRequired === true ||
                (this.lastCommit !== undefined &&
                    this.dependencies.timers.nowMs() - this.lastCommit.at >= 1500));
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
            recovering,
            interruption,
            inputGeneration: this.generation,
            error: this.error || this.recoveryError || (director.isFresh ? '' : this.appointmentError),
            appointmentEligibility,
            appointing: this.appointing,
            livePoses: available && !recovering
                ? this.livePoses.resolve(match, this.dependencies.timers.nowMs())
                : undefined,
            liveSend: this.transport.getLiveSend(),
            inputTransport: this.inputTransport
        };
    }

    setControls(controls: PracticeInput): void {
        this.controls = controls;
    }

    async appoint(): Promise<void> {
        if (this.appointing || !this.room.getView().appointmentEligibility.allowed) {
            return;
        }
        this.appointing = true;
        this.appointmentError = '';
        this.changes.publishLatest(undefined);
        try {
            await this.room.appoint();
            if (!this.lifetime.signal.aborted) {
                this.reconcileAuthority();
            }
        }
        catch (error) {
            if (!this.lifetime.signal.aborted) {
                this.appointmentError = error instanceof Error ? error.message : 'Could not appoint the host.';
            }
        }
        finally {
            this.appointing = false;
            this.changes.publishLatest(undefined);
        }
    }

    async act(action: TownMatchSession.Intent): Promise<void> {
        const state = this.checkpoints?.getState().committed?.state;
        const view = this.getView();
        const session = this.dependencies.browser.session();
        if (
            !state || !session || !view.available || (action.kind === 'controls' && (view.recovering || view.observing))
        ) {
            return;
        }
        const frame = this.createFrame(
            state.matchId,
            action.kind === 'ready'
                ? { ...action, displayName: session.username ?? '' }
                : action
        );
        if (action.kind === 'ready' || action.kind === 'start' || action.kind === 'rematch') {
            this.intent = { frame, sessionId: session.sessionId };
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
        this.transport.stop();
        this.livePoses.clear();
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
                if (view.isDirector && !view.recovering) {
                    await this.publishLivePoses();
                }
            }
            const checkpoint = this.checkpoints.getState();
            const settledLobby = match?.phase === 'lobby' && !checkpoint.pending && !checkpoint.recoveryRequired &&
                !this.intent && (!view.isDirector || this.simulation?.getState() === match);
            // A quiet lobby still retransmits for a peer that missed commitment.
            // New rosters, commands and unsettled checkpoints use the normal exchange interval.
            if (now - this.lastExchange >= (settledLobby ? 1000 : 100)) {
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
        this.livePoses.clear();
        this.inputTransport = 'none';
        const authority = this.checkpoints?.getState().authority;
        this.checkpoints?.interruptTransport();
        if (authority?.sessionId !== this.dependencies.browser.session()?.sessionId) {
            this.lastProposal = undefined;
            this.committedProposal = undefined;
        }
        this.simulation?.pause(this.dependencies.timers.nowMs());
        this.controls = { x: 0, z: 0, dash: this.controls.dash };
        if (this.intent?.frame.action.kind !== 'ready') {
            this.intent = undefined;
        }
        this.changes.publishLatest(undefined);
    }

    private reconcileAuthority(): void {
        if (this.lifetime.signal.aborted) {
            return;
        }
        const { director, members, departedIds } = this.room.getView();
        if (director.isFresh) {
            this.appointmentError = '';
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
        // A ready choice may still be in flight when another player joins or leaves.
        const retryReady = this.intent?.frame.action.kind === 'ready' && working?.phase === 'lobby' &&
            this.intent.frame.matchId === working.matchId && this.intent.frame.epoch === authority.epoch &&
            this.intent.sessionId === session.sessionId;
        if (!retryReady) {
            this.intent = undefined;
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
            dash: working?.players.find((player) => player.id === this.dependencies.browser.session()?.clientId)
                ?.consumedDash ?? 0
        };
        this.lastProposal = undefined;
        this.committedProposal = undefined;
    }

    private async recoverConnection(): Promise<void> {
        const view = this.getView();
        if (!view.recovering) {
            this.recoveryStartedAt = undefined;
            if (!view.match || view.available) {
                this.recoveryError = '';
                return;
            }
        }
        else {
            const now = this.dependencies.timers.nowMs();
            this.expireRecovery(view, now);
            this.simulation?.pause(now);
        }
        try {
            const shouldAppoint = await this.room.refreshForRecovery();
            if (shouldAppoint) {
                await this.appoint();
            }
        }
        catch (error) {
            // A failed refresh must not starve agreement over a still-authorized live channel.
            if (!this.lifetime.signal.aborted) {
                this.recoveryError = error instanceof Error ? error.message : 'The room could not be refreshed.';
            }
        }
        this.reconcileAuthority();
        if (view.recovering) {
            this.interruptSimulation();
        }
    }

    private expireRecovery(view: TownMatchSession.View, now: number): void {
        if (!view.recovering || !view.match || this.lastCommit === undefined) {
            return;
        }
        this.recoveryStartedAt ??= Math.min(now, this.lastCommit.at + 1500);
        if (now - this.recoveryStartedAt >= 10000 && this.interruptedMatch?.matchId !== view.match.matchId) {
            this.interruptedMatch = { matchId: view.match.matchId, epoch: this.lastCommit.epoch };
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
        if (this.intent && this.intent.sessionId === this.dependencies.browser.session()?.sessionId) {
            await this.write(this.intent.frame);
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
        if (!working || (working.phase === 'lobby' && working === this.checkpoints?.getState().committed?.state)) {
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

    private async publishLivePoses(): Promise<void> {
        const working = this.simulation?.getState();
        if (working?.phase !== 'playing') {
            return;
        }
        const players = working.players.filter((player) =>
            working.seats.some((seat) => seat.id === player.id && seat.status === 'active')
        ).map(({ id, x, z, vx, vz, elapsed, facingX, facingZ, dashTime, cooldown, consumedDash, pranks, clouds }) => ({
            id,
            x,
            z,
            vx,
            vz,
            elapsed,
            facingX,
            facingZ,
            dashTime,
            cooldown,
            consumedDash,
            pranks,
            clouds
        }));
        await this.write(this.createFrame(working.matchId, { kind: 'poses', tick: working.tick, players }));
    }

    private async write(frame: TownMatchFrame): Promise<void> {
        if (this.lifetime.signal.aborted || !this.getView().available) {
            return;
        }
        const senderId = this.dependencies.browser.session()?.sessionId;
        if (!senderId) {
            return;
        }
        await this.accept(frame, senderId, 'local');
        if (
            !this.validateReception(frame, senderId, this.roomRef) || this.members.length < 2 ||
            (frame.action.kind === 'controls' && this.getView().isDirector)
        ) {
            return;
        }
        try {
            await this.transport.write(
                frame,
                this.members.filter((member) => member.sessionId !== senderId)
                    .map((member) => member.sessionId)
            );
        }
        catch (error) {
            this.report(error);
        }
    }

    private async receive(reception: TownMatchTransport.Reception): Promise<void> {
        if (this.validateReception(reception.frame, reception.senderId, reception.targetRoomRef)) {
            await this.accept(reception.frame, reception.senderId, reception.transport);
        }
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

    private async accept(frame: TownMatchFrame, senderId: string, transport: 'rtc' | 'ws' | 'local'): Promise<void> {
        this.reconcileAuthority();
        if (!this.validateReception(frame, senderId, this.roomRef) || !this.checkpoints) {
            return;
        }
        if (frame.action.kind === 'proposal') {
            await this.receiveProposal(frame, senderId);
            return;
        }
        const action = frame.action;
        if (action.kind === 'poses') {
            const view = this.getView();
            if (view.match && view.available && !view.recovering) {
                this.livePoses.accept({ frame, match: view.match, now: this.dependencies.timers.nowMs(), transport });
            }
            return;
        }
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
            if (action.kind === 'controls' && transport !== 'local') {
                this.inputTransport = transport;
            }
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
        if (committed) {
            this.error = '';
            this.lastCommit = { at: now, epoch: committed.epoch };
        }
        if (
            committed && (
                committed.state.seats.some((seat) =>
                    seat.id === this.dependencies.browser.session()?.clientId && seat.status === 'observer'
                ) ||
                (this.interruptedMatch && committed.epoch > this.interruptedMatch.epoch && !this.getView().isDirector)
            )
        ) {
            this.interruptedMatch = undefined;
            this.recoveryStartedAt = undefined;
        }
        this.interruptSimulation();
        if (committed && this.lastProposal?.sequence === committed.sequence) {
            this.committedProposal = this.lastProposal;
            this.lastProposal = undefined;
        }
        const action = this.intent?.frame.action;
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
