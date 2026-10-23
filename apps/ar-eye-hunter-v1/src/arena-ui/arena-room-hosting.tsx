import { useEffect, useState } from 'react';
import { ArenaRoomSharing, isCurrentArenaHost } from './arena-room-sharing.tsx';

import { rallar } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type {
    GroupJoinMode,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';

interface ArenaRoomHostingProps {
    readonly arena: Pick<ArenaConnection, 'session' | 'rooms' | 'roomId' | 'createArenaRoom'>;
}

interface ArenaRoomCode {
    readonly sessionId: string;
    readonly response: GroupJoinCodeResponse;
}

interface ArenaHostingOperation {
    readonly arena: ArenaRoomHostingProps['arena'];
    readonly snapshot: GroupSnapshot | undefined;
    readonly setBusy: (busy: boolean) => void;
    readonly setError: (error: string | undefined) => void;
    readonly setCode: (code: ArenaRoomCode | undefined) => void;
}

export function ArenaRoomHosting({ arena }: ArenaRoomHostingProps) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [code, setCode] = useState<ArenaRoomCode | undefined>();
    const snapshot = arena.rooms.find((room) => room.roomId === arena.roomId)?.snapshot;
    const roomKey = snapshot
        ? JSON.stringify(
            [snapshot.group.applicationId, snapshot.group.workspaceId, snapshot.group.groupId]
        )
        : null;
    useEffect(() => {
        setCode((current) =>
            current && current.sessionId === arena.session?.sessionId && snapshot &&
                isSameGroupRef(current.response.snapshot.group, snapshot.group)
                ? current
                : undefined
        );
        setError(undefined);
        setBusy(false);
    }, [roomKey, arena.session?.sessionId]);
    const actions = { arena, snapshot, setBusy, setError, setCode };
    const create = (joinMode: GroupJoinMode, directoryListing?: GroupDirectoryListing) =>
        createArena(actions, joinMode, directoryListing);
    const rotate = () => rotateArenaCode(actions);
    const canShare = snapshot &&
        snapshot.members.some((member) =>
            member.principalId === arena.session?.clientId && member.status === 'active' &&
            (member.role === 'owner' || member.role === 'admin')
        );
    return (
        <section className="stack" aria-label="Arena hosting">
            <div className="room-actions">
                <button type="button" disabled={busy} onClick={() => void create('open', 'unlisted')}>
                    New unlisted arena
                </button>
                <button type="button" disabled={busy} onClick={() => void create('code')}>New code arena</button>
                <button type="button" disabled={busy} onClick={() => void create('invite-only')}>
                    New invite-only arena
                </button>
            </div>
            {error && <p role="alert">{error}</p>}
            {canShare && (
                <ArenaRoomSharing
                    key={`${arena.session?.sessionId}:${roomKey}`}
                    snapshot={snapshot}
                    code={code?.sessionId === arena.session?.sessionId ? code?.response : undefined}
                    busy={busy}
                    rotate={rotate}
                />
            )}
        </section>
    );
}

async function createArena(
    input: ArenaHostingOperation,
    joinMode: GroupJoinMode,
    directoryListing?: GroupDirectoryListing
): Promise<void> {
    const { arena, setBusy, setError, setCode } = input;
    const session = rallar.session();
    let room = rallar.rooms.state().currentRoomRef;
    setBusy(true);
    setError(undefined);
    setCode(undefined);
    try {
        const snapshot = await arena.createArenaRoom(joinMode, directoryListing);
        room = snapshot?.group ?? room;
        if (snapshot && session && isCurrentArenaHost(session, snapshot.group) && joinMode === 'code') {
            const code = await rallar.rooms.rotateJoinCode(snapshot.group);
            if (isCurrentArenaHost(session, snapshot.group)) {
                setCode({ sessionId: session.sessionId, response: code });
            }
        }
    }
    catch (error) {
        if (isCurrentArenaHost(session, room)) {
            setError(
                error instanceof Error && error.name === 'RallarRoomJoinPartialFailureError'
                    ? 'The arena was created, but connecting failed. Refresh your rooms and select it to retry.'
                    : 'Could not create the arena. Check your connection and try again.'
            );
        }
    }
    finally {
        if (isCurrentArenaHost(session, room)) {
            setBusy(false);
        }
    }
}

async function rotateArenaCode(
    input: ArenaHostingOperation
): Promise<void> {
    const { snapshot, setBusy, setError, setCode } = input;
    if (!snapshot) {
        return;
    }
    const session = rallar.session();
    if (!session) {
        return;
    }
    setBusy(true);
    setError(undefined);
    setCode(undefined);
    try {
        const code = await rallar.rooms.rotateJoinCode(snapshot.group);
        if (isCurrentArenaHost(session, snapshot.group)) {
            setCode({ sessionId: session.sessionId, response: code });
        }
    }
    catch {
        if (isCurrentArenaHost(session, snapshot.group)) {
            setError('Could not rotate the room code. No new code is available; try again.');
        }
    }
    finally {
        if (isCurrentArenaHost(session, snapshot.group)) {
            setBusy(false);
        }
    }
}
