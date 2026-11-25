import { permitsGuestFrame } from '../guest-round-clock.ts';
import type { TownMatchFrame } from '../match-protocol.ts';
import type { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import type { TownMatchRoom } from '../town-match-room.ts';
import type { TownMatchRound } from '../town-match-round.ts';
import type { TownMatchSession } from '../town-match-session.ts';
import type { TownMatchTransport } from './town-match-transport.ts';

export class TownMatchConnection {
    error = '';
    private appointmentError = '';
    private recoveryError = '';
    private appointing = false;
    private readonly dependencies: TownMatchSession.Dependencies;
    private readonly room: TownMatchRoom;
    private readonly round: TownMatchRound;
    private readonly transport: TownMatchTransport;
    private readonly signal: AbortSignal;
    private readonly changes: SynchronousNotifications<void>;

    constructor(
        dependencies: TownMatchSession.Dependencies,
        room: TownMatchRoom,
        round: TownMatchRound,
        transport: TownMatchTransport,
        signal: AbortSignal,
        changes: SynchronousNotifications<void>
    ) {
        this.dependencies = dependencies;
        this.room = room;
        this.round = round;
        this.transport = transport;
        this.signal = signal;
        this.changes = changes;
    }

    getView(): TownMatchSession.View {
        const { director, members, appointmentEligibility } = this.room.getView();
        const session = this.dependencies.browser.session();
        const available = !this.signal.aborted && this.dependencies.browser.isConnected() &&
            director.isFresh &&
            members.some((member) => member.sessionId === session?.sessionId);
        const checkpoint = this.round.checkpoints?.getState();
        const match = checkpoint?.committed?.state;
        const authorityAligned = checkpoint?.authority.epoch === director.appointment?.epoch &&
            checkpoint?.authority.sessionId === director.appointment?.sessionId;
        const { interruption, recovering } = this.round.recovery.status({
            match,
            available,
            authorityAligned,
            recoveryRequired: checkpoint?.recoveryRequired === true,
            now: this.dependencies.timers.nowMs()
        });
        return {
            match,
            localId: session?.clientId,
            isDirector: director.isDirector,
            available,
            observing: Boolean(
                match &&
                    !match.seats.some((seat) => seat.id === session?.clientId && seat.status === 'active')
            ),
            waitingForLobbyPeers: director.isDirector && members.length > 1 && checkpoint?.pending?.checkpoint.state.phase === 'lobby' &&
                members.some(peer => !match?.members.some(member => member.sessionId === peer.sessionId)),
            recovering,
            interruption,
            inputGeneration: this.round.generation,
            error: this.error || this.recoveryError || (director.isFresh ? '' : this.appointmentError),
            appointmentEligibility,
            appointing: this.appointing,
            livePoses: available && !recovering
                ? this.round.livePoses.resolve(match, this.dependencies.timers.nowMs())
                : undefined,
            liveSend: this.transport.getLiveSend(),
            inputTransport: this.round.inputTransport
        };
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
            if (!this.signal.aborted) {
                this.reconcileAuthority();
            }
        }
        catch (error) {
            if (!this.signal.aborted) {
                this.appointmentError = error instanceof Error ? error.message : 'Could not appoint the host.';
            }
        }
        finally {
            this.appointing = false;
            this.changes.publishLatest(undefined);
        }
    }

    async recoverConnection(): Promise<void> {
        const view = this.getView();
        if (!view.recovering) {
            this.round.recovery.resetWait();
            if (!view.match || view.available) {
                this.recoveryError = '';
                return;
            }
        }
        else {
            const now = this.dependencies.timers.nowMs();
            this.round.recovery.expire(view.match?.matchId, now);
            this.round.simulation?.pause(now);
        }
        try {
            const shouldAppoint = await this.room.refreshForRecovery();
            if (shouldAppoint) {
                await this.appoint();
            }
        }
        catch (error) {
            // A failed refresh must not starve agreement over a still-authorized live channel.
            if (!this.signal.aborted) {
                this.recoveryError = error instanceof Error ? error.message : 'The room could not be refreshed.';
            }
        }
        this.reconcileAuthority();
        if (view.recovering) {
            this.round.interruptSimulation(this.getView());
        }
    }

    reconcileAuthority(): void {
        if (this.signal.aborted) {
            return;
        }
        const room = this.room.getView();
        this.room.reconcileGuestPeers(room);
        if (room.director.isFresh) {
            this.appointmentError = '';
        }
        this.round.reconcileAuthority(room);
    }

    permitsMatchFrame(senderId: string, frame: TownMatchFrame): boolean {
        const local = this.dependencies.browser.session()?.sessionId;
        if (!local || !this.dependencies.browser.isConnected()) return false;
        const { members } = this.room.getView();
        const sender = members.find(member => member.sessionId === senderId);
        const receiver = members.find(member => member.sessionId === local);
        if (!sender || !receiver) return false;
        const browser = this.dependencies.browser;
        const snapshot = browser.rooms.current();
        if (!snapshot) return false;
        return permitsGuestFrame(snapshot, { sender: sender.id, receiver: receiver.id, frame, now: browser.deadlineAfter(0) });
    }

    isCurrent(generation: number): boolean {
        return !this.signal.aborted && generation === this.round.generation && this.getView().available;
    }

    report(message: string): void {
        if (!this.signal.aborted) {
            this.error = message;
            this.changes.publishLatest(undefined);
        }
    }
}
