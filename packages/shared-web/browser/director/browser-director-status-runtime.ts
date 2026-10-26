import type {
    RallarDirectorStatus,
    RallarDirectorStatusListener,
    RallarDirectorStatusOptions
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { GroupRef, GroupSnapshot } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    isRallarGroupDirectorForSession,
    isRallarGroupDirectorSessionActive,
    readRallarGroupDirectorFreshness,
    readRallarGroupDirectorFromSnapshot,
    type RallarGroupDirectorAppointment
} from '@shared/api/group-director.ts';
import { readConfiguredValue } from '@shared/cache/RepositoryManager.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';

export namespace BrowserDirectorStatusRuntime {
    export interface Input {
        readonly roomStateStore: RallarRoomStateStorePort;
        readonly nowMs: () => number;
        readSession(): AuthSession | undefined;
        resolveDefaultRoom(): string | GroupRef | undefined;
    }

    export interface Heartbeat {
        readonly sessionId: string;
        readonly epoch: number;
        readonly atEpochMs: number;
    }
}

export class BrowserDirectorStatusRuntime {
    private readonly input: BrowserDirectorStatusRuntime.Input;
    private readonly notifications = new SynchronousNotifications<RallarDirectorStatus>((error) => {
        console.error('Error notifying Rallar director status listener', error);
    });
    private readonly heartbeatByRoom = new Map<string, BrowserDirectorStatusRuntime.Heartbeat>();

    public constructor(input: BrowserDirectorStatusRuntime.Input) {
        this.input = input;
    }

    public read(
        room?: string | GroupRef,
        options: RallarDirectorStatusOptions = {}
    ): RallarDirectorStatus {
        const target = room ?? this.input.resolveDefaultRoom() ??
            readConfiguredValue(() => this.input.roomStateStore.resolveCurrentRoomRef());
        const snapshot = this.findSnapshot(target);
        const roomRef = this.resolveRoomRef(target, snapshot);
        const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
        const heartbeat = this.readMatchingHeartbeat(roomRef, appointment);
        const now = options.now ?? this.input.nowMs();
        const active = isRallarGroupDirectorSessionActive(snapshot, appointment);
        const freshness = active
            ? readRallarGroupDirectorFreshness(appointment, heartbeat?.atEpochMs, now)
            : appointment
            ? 'stale'
            : 'none';
        const isDirector = isRallarGroupDirectorForSession(
            appointment,
            this.input.readSession()
        );
        return {
            roomRef,
            roomId: roomRef?.groupId ?? this.input.roomStateStore.toRoomId(target),
            role: appointment ? (isDirector ? 'director' : 'client') : 'none',
            state: !appointment ? 'none' : !active ? 'inactive' : freshness,
            appointment,
            isDirector,
            isFresh: freshness === 'fresh' && active,
            active,
            freshness,
            lastHeartbeatAtEpochMs: heartbeat?.atEpochMs,
            nowEpochMs: now
        };
    }

    public findSnapshot(room?: string | GroupRef): GroupSnapshot | undefined {
        return readConfiguredValue(() => this.input.roomStateStore.findGroupSnapshot(room));
    }

    public resolveRoomRef(
        room: string | GroupRef | undefined,
        snapshot?: GroupSnapshot
    ): GroupRef | undefined {
        return typeof room === 'object'
            ? room
            : snapshot?.group ?? this.input.roomStateStore.resolveRoomRef(room);
    }

    public recordHeartbeat(
        roomRef: GroupRef,
        appointment: RallarGroupDirectorAppointment,
        atEpochMs = this.input.nowMs()
    ): void {
        this.heartbeatByRoom.set(toRoomKey(roomRef), {
            sessionId: appointment.sessionId,
            epoch: appointment.epoch,
            atEpochMs
        });
    }

    public removeHeartbeat(roomRef: GroupRef): void {
        this.heartbeatByRoom.delete(toRoomKey(roomRef));
    }

    public emit(): void {
        if (this.notifications.size === 0) {
            return;
        }
        this.notifications.publishLatest(this.read());
    }

    public onStatus(listener: RallarDirectorStatusListener): RallarUnsubscribe {
        const current = this.read();
        const subscription = this.notifications.subscribeAndNotify(listener, current);
        return () => subscription.unsubscribe();
    }

    private readMatchingHeartbeat(
        roomRef: GroupRef | undefined,
        appointment: RallarGroupDirectorAppointment | undefined
    ): BrowserDirectorStatusRuntime.Heartbeat | undefined {
        const heartbeat = roomRef
            ? this.heartbeatByRoom.get(toRoomKey(roomRef))
            : undefined;
        return heartbeat && appointment &&
                heartbeat.sessionId === appointment.sessionId &&
                heartbeat.epoch === appointment.epoch
            ? heartbeat
            : undefined;
    }
}

function toRoomKey(roomRef: GroupRef): string {
    return JSON.stringify([
        roomRef.applicationId,
        roomRef.workspaceId ?? '',
        roomRef.groupId
    ]);
}
