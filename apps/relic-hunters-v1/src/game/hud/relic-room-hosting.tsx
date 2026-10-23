import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { isCurrentRelicRoom, RelicRoomSharing } from './relic-room-sharing.tsx';

import { rallar } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupJoinMode, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';

import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';

interface RelicRoomHostingProps {
    readonly game: RelicHuntersRuntime.Connection;
}

interface RelicRoomCode {
    readonly sessionId: string;
    readonly response: GroupJoinCodeResponse;
}

type RelicPendingHosting =
    | { readonly kind: 'creating'; readonly sessionId: string; }
    | { readonly kind: 'rotating'; readonly sessionId: string; readonly room: GroupRef; };

interface RelicHostingOperation {
    readonly game: RelicHuntersRuntime.Connection;
    readonly snapshot: GroupSnapshot | undefined;
    readonly setPending: Dispatch<SetStateAction<RelicPendingHosting | undefined>>;
    readonly setError: (error: string | undefined) => void;
    readonly setCode: (code: RelicRoomCode | undefined) => void;
}

export function RelicRoomHosting({ game }: RelicRoomHostingProps) {
    const [pending, setPending] = useState<RelicPendingHosting | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [code, setCode] = useState<RelicRoomCode | undefined>();
    const snapshot = game.rooms.find((room) => room.roomId === game.roomId)?.snapshot;
    const roomKey = snapshot
        ? JSON.stringify([snapshot.group.applicationId, snapshot.group.workspaceId, snapshot.group.groupId])
        : null;
    useEffect(() => {
        setCode((current) =>
            current && current.sessionId === game.session?.sessionId && snapshot &&
                isSameGroupRef(current.response.snapshot.group, snapshot.group)
                ? current
                : undefined
        );
        setError(undefined);
    }, [game.session?.sessionId, roomKey]);
    const busy = pending !== undefined && pending.sessionId === game.session?.sessionId &&
        (pending.kind === 'creating' || (snapshot !== undefined && isSameGroupRef(pending.room, snapshot.group)));
    const operation = { game, snapshot, setPending, setError, setCode };
    const unavailable = busy || !game.diagnostics.middlewareConnected;
    const hosting = snapshot &&
        snapshot.members.some((member) =>
            member.principalId === game.session?.clientId && member.status === 'active' &&
            (member.role === 'owner' || member.role === 'admin')
        );
    const currentCode = code?.sessionId === game.session?.sessionId ? code?.response : undefined;
    return (
        <section className="stack" aria-label="Expedition hosting">
            <div className="button-grid">
                <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => void createRelicRoom(operation, 'open', 'unlisted')}
                >
                    New unlisted room
                </button>
                <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => void createRelicRoom(operation, 'code')}
                >
                    New code room
                </button>
                <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => void createRelicRoom(operation, 'invite-only')}
                >
                    New invite-only room
                </button>
            </div>
            {error && <p role="alert">{error}</p>}
            {hosting && (
                <RelicRoomSharing
                    key={`${game.session?.sessionId}:${roomKey}`}
                    snapshot={snapshot}
                    code={currentCode}
                    busy={busy}
                    rotate={() => rotateRelicRoomCode(operation)}
                />
            )}
        </section>
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
    const pending = { kind: 'creating', sessionId: session.sessionId } as const;
    operation.setPending(pending);
    operation.setError(undefined);
    operation.setCode(undefined);
    try {
        const snapshot = await operation.game.createRoom(joinMode, directoryListing);
        room = snapshot?.group ?? room;
        if (snapshot && isCurrentRelicRoom(session, snapshot.group) && joinMode === 'code') {
            const response = await rallar.rooms.rotateJoinCode(snapshot.group);
            if (isCurrentRelicRoom(session, snapshot.group)) {
                operation.setCode({ sessionId: session.sessionId, response });
            }
        }
    }
    catch {
        if (isCurrentRelicRoom(session, room)) {
            operation.setError(
                'Could not finish creating the room. Check your connection and current room, then retry.'
            );
        }
    }
    finally {
        operation.setPending((current) => current === pending ? undefined : current);
    }
}

async function rotateRelicRoomCode(operation: RelicHostingOperation): Promise<void> {
    const session = rallar.session();
    const room = operation.snapshot?.group;
    if (!session || !room) {
        return;
    }
    const pending = { kind: 'rotating', sessionId: session.sessionId, room: room } as const;
    operation.setPending(pending);
    operation.setError(undefined);
    operation.setCode(undefined);
    try {
        const response = await rallar.rooms.rotateJoinCode(room);
        if (isCurrentRelicRoom(session, room)) {
            operation.setCode({ sessionId: session.sessionId, response });
        }
    }
    catch {
        if (isCurrentRelicRoom(session, room)) {
            operation.setError('Could not rotate the room code. No new code is available; try again.');
        }
    }
    finally {
        operation.setPending((current) => current === pending ? undefined : current);
    }
}
