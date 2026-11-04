import {
    useRoomHostingState,
    type RoomHostingPending,
    type RoomHostingState
} from '@shared-react/use-room-hosting-state.ts';
import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { toScopedRoomKey } from '@shared/api/api-type-utils.ts';
import type { GroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupJoinMode, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';
import { isCurrentRelicRoom, RelicRoomSharing } from './relic-room-sharing.tsx';

interface RelicRoomHostingProps {
    readonly game: Pick<RelicHuntersRuntime.Connection, 'session' | 'rooms' | 'roomId' | 'createRoom'> & {
        readonly diagnostics: Pick<RelicHuntersRuntime.Connection['diagnostics'], 'middlewareConnected'>;
    };
}

interface RelicHostingOperation
    extends Pick<RoomHostingState, 'pendingOperation' | 'setPending' | 'setError' | 'setCode'> {
    readonly game: RelicRoomHostingProps['game'];
    readonly snapshot: GroupSnapshot | undefined;
}

export function RelicRoomHosting({ game }: RelicRoomHostingProps) {
    const snapshot = game.rooms.find((room) => room.roomId === game.roomId)?.snapshot;
    const roomKey = snapshot ? toScopedRoomKey(snapshot.group) : null;
    const { busy, code, error, pendingOperation, setPending, setError, setCode } = useRoomHostingState({
        session: game.session,
        roomId: game.roomId,
        snapshot
    });
    const operation = { game, snapshot, pendingOperation, setPending, setError, setCode };
    const unavailable = busy || !game.diagnostics.middlewareConnected;
    const hosting = snapshot &&
        snapshot.members.some((member) =>
            member.principalId === game.session?.clientId && member.status === 'active' &&
            (member.role === 'owner' || member.role === 'admin')
        );
    return (
        <section className="stack" aria-label="Expedition hosting">
            <RelicRoomCreationControls operation={operation} disabled={unavailable} />
            {error && <p role="alert">{error}</p>}
            {hosting && (
                <RelicRoomSharing
                    key={`${game.session?.sessionId}:${roomKey}`}
                    snapshot={snapshot}
                    code={code}
                    busy={busy}
                    rotate={() => rotateRelicRoomCode(operation)}
                />
            )}
        </section>
    );
}

interface RelicRoomCreationControlsProps {
    readonly operation: RelicHostingOperation;
    readonly disabled: boolean;
}

function RelicRoomCreationControls({ operation, disabled }: RelicRoomCreationControlsProps) {
    return (
        <div className="button-grid">
            <button
                type="button"
                disabled={disabled}
                onClick={() => void createRelicRoom(operation, 'open', 'unlisted')}
            >
                New unlisted room
            </button>
            <button
                type="button"
                disabled={disabled}
                onClick={() => void createRelicRoom(operation, 'code')}
            >
                New code room
            </button>
            <button
                type="button"
                disabled={disabled}
                onClick={() => void createRelicRoom(operation, 'invite-only')}
            >
                New invite-only room
            </button>
        </div>
    );
}

async function createRelicRoom(
    operation: RelicHostingOperation,
    joinMode: GroupJoinMode,
    directoryListing?: GroupDirectoryListing
): Promise<void> {
    const session = rallar.session();
    if (!session) {
        return;
    }
    let room = rallar.rooms.state().currentRoomRef;
    let pending: RoomHostingPending = { kind: 'creating', sessionKey: toAuthSessionKey(session) };
    operation.pendingOperation.current = pending;
    operation.setPending(pending);
    operation.setError(undefined);
    operation.setCode(undefined);
    try {
        const snapshot = await operation.game.createRoom(joinMode, directoryListing);
        room = snapshot?.group ?? room;
        if (
            operation.pendingOperation.current === pending && snapshot &&
            rallar.session()?.sessionId === session.sessionId && rallar.session()?.clientId === session.clientId &&
            joinMode === 'code'
        ) {
            pending = { kind: 'rotating', sessionKey: toAuthSessionKey(session), room: snapshot.group };
            operation.pendingOperation.current = pending;
            operation.setPending(pending);
            const response = await rallar.rooms.rotateJoinCode(snapshot.group);
            if (
                operation.pendingOperation.current === pending && rallar.session()?.sessionId === session.sessionId &&
                rallar.session()?.clientId === session.clientId
            ) {
                operation.setCode({ sessionKey: toAuthSessionKey(session), response });
            }
        }
    }
    catch {
        if (operation.pendingOperation.current === pending && isCurrentRelicRoom(session, room)) {
            operation.setError(
                'Could not finish creating the room. Check your connection and current room, then retry.'
            );
        }
    }
    finally {
        if (operation.pendingOperation.current === pending) {
            operation.pendingOperation.current = undefined;
            operation.setPending(undefined);
        }
    }
}

async function rotateRelicRoomCode(operation: RelicHostingOperation): Promise<void> {
    const session = rallar.session();
    const room = operation.snapshot?.group;
    if (!session || !room) {
        return;
    }
    const pending = { kind: 'rotating', sessionKey: toAuthSessionKey(session), room: room } as const;
    operation.pendingOperation.current = pending;
    operation.setPending(pending);
    operation.setError(undefined);
    operation.setCode(undefined);
    try {
        const response = await rallar.rooms.rotateJoinCode(room);
        if (
            operation.pendingOperation.current === pending && rallar.session()?.sessionId === session.sessionId &&
            rallar.session()?.clientId === session.clientId
        ) {
            operation.setCode({ sessionKey: toAuthSessionKey(session), response });
        }
    }
    catch {
        if (operation.pendingOperation.current === pending && isCurrentRelicRoom(session, room)) {
            operation.setError('Could not rotate the room code. No new code is available; try again.');
        }
    }
    finally {
        if (operation.pendingOperation.current === pending) {
            operation.pendingOperation.current = undefined;
            operation.setPending(undefined);
        }
    }
}
