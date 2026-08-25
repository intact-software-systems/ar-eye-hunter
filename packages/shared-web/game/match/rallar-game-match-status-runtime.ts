import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarGameDirectorAppointmentEligibility } from '../director/rallar-game-director-appointment-contracts.ts';
import type { RallarGameFreshDirectorStatus } from '../director/rallar-game-fresh-director-status.ts';
import type {
    RallarGameDirectorAuthority,
    RallarGameEgressState,
    RallarGameMatchPhase,
    RallarGameMatchStatus,
    RallarGameRecoveryState,
    RallarGameStatusHandler
} from './rallar-game-match-status.ts';

export namespace RallarGameMatchStatusRuntime {
    export interface RoomTarget {
        readonly roomId?: string;
        readonly roomRef?: GroupRef;
    }

    export interface Input {
        readonly protocol: string;
        readonly topicId: string;
        readRoomTarget(directorStatus?: RallarDirectorStatus): RoomTarget;
        readLocalPeerId(): string | undefined;
        readDirectorStatus(): RallarDirectorStatus;
        readAppointmentEligibility(): RallarGameDirectorAppointmentEligibility;
    }
}

/** Owns match lifecycle flags, recovery state, egress state, and status observation. */
export class RallarGameMatchStatusRuntime {
    private readonly input: RallarGameMatchStatusRuntime.Input;
    private readonly handlers = new Set<RallarGameStatusHandler>();
    private started = false;
    private stopped = false;
    private reliableEgress: RallarGameEgressState = 'empty';
    private realtimeEgress: RallarGameEgressState = 'empty';
    private recovery: RallarGameRecoveryState = { status: 'idle' };
    private currentStatus: RallarGameMatchStatus;

    constructor(input: RallarGameMatchStatusRuntime.Input) {
        this.input = input;
        this.currentStatus = this.createStatus('idle');
    }

    get current(): RallarGameMatchStatus {
        return this.currentStatus;
    }

    get isStarted(): boolean {
        return this.started;
    }

    get isStopped(): boolean {
        return this.stopped;
    }

    begin(): boolean {
        if (this.started && !this.stopped) {
            return false;
        }

        this.started = true;
        this.stopped = false;
        return true;
    }

    stop(): boolean {
        if (this.stopped) {
            return false;
        }

        this.stopped = true;
        this.started = false;
        this.setStatus('stopped');
        return true;
    }

    refresh(
        directorStatus: RallarDirectorStatus = this.input.readDirectorStatus()
    ): void {
        if (this.stopped) {
            return;
        }

        const phase: RallarGameMatchPhase = !this.started
            ? 'idle'
            : directorStatus.isFresh
            ? 'active'
            : 'recovering';
        this.updateRecoveryForDirector(directorStatus);
        this.setStatus(phase, directorStatus);
    }

    readFreshDirectorStatus(): RallarGameFreshDirectorStatus | undefined {
        const status = this.input.readDirectorStatus();
        this.refresh(status);
        return status.isFresh && status.appointment
            ? status as RallarGameFreshDirectorStatus
            : undefined;
    }

    setReliableEgress(state: RallarGameEgressState): void {
        this.reliableEgress = state;
        this.refresh();
    }

    setRealtimeEgress(state: RallarGameEgressState): void {
        this.realtimeEgress = state;
        this.refresh();
    }

    recordSyncRequest(atEpochMs: number): void {
        this.recovery = {
            ...this.recovery,
            lastSyncRequestedAtEpochMs: atEpochMs
        };
        this.refresh();
    }

    recordSnapshot(atEpochMs: number): void {
        this.recovery = {
            status: this.recovery.status === 'recovering' ? 'synced' : this.recovery.status,
            lastSnapshotAtEpochMs: atEpochMs
        };
        this.refresh();
    }

    onStatus(handler: RallarGameStatusHandler): () => void {
        this.handlers.add(handler);
        void notifyRallarGameStatusHandler(handler, this.currentStatus);
        return () => this.handlers.delete(handler);
    }

    private updateRecoveryForDirector(directorStatus: RallarDirectorStatus): void {
        if (this.started && !directorStatus.isFresh) {
            this.recovery = {
                status: 'recovering',
                reason: 'No fresh director is available.',
                sinceEpochMs: this.recovery.status === 'recovering'
                    ? this.recovery.sinceEpochMs
                    : Date.now(),
                lastSyncRequestedAtEpochMs: this.recovery.lastSyncRequestedAtEpochMs,
                lastSnapshotAtEpochMs: this.recovery.lastSnapshotAtEpochMs
            };
            return;
        }

        if (directorStatus.isFresh && this.recovery.status === 'recovering') {
            this.recovery = {
                status: 'idle',
                lastSnapshotAtEpochMs: this.recovery.lastSnapshotAtEpochMs
            };
        }
    }

    private setStatus(
        phase: RallarGameMatchPhase,
        directorStatus: RallarDirectorStatus = this.input.readDirectorStatus(),
        reason?: string
    ): void {
        this.currentStatus = this.createStatus(phase, directorStatus, reason);
        for (const handler of this.handlers) {
            void notifyRallarGameStatusHandler(handler, this.currentStatus);
        }
    }

    private createStatus(
        phase: RallarGameMatchPhase,
        directorStatus: RallarDirectorStatus = this.input.readDirectorStatus(),
        reason?: string
    ): RallarGameMatchStatus {
        const room = this.input.readRoomTarget(directorStatus);
        return {
            phase,
            protocol: this.input.protocol,
            topicId: this.input.topicId,
            roomId: room.roomId,
            roomRef: room.roomRef,
            localPeerId: this.input.readLocalPeerId(),
            directorPeerId: directorStatus.appointment?.sessionId,
            directorEpoch: directorStatus.appointment?.epoch,
            directorIsFresh: directorStatus.isFresh,
            directorAuthority: this.toDirectorAuthority(directorStatus),
            egress: {
                reliable: this.reliableEgress,
                realtime: this.realtimeEgress
            },
            recovery: this.recovery,
            started: this.started,
            stopped: this.stopped,
            updatedAtEpochMs: Date.now(),
            reason
        };
    }

    private toDirectorAuthority(
        directorStatus: RallarDirectorStatus
    ): RallarGameDirectorAuthority {
        const localPeerId = this.input.readLocalPeerId();
        if (localPeerId && directorStatus.appointment?.sessionId === localPeerId) {
            return directorStatus.isFresh ? 'active' : 'stale';
        }

        if (!directorStatus.appointment && this.input.readAppointmentEligibility().allowed) {
            return 'candidate';
        }

        return 'none';
    }
}

async function notifyRallarGameStatusHandler(
    handler: RallarGameStatusHandler,
    status: RallarGameMatchStatus
): Promise<void> {
    try {
        await handler(status);
    }
    catch (error) {
        console.error('Error notifying Rallar Game status handler', error);
    }
}
