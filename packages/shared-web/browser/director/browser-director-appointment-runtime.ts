import { appointStateGroupDirector } from '@shared-web/browser/director/appoint-room-director.ts';
import type {
    RallarDirectorAppointOptions,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import {
    isRallarGroupDirectorForSession,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorFromSnapshot
} from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { BrowserDirectorStatusRuntime } from './browser-director-status-runtime.ts';

export namespace BrowserDirectorAppointmentRuntime {
    export interface Input {
        readonly roomStateStore: RallarRoomStateStorePort;
        readonly rooms: BrowserRallarRooms;
        readonly status: BrowserDirectorStatusRuntime;
        requireSession(): AuthSession;
        connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
        resolveOperationOptions<T extends RallarOperationOptions>(
            options: T
        ): T & RallarOperationOptions;
        resolveDefaultRoom(): string | GroupRef | undefined;
        runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
        acceptSnapshots(input: RallarStateSnapshotAcceptanceInput): Promise<void>;
    }
}

/** Owns director appointment and resignation state mutations. */
export class BrowserDirectorAppointmentRuntime {
    private readonly input: BrowserDirectorAppointmentRuntime.Input;

    public constructor(input: BrowserDirectorAppointmentRuntime.Input) {
        this.input = input;
    }

    public async appoint(
        room?: string | GroupRef,
        options: RallarDirectorAppointOptions = {}
    ): Promise<RallarDirectorStatus> {
        return await this.input.runAuthAwareOperation(async () => {
            const operationOptions = this.input.resolveOperationOptions(options);
            const context = await this.input.connect(operationOptions);
            const target = room ?? this.input.resolveDefaultRoom() ??
                this.input.roomStateStore.resolveCurrentRoomRef();
            const snapshot = this.input.status.findSnapshot(target);
            const roomRef = this.input.status.resolveRoomRef(target, snapshot);
            const roomId = this.input.roomStateStore.toRoomId(roomRef ?? target);
            if (!roomRef || !roomId) {
                throw new Error('Cannot appoint director: no room selected.');
            }
            const session = this.input.requireSession();
            const scope = options.scope ?? toStateScope(roomRef);
            const updated = await appointStateGroupDirector({
                groupId: roomId,
                request: { heartbeatTtlMs: options.heartbeatTtlMs },
                principalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies: toRallarWorkflowPolicies(operationOptions)
            });
            await this.input.acceptSnapshots({
                context,
                clients: [],
                groups: [updated],
                scope
            });
            const appointment = readRallarGroupDirectorFromSnapshot(updated);
            if (appointment) {
                this.input.status.recordHeartbeat(roomRef, appointment);
            }
            this.input.status.emit();
            return this.input.status.read(updated.group);
        });
    }

    public async resign(
        room?: string | GroupRef,
        options: RallarScopedOperationOptions = {}
    ): Promise<RallarDirectorStatus> {
        const target = room ?? this.input.resolveDefaultRoom() ??
            this.input.roomStateStore.resolveCurrentRoomRef();
        const snapshot = this.input.status.findSnapshot(target);
        const roomRef = this.input.status.resolveRoomRef(target, snapshot);
        const roomId = this.input.roomStateStore.toRoomId(roomRef ?? target);
        if (!roomRef || !roomId) {
            throw new Error('Cannot resign director: no room selected.');
        }
        const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
        if (!isRallarGroupDirectorForSession(appointment, this.input.requireSession())) {
            return this.input.status.read(roomRef);
        }
        const metadata = mergeRallarGroupDirectorMetadata(
            snapshot?.group.metadata,
            undefined
        );
        const updated = await this.input.rooms.updateMetadata(
            roomRef,
            metadata,
            options
        );
        this.input.status.removeHeartbeat(roomRef);
        this.input.status.emit();
        return this.input.status.read(updated.group);
    }
}
