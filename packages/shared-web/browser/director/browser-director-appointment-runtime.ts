import { appointStateGroupDirector } from '@shared-web/browser/director/appoint-room-director.ts';
import type {
    RallarDirectorAppointOptions,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { readRallarGroupDirectorFromSnapshot } from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { BrowserDirectorStatusRuntime } from './browser-director-status-runtime.ts';
import { resignStateGroupDirector } from './resign-room-director.ts';

export namespace BrowserDirectorAppointmentRuntime {
    export interface Input {
        readonly roomStateStore: RallarRoomStateStorePort;
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

    /** The room a director operation names, as its reference and its group id. */
    export interface Room {
        readonly roomRef: GroupRef;
        readonly roomId: string;
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
            const { roomRef, roomId } = this.resolveRoom(room, 'appoint');
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

    /** Decided on the room as the server holds it now, so a successor's appointment survives a stale cache. */
    public async resign(
        room?: string | GroupRef,
        options: RallarScopedOperationOptions = {}
    ): Promise<RallarDirectorStatus> {
        return await this.input.runAuthAwareOperation(async () => {
            const operationOptions = this.input.resolveOperationOptions(options);
            const context = await this.input.connect(operationOptions);
            const { roomRef, roomId } = this.resolveRoom(room, 'resign');
            const session = this.input.requireSession();
            const scope = options.scope ?? toStateScope(roomRef);
            const outcome = await resignStateGroupDirector({
                groupId: roomId,
                principalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies: toRallarWorkflowPolicies(operationOptions)
            });
            await this.input.acceptSnapshots({ context, clients: [], groups: [outcome.snapshot], scope });
            if (outcome.resigned) {
                this.input.status.removeHeartbeat(roomRef);
            }
            this.input.status.emit();
            return this.input.status.read(outcome.snapshot.group);
        });
    }

    private resolveRoom(
        room: string | GroupRef | undefined,
        operation: 'appoint' | 'resign'
    ): BrowserDirectorAppointmentRuntime.Room {
        const target = room ?? this.input.resolveDefaultRoom() ??
            this.input.roomStateStore.resolveCurrentRoomRef();
        const snapshot = this.input.status.findSnapshot(target);
        const roomRef = this.input.status.resolveRoomRef(target, snapshot);
        const roomId = this.input.roomStateStore.toRoomId(roomRef ?? target);
        if (!roomRef || !roomId) {
            throw new Error(`Cannot ${operation} director: no room selected.`);
        }
        return { roomRef, roomId };
    }
}
