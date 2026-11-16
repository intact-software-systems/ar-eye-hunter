import type { RallarDirectorRelayHandle } from '@shared-web/browser/director/rallar-director-facade.ts';
import type {
    RallarMessage,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';

import type { PracticeInput } from '../practice-rules.ts';
import { TownMatchCheckpoints } from './match-checkpoints.ts';
import {
    decodeTownMatchFrame,
    TOWN_MATCH_BUILD,
    TOWN_MATCH_PROTOCOL,
    validateTownMatchFrame,
    type TownMatchAction,
    type TownMatchFrame
} from './match-protocol.ts';
import { TownMatchSimulation } from './match-simulation.ts';
import { createTownMatchSnapshot, decodeTownCheckpoint } from './match-snapshot.ts';
import {
    computeTownMatchRoster,
    createTownMatch,
    type TownMatchIdentity,
    type TownMatchState
} from './town-match.ts';

export namespace TownMatchSession {
    export interface Dependencies {
        readonly browser: Pick<RallarFacade, 'director' | 'messages' | 'rooms' | 'session' | 'isConnected'>;
        readonly timers: Timers;
        readonly subtle: Pick<SubtleCrypto, 'digest'>;
        readonly newMatchId: () => string;
    }
    export interface View {
        readonly match: TownMatchState | undefined;
        readonly localId: string | undefined;
        readonly isDirector: boolean;
        readonly available: boolean;
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
    private readonly relay: RallarDirectorRelayHandle<null, null>;
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
        this.relay = dependencies.browser.director.createRelay<null, null>({
            roomRef,
            topicId: 'app.cca.authority',
            intentTypeId: 'cca.authority.intent',
            outputTypeId: 'cca.authority.output',
            heartbeatIntervalMs: 750,
            snapshotIntervalMs: false
        });
    }

    start(): void {
        this.subscriptions.add(this.channel.onWs((payload, message) => this.receive(payload, message)));
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
        return {
            match: this.checkpoints?.getState().committed?.state,
            localId: this.dependencies.browser.session()?.clientId,
            isDirector: director.isDirector,
            available: !this.lifetime.signal.aborted && this.dependencies.browser.isConnected() && director.isFresh,
            error: this.error
        };
    }

    setControls(controls: PracticeInput): void {
        this.controls = controls;
    }

    async appoint(): Promise<void> {
        try {
            await this.dependencies.browser.director.appoint(this.roomRef, {
                heartbeatTtlMs: 4000,
                signal: this.lifetime.signal
            });
            if (!this.lifetime.signal.aborted) {
                this.error = '';
                this.reconcileAuthority();
            }
        }
        catch (error) {
            this.report(error);
        }
    }

    async act(action: TownMatchAction): Promise<void> {
        const state = this.checkpoints?.getState().committed?.state;
        if (!state || !this.getView().available) {
            return;
        }
        const frame = this.createFrame(state.matchId, action);
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
        this.relay.stop();
        this.simulation?.stop();
    }

    private async advance(): Promise<void> {
        try {
            this.reconcileAuthority();
            if (!this.getView().available || !this.checkpoints) {
                this.simulation?.pause(this.dependencies.timers.nowMs());
                this.controls = { x: 0, z: 0, dash: this.controls.dash };
                this.changes.publishLatest(undefined);
                return;
            }
            const now = this.dependencies.timers.nowMs();
            if (this.getView().isDirector) {
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

    private reconcileAuthority(): void {
        const browser = this.dependencies.browser;
        const snapshot = browser.rooms.current();
        const director = browser.director.status(this.roomRef);
        if (!snapshot || !isSameGroupRef(snapshot.group, this.roomRef) || !director.appointment) {
            return;
        }
        const now = this.dependencies.timers.nowMs();
        const names = browser.rooms.state().members;
        this.members = snapshot.activeSessions.filter((session) =>
            session.status === 'active' && session.expiresAtEpochMs > now &&
            snapshot.members.some((member) => member.principalId === session.principalId && member.status === 'active')
        ).map((session) => ({
            id: session.principalId,
            sessionId: session.sessionId,
            displayName: names.find((member) => member.principalId === session.principalId)?.displayName ||
                session.principalId
        })).sort((left, right) => left.id.localeCompare(right.id));
        const authority = {
            epoch: director.appointment.epoch,
            sessionId: director.appointment.sessionId,
            members: this.members
        };
        const key = JSON.stringify([
            authority.epoch,
            authority.sessionId,
            this.members.map((member) => [member.id, member.sessionId])
        ]);
        if (key === this.authorityKey || !director.isFresh || this.members.length === 0) {
            return;
        }
        const previous = this.checkpoints?.getState();
        const sameDirector = previous?.authority.epoch === authority.epoch &&
            previous.authority.sessionId === authority.sessionId;
        const source = sameDirector && director.isDirector
            ? this.simulation?.getState() ?? previous?.committed?.state
            : previous?.committed?.state;
        this.authorityKey = key;
        this.generation += 1;
        if (this.checkpoints) {
            this.checkpoints.changeAuthority(authority);
        }
        else {
            this.checkpoints = new TownMatchCheckpoints(authority);
        }
        const working = source
            ? computeTownMatchRoster(source, this.members).right
            : createTownMatch(this.dependencies.newMatchId(), this.members).right;
        this.simulation?.stop();
        this.simulation = working ? new TownMatchSimulation(working, now) : undefined;
        this.intent = undefined;
        this.lastProposal = undefined;
        this.committedProposal = undefined;
    }

    private async exchangeCheckpoints(): Promise<void> {
        if (!this.checkpoints) {
            return;
        }
        const state = this.checkpoints.getState();
        if (this.intent) {
            await this.write(this.intent);
        }
        if (this.getView().isDirector) {
            if (!state.pending && this.simulation) {
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

    private async propose(): Promise<void> {
        const working = this.simulation?.getState();
        if (!working) {
            return;
        }
        const generation = this.generation;
        const snapshot = await createTownMatchSnapshot(working, this.dependencies.subtle);
        if (!this.isCurrent(generation) || !this.getView().isDirector) {
            return;
        }
        if (snapshot.left) {
            this.error = snapshot.left.join(' ');
            return;
        }
        const frame = this.createFrame(working.matchId, { kind: 'proposal', ...snapshot.right! });
        await this.receiveProposal(frame, this.dependencies.browser.session()!.sessionId);
        if (this.isCurrent(generation)) {
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
                    matchId: retainedIdentity ? retained.state.matchId : nextLobby ? undefined : current?.matchId
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
