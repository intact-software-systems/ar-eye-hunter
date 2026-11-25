import type { TownMatchFrame } from '../match-protocol.ts';
import type { TownMatchConnection } from '../realtime/town-match-connection.ts';
import type { TownMatchFrames } from '../realtime/town-match-frames.ts';
import type { TownMatchRound } from '../town-match-round.ts';
import type { TownMatchSession } from '../town-match-session.ts';
import type { TownMatchCheckpoints } from './match-checkpoints.ts';
import { createTownMatchSnapshot } from './match-snapshot.ts';

export class TownMatchExchange {
    private readonly dependencies: TownMatchSession.Dependencies;
    private readonly round: TownMatchRound;
    private readonly connection: TownMatchConnection;
    private readonly frames: TownMatchFrames;
    private nextConfirmedReplayAt = 0;

    constructor(
        dependencies: TownMatchSession.Dependencies,
        round: TownMatchRound,
        connection: TownMatchConnection,
        frames: TownMatchFrames
    ) {
        this.dependencies = dependencies;
        this.round = round;
        this.connection = connection;
        this.frames = frames;
    }

    async act(action: TownMatchSession.Intent): Promise<void> {
        const state = this.round.checkpoints?.getState().committed?.state;
        const view = this.connection.getView();
        const session = this.dependencies.browser.session();
        if (
            !state || !session || !view.available || (action.kind === 'controls' && (view.recovering || view.observing))
        ) {
            return;
        }
        if (action.kind === 'extend' && (!view.isDirector || view.recovering || state.phase !== 'playing')) {
            return;
        }
        const frame = this.frames.createFrame(
            state.matchId,
            action.kind === 'ready'
                ? { ...action, displayName: session.username ?? '' }
                : action
        );
        if (
            action.kind === 'ready' || action.kind === 'start' || action.kind === 'extend' || action.kind === 'rematch'
        ) {
            this.round.intent = { frame, sessionId: session.sessionId };
        }
        await this.frames.write(frame);
    }

    async exchangeCheckpoints(confirmationStalled: boolean): Promise<void> {
        if (!this.round.checkpoints) {
            return;
        }
        const state = this.round.checkpoints.getState();
        const report = this.round.checkpoints.recoveryReport(confirmationStalled);
        if (report) {
            const recovery = report.checkpoint;
            await this.frames.write(this.frames.createFrame(recovery.state.matchId, {
                kind: 'recover',
                digest: recovery.digest,
                proposalSequence: recovery.sequence,
                checkpointEpoch: recovery.epoch,
                committed: report.committed
            }));
        }
        if (this.round.intent && this.round.intent.sessionId === this.dependencies.browser.session()?.sessionId) {
            await this.frames.write(this.round.intent.frame);
        }
        // A missed committed snapshot can be repaired before the 1.5s stall threshold.
        // Pending decisions still retry on every exchange and require every player's acknowledgement.
        const now = this.dependencies.timers.nowMs();
        const replayConfirmed = now >= this.nextConfirmedReplayAt;
        if (replayConfirmed) this.nextConfirmedReplayAt = now + 500;
        if (this.connection.getView().isDirector) {
            await this.exchangeDirectorProposals(this.round.checkpoints, state, replayConfirmed);
        }
        const current = this.round.checkpoints.getState();
        for (const checkpoint of [replayConfirmed ? current.committed : undefined, current.pending?.checkpoint]) {
            if (checkpoint) {
                await this.frames.write(this.frames.createFrame(checkpoint.state.matchId, {
                    kind: 'ack',
                    digest: checkpoint.digest,
                    proposalSequence: checkpoint.sequence
                }));
            }
        }
    }

    private async exchangeDirectorProposals(
        checkpoints: TownMatchCheckpoints,
        state: TownMatchCheckpoints.State,
        replayConfirmed: boolean
    ): Promise<void> {
        if (replayConfirmed && state.committed?.epoch === state.authority.epoch) {
            if (this.round.committedProposal?.sequence === state.committed.sequence) {
                await this.frames.write(this.round.committedProposal);
            }
            await this.frames.write(this.frames.createFrame(state.committed.state.matchId, {
                kind: 'commit',
                digest: state.committed.digest,
                proposalSequence: state.committed.sequence
            }));
        }
        const recovery = checkpoints.getState();
        const phase = this.round.simulation?.getState().phase;
        if (
            !state.pending && this.round.simulation &&
            (!recovery.recoveryRequired || recovery.recovered || phase === 'lobby' || phase === 'interrupted') &&
            this.round.restoreRecovery(recovery, this.connection.getView())
        ) {
            await this.propose();
        }
        const lastProposal = this.round.lastProposal;
        if (lastProposal) {
            await this.frames.write(lastProposal);
            await this.writeCheckpointAction('commit', lastProposal);
        }
    }

    private async propose(): Promise<void> {
        const working = this.round.simulation?.getState();
        if (
            !working || (working.phase === 'lobby' && working === this.round.checkpoints?.getState().committed?.state)
        ) {
            return;
        }
        const generation = this.round.generation;
        const snapshot = await createTownMatchSnapshot(working, this.dependencies.subtle);
        this.connection.reconcileAuthority();
        if (!this.connection.isCurrent(generation) || !this.connection.getView().isDirector) {
            return;
        }
        if (!snapshot.right) {
            this.connection.error = snapshot.left?.join(' ') ?? 'Could not encode the match checkpoint.';
            return;
        }
        const session = this.dependencies.browser.session();
        if (!session) {
            return;
        }
        const frame = this.frames.createFrame(working.matchId, { kind: 'proposal', ...snapshot.right });
        const accepted = this.round.checkpoints?.propose({
            epoch: frame.epoch,
            sequence: frame.sequence,
            digest: snapshot.right.digest,
            state: working
        }, session.sessionId);
        if (accepted?.right) {
            this.round.lastProposal = frame;
        }
    }

    private async writeCheckpointAction(kind: 'commit', proposal: TownMatchFrame): Promise<void> {
        if (proposal.action.kind === 'proposal') {
            await this.frames.write(this.frames.createFrame(proposal.matchId, {
                kind,
                digest: proposal.action.digest,
                proposalSequence: proposal.sequence
            }));
        }
    }

    async publishLivePoses(): Promise<void> {
        const working = this.round.simulation?.getState();
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
        await this.frames.write(
            this.frames.createFrame(working.matchId, { kind: 'poses', tick: working.tick, players })
        );
    }
}
