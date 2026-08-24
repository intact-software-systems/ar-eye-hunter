import type {
    RallarDirectorStatus,
    RallarDirectorStatusListener,
    RallarDirectorStatusOptions
} from '@shared-web/browser/rallar-director-facade.ts';
import { notifyListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    isRallarGroupDirectorForSession,
    isRallarGroupDirectorSessionActive,
    readRallarGroupDirectorFreshness,
    readRallarGroupDirectorFromSnapshot,
    type RallarGroupDirectorAppointment
} from '@shared/api/group-director.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

export interface BrowserDirectorStatusRuntimeInput {
    readonly roomStateStore: RallarRoomStateStorePort;
    readSession(): AuthSession | undefined;
    resolveDefaultRoom(): string | GroupRef | undefined;
}

interface DirectorHeartbeat {
    readonly sessionId: string;
    readonly epoch: number;
    readonly atEpochMs: number;
}

export class BrowserDirectorStatusRuntime {
    private readonly input: BrowserDirectorStatusRuntimeInput;
    private readonly listeners = new Set<RallarDirectorStatusListener>();
    private readonly heartbeatByRoom = new Map<string, DirectorHeartbeat>();

    public constructor(input: BrowserDirectorStatusRuntimeInput) {
        this.input = input;
    }

    public read(
        room?: string | GroupRef,
        options: RallarDirectorStatusOptions = {}
    ): RallarDirectorStatus {
        const target = room ?? this.input.resolveDefaultRoom() ??
            this.input.roomStateStore.resolveCurrentRoomRef();
        const snapshot = this.findSnapshot(target);
        const roomRef = this.resolveRoomRef(target, snapshot);
        const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
        const heartbeat = this.readMatchingHeartbeat(roomRef, appointment);
        const now = options.now ?? Date.now();
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
        return room
            ? this.input.roomStateStore.findGroupSnapshot(room)
            : this.input.roomStateStore.state().currentRoom;
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
        atEpochMs = Date.now()
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
        if (this.listeners.size === 0) {
            return;
        }
        const current = this.read();
        for (const listener of this.listeners) {
            notifyListener(listener, current);
        }
    }

    public onStatus(listener: RallarDirectorStatusListener): RallarUnsubscribe {
        this.listeners.add(listener);
        notifyListener(listener, this.read());
        return () => this.listeners.delete(listener);
    }

    private readMatchingHeartbeat(
        roomRef: GroupRef | undefined,
        appointment: RallarGroupDirectorAppointment | undefined
    ): DirectorHeartbeat | undefined {
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
