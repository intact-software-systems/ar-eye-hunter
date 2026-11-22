import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { readRallarGroupDirectorAppointment, type RallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { decodeRoomDirectorSuccessionCommand, readRoomDirectorSuccession, type RoomDirectorSuccession } from '@shared/api/room-directors/room-director-succession-record.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { CreateBrowserRallarRoomsInput } from '../rooms/browser-rallar-rooms.ts';
import { roomGroupStateHttpApi } from '../rooms/room-group-state-http-api.ts';
import { captureRoomSession } from '../rooms/room-session-fence.ts';
import { explicitRoomRef, readObservedRoom, watchRoomRevision, type ObservedRoomMetadata } from '../state-read/watch-room-revision.ts';

export namespace RoomDirectorOperations {
    export interface View {
        readonly revision: number;
        readonly appointment: RallarGroupDirectorAppointment | null;
        readonly succession: RoomDirectorSuccession | null;
    }
    export interface Observation {
        readonly status: 'current' | 'stale';
        readonly value: View | null;
    }
}

export interface RoomDirectorOperations {
    changeDirector(room: GroupRef, command: RoomDirectorSuccession.Command, requestId: string,
        options?: { readonly signal?: AbortSignal }): Promise<RoomDirectorOperations.View>;
    readDirector(room: GroupRef, options?: { readonly signal?: AbortSignal }): Promise<RoomDirectorOperations.View>;
    watchDirector(room: GroupRef, listener: (observation: RoomDirectorOperations.Observation) => void,
        options?: { readonly signal?: AbortSignal }): () => void;
}

function directorView(group: ObservedRoomMetadata): RoomDirectorOperations.View {
    return { revision: group.snapshotVersion, appointment: readRallarGroupDirectorAppointment(group.metadata) ?? null,
        succession: readRoomDirectorSuccession(group.metadata) };
}

function acknowledges(view: RoomDirectorOperations.View, command: RoomDirectorSuccession.Command, actor: { clientId: string; sessionId: string }): boolean {
    const { succession, appointment } = view;
    if (!succession) return false;
    if (command.operation === 'configure') {
        return succession.revision > command.expectedRevision && (appointment?.epoch ?? 0) === command.expectedDirectorEpoch &&
            succession.deputyPrincipalId === command.deputyPrincipalId &&
            (command.reconnectWindowMs === undefined || succession.reconnectWindowMs === command.reconnectWindowMs) &&
            (command.deputyWindowMs === undefined || succession.deputyWindowMs === command.deputyWindowMs);
    }
    if (command.operation === 'decline-deputy') return succession.loss?.directorEpoch === command.expectedDirectorEpoch && succession.loss.declined;
    const principalId = command.operation === 'appoint' ? command.targetPrincipalId : actor.clientId;
    const sessionId = command.operation === 'appoint' ? command.targetSessionId : actor.sessionId;
    return appointment?.epoch === command.expectedDirectorEpoch + 1 && appointment.principalId === principalId &&
        appointment.sessionId === sessionId && succession.loss === null;
}

export function createRoomDirectorOperations(services:
    Pick<CreateBrowserRallarRoomsInput, 'requireSession' | 'roomEvents' | 'ws' | 'auth'>): RoomDirectorOperations {
    const { requireSession } = services;
    return {
        async readDirector(room, { signal } = {}) {
            return directorView(await readObservedRoom(room, requireSession, signal));
        },
        async changeDirector(roomRef, command, requestId, options = {}) {
            const room = explicitRoomRef(roomRef);
            const succession = decodeRoomDirectorSuccessionCommand(command);
            const fence = captureRoomSession(requireSession, options.signal);
            fence.assertCurrent();
            const snapshot = await roomGroupStateHttpApi.appointDirector({ groupId: room.groupId, scope: room,
                request: { actorPrincipalId: fence.session.clientId, actorSessionId: fence.session.sessionId, succession },
                options: { authSession: fence.session, requestId, signal: options.signal } });
            fence.assertCurrent();
            validateAuthoritativeGroupSnapshot(snapshot, room);
            const view = directorView(snapshot.group);
            if (!isSameGroupRef(snapshot.group, room) || !acknowledges(view, succession, fence.session)) {
                throw new Error('The room did not acknowledge the requested director change.');
            }
            return view;
        },
        watchDirector(room, listener, options = {}) {
            return watchRoomRevision({ room, services, signal: options.signal, listener, project: directorView,
                onDelta(previous, next) {
                    if (previous.appointment?.epoch !== next.appointment?.epoch ||
                        previous.succession?.revision !== next.succession?.revision) return 'refresh';
                    return previous.succession?.directorLeaseExpiresAtEpochMs === next.succession?.directorLeaseExpiresAtEpochMs
                        ? 'ignore' : 'publish';
                },
                regresses: (previous, next) => (next.appointment?.epoch ?? 0) < (previous.appointment?.epoch ?? 0) ||
                    (next.succession?.revision ?? 0) < (previous.succession?.revision ?? 0) });
        }
    };
}
