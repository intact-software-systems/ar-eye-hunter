import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { readRallarGroupDirectorAppointment, type RallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { decodeRoomDirectorSuccessionCommand, readRoomDirectorSuccession, type RoomDirectorSuccession } from '@shared/api/group-director-succession-record.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef, assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { parseGroupStateDeltaEnvelope } from '../state-cache/group-state-delta-application.ts';
import { readStateGroupSnapshot } from '../state-read/point-read.ts';
import type { CreateBrowserRallarRoomsInput } from './browser-rallar-rooms.ts';
import { roomGroupStateHttpApi } from './room-group-state-http-api.ts';
import { captureRoomSession } from './room-session-fence.ts';
import { watchRoomRevision } from './watch-room-revision.ts';

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

function validateRoom(room: GroupRef): void {
    assertValidRallarGroupRef(room, '$.roomRef');
    assertValidRallarRouteId(room.workspaceId, '$.roomRef.workspaceId', 'Workspace ID');
}

function directorView(group: GroupSnapshot['group']): RoomDirectorOperations.View {
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

export function createRoomDirectorOperations({ requireSession, roomEvents, ws, auth }:
    Pick<CreateBrowserRallarRoomsInput, 'requireSession' | 'roomEvents' | 'ws' | 'auth'>): RoomDirectorOperations {
    async function readDirector(room: GroupRef, options: { readonly signal?: AbortSignal } = {}) {
        validateRoom(room);
        const fence = captureRoomSession(requireSession, options.signal);
        const result = await readStateGroupSnapshot(room.groupId, room, { authSession: fence.session, signal: options.signal });
        fence.assertCurrent();
        if (result.source !== 'durable' || !isSameGroupRef(result.snapshot.group, room)) throw new Error('Director observations require the requested durable room.');
        return directorView(result.snapshot.group);
    }
    return {
        readDirector,
        async changeDirector(room, command, requestId, options = {}) {
            validateRoom(room);
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
            validateRoom(room);
            const fence = captureRoomSession(requireSession, options.signal);
            let observed: RoomDirectorOperations.View | null = null;
            return watchRoomRevision<RoomDirectorOperations.View>({
                signal: options.signal, ws, listener,
                regresses: (previous, next) => (next.appointment?.epoch ?? 0) < (previous.appointment?.epoch ?? 0) ||
                    (next.succession?.revision ?? 0) < (previous.succession?.revision ?? 0),
                onSessionEnd: stop => auth.onChange(({ session }) => {
                    if (session?.sessionId !== fence.session.sessionId || session?.clientId !== fence.session.clientId) stop();
                }, { emitCurrent: false }),
                subscribe: changed => roomEvents.onEvent((_event, message) => {
                    if (message.transport !== 'ws') return;
                    const delta = parseGroupStateDeltaEnvelope(message.raw.payload.resource, room);
                    if (!delta) return;
                    const announced = directorView(delta.group);
                    if (observed?.appointment?.epoch !== announced.appointment?.epoch ||
                        observed?.succession?.revision !== announced.succession?.revision) changed(announced.revision);
                }, { roomRef: room, scope: room }),
                read: async signal => {
                    fence.assertCurrent();
                    observed = await readDirector(room, { signal });
                    return observed;
                }
            });
        }
    };
}
