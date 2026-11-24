import type { GroupRef } from '@shared/api/group-types.ts';
import type { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { decodeTownCheckpoint } from '../agreement/match-snapshot.ts';
import {
    TOWN_MATCH_BUILD,
    TOWN_MATCH_PROTOCOL,
    validateTownMatchFrame,
    type TownMatchAction,
    type TownMatchFrame
} from '../match-protocol.ts';
import type { TownMatchRound } from '../town-match-round.ts';
import type { TownMatchSession } from '../town-match-session.ts';
import { resolveTownFrameMatchId } from './resolve-town-frame-match-id.ts';
import type { TownMatchConnection } from './town-match-connection.ts';
import type { TownMatchTransport } from './town-match-transport.ts';

export class TownMatchFrames {
    private readonly verification = new SingleFlight<string, void>();
    private sequence = 0;
    private readonly dependencies: TownMatchSession.Dependencies;
    private readonly roomRef: GroupRef;
    private readonly round: TownMatchRound;
    private readonly connection: TownMatchConnection;
    private readonly transport: TownMatchTransport;
    private readonly signal: AbortSignal;
    private readonly changes: SynchronousNotifications<void>;

    constructor(
        dependencies: TownMatchSession.Dependencies,
        roomRef: GroupRef,
        round: TownMatchRound,
        connection: TownMatchConnection,
        transport: TownMatchTransport,
        signal: AbortSignal,
        changes: SynchronousNotifications<void>
    ) {
        this.dependencies = dependencies;
        this.roomRef = roomRef;
        this.round = round;
        this.connection = connection;
        this.transport = transport;
        this.signal = signal;
        this.changes = changes;
    }

    createFrame(matchId: string, action: TownMatchAction): TownMatchFrame {
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

    async write(frame: TownMatchFrame): Promise<void> {
        if (this.signal.aborted || !this.connection.getView().available) {
            return;
        }
        const senderId = this.dependencies.browser.session()?.sessionId;
        if (!senderId) {
            return;
        }
        await this.accept(frame, senderId, 'local');
        if (
            !this.validateReception(frame, senderId, this.roomRef) || this.round.members.length < 2 ||
            (frame.action.kind === 'controls' && this.connection.getView().isDirector)
        ) {
            return;
        }
        try {
            await this.transport.write(
                frame,
                this.round.members.filter((member) => member.sessionId !== senderId)
                    .map((member) => member.sessionId)
            );
        }
        catch (error) {
            this.connection.report(error instanceof Error ? error.message : 'The match connection failed.');
        }
    }

    async receive(reception: TownMatchTransport.Reception): Promise<void> {
        if (this.validateReception(reception.frame, reception.senderId, reception.targetRoomRef)) {
            await this.accept(reception.frame, reception.senderId, reception.transport);
        }
    }

    private validateReception(frame: TownMatchFrame, senderId: string, targetRoomRef: GroupRef | undefined): boolean {
        const checkpointState = this.round.checkpoints?.getState();
        return !this.signal.aborted && validateTownMatchFrame(frame, {
                    roomRef: this.roomRef,
                    targetRoomRef,
                    director: this.dependencies.browser.director.status(this.roomRef),
                    members: this.round.members,
                    senderId,
                    matchId: resolveTownFrameMatchId(frame, checkpointState)
                }).length === 0;
    }

    private async accept(frame: TownMatchFrame, senderId: string, transport: 'rtc' | 'ws' | 'local'): Promise<void> {
        this.connection.reconcileAuthority();
        if (!this.validateReception(frame, senderId, this.roomRef) || !this.round.checkpoints) {
            return;
        }
        if (frame.action.kind === 'proposal') {
            await this.receiveProposal(frame, senderId);
            return;
        }
        const action = frame.action;
        if (action.kind === 'poses') {
            const view = this.connection.getView();
            if (view.match && view.available && !view.recovering) {
                this.round.livePoses.accept({
                    frame,
                    match: view.match,
                    now: this.dependencies.timers.nowMs(),
                    transport
                });
            }
            return;
        }
        if (action.kind === 'recover') {
            this.round.checkpoints.recover(senderId, {
                epoch: action.checkpointEpoch,
                sequence: action.proposalSequence,
                digest: action.digest
            }, action.committed);
            return;
        }
        if (action.kind === 'ack' || action.kind === 'commit') {
            const identity = { epoch: frame.epoch, sequence: action.proposalSequence, digest: action.digest };
            const result = action.kind === 'ack'
                ? this.round.checkpoints.acknowledge(identity, senderId)
                : this.round.checkpoints.commit(identity, senderId);
            if (result.right) {
                this.publishCommit();
            }
            return;
        }
        if (this.connection.getView().isDirector) {
            this.round.simulation?.accept(frame, senderId, this.dependencies.timers.nowMs());
            if (action.kind === 'controls' && transport !== 'local') {
                this.round.inputTransport = transport;
            }
        }
    }

    private async receiveProposal(frame: TownMatchFrame, senderId: string): Promise<void> {
        if (frame.action.kind !== 'proposal') {
            return;
        }
        const known = this.round.checkpoints?.getState();
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
        const generation = this.round.generation;
        await this.verification.run('proposal', async () => {
            const checkpoint = await decodeTownCheckpoint({
                ...proposal,
                epoch: frame.epoch,
                sequence: frame.sequence,
                matchId: frame.matchId
            }, this.dependencies.subtle);
            this.connection.reconcileAuthority();
            if (
                checkpoint.right && this.connection.isCurrent(generation) &&
                this.validateReception(frame, senderId, this.roomRef)
            ) {
                this.round.checkpoints?.propose(checkpoint.right, senderId);
            }
        });
    }

    private publishCommit(): void {
        const committed = this.round.checkpoints?.getState().committed;
        const now = this.dependencies.timers.nowMs();
        const view = this.connection.getView();
        if (view.recovering) {
            this.round.recovery.expire(view.match?.matchId, now);
        }
        if (committed) {
            this.connection.error = '';
            this.round.recovery.confirm(committed, now, view.localId, view.isDirector);
        }
        this.round.interruptSimulation(this.connection.getView());
        this.round.confirmReplayedFrames(committed, view.localId);
        this.changes.publishLatest(undefined);
    }
}
