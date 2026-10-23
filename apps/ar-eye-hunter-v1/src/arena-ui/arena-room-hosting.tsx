import { useEffect, useState } from 'react';
import { ArenaRoomInvitations } from './arena-room-invitations.tsx';

import { toRoomEntryUrl } from '@shared-web/browser/rallar-room-entry.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import {
    toGroupDirectoryListing,
    type GroupDirectoryListing
} from '@shared/api/group-directory/group-directory-listing.ts';
import type {
    GroupJoinMode,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';

interface ArenaRoomHostingProps {
    readonly arena: Pick<ArenaConnection, 'session' | 'rooms' | 'roomId' | 'createArenaRoom'>;
}

interface ArenaRoomSharingProps {
    readonly snapshot: GroupSnapshot;
    readonly code: GroupJoinCodeResponse | undefined;
    readonly busy: boolean;
    readonly rotate: () => Promise<void>;
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
    setBusy(true);
    setError(undefined);
    setCode(undefined);
    try {
        const snapshot = await arena.createArenaRoom(joinMode, directoryListing);
        if (snapshot && session && isCurrentArenaHost(session, snapshot.group) && joinMode === 'code') {
            const code = await rallar.rooms.rotateJoinCode(snapshot.group);
            if (isCurrentArenaHost(session, snapshot.group)) {
                setCode({ sessionId: session.sessionId, response: code });
            }
        }
    }
    catch (error) {
        setError(
            error instanceof Error && error.name === 'RallarRoomJoinPartialFailureError'
                ? 'The arena was created, but connecting failed. Refresh your rooms and select it to retry.'
                : 'Could not create the arena. Check your connection and try again.'
        );
    }
    finally {
        setBusy(false);
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
        setError('Could not rotate the room code. No new code is available; try again.');
    }
    finally {
        setBusy(false);
    }
}

function isCurrentArenaHost(session: AuthSession | undefined, room: GroupRef): boolean {
    const current = rallar.session();
    const currentRoom = rallar.rooms.state().currentRoomRef;
    return session !== undefined && current?.sessionId === session.sessionId && current.clientId === session.clientId &&
        currentRoom !== undefined && isSameGroupRef(currentRoom, room);
}

function ArenaRoomSharing({ snapshot, code, busy, rotate }: ArenaRoomSharingProps) {
    const [copyStatus, setCopyStatus] = useState('');
    const codeMatches = code && isSameGroupRef(code.snapshot.group, snapshot.group);
    const destination = { roomRef: snapshot.group, joinCode: codeMatches ? code.joinCode : null };
    const link = snapshot.group.joinMode === 'code' && !codeMatches
        ? ''
        : toRoomEntryUrl(window.location.href, destination).fold(() => '', (url) => url);
    return (
        <div className="stack">
            <p>
                Room reference: <strong>{snapshot.group.groupId}</strong>
            </p>
            <label>
                Room link<input value={link} readOnly />
            </label>
            <button type="button" disabled={!link} onClick={() => void copyRoomLink(link, setCopyStatus)}>
                Copy room link
            </button>
            {copyStatus && <p>{copyStatus}</p>}
            {snapshot.group.joinMode === 'open' && <ArenaDirectoryListing snapshot={snapshot} />}
            {snapshot.group.joinMode === 'code' && (
                <>
                    {codeMatches && (
                        <p>
                            Room code: <strong>{code.joinCode}</strong>
                            <br />Expires {new Date(code.expiresAtEpochMs).toLocaleString()}
                        </p>
                    )}
                    <button type="button" disabled={busy} onClick={() => void rotate()}>Rotate room code</button>
                    <p className="muted">
                        Rotating the code stops new entries with the old code. Current members can return.
                    </p>
                </>
            )}
            {snapshot.group.joinMode === 'invite-only' && <ArenaRoomInvitations snapshot={snapshot} />}
        </div>
    );
}

function ArenaDirectoryListing({ snapshot }: Pick<ArenaRoomSharingProps, 'snapshot'>) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const listing = toGroupDirectoryListing(snapshot.group.metadata);
    const change = async () => {
        const session = rallar.session();
        if (!session) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await rallar.rooms.update({
                roomRef: snapshot.group,
                directoryListing: listing === 'listed' ? 'unlisted' : 'listed'
            });
        }
        catch {
            if (isCurrentArenaHost(session, snapshot.group)) {
                setError('Could not change room listing. Check your connection and try again.');
            }
        }
        finally {
            if (isCurrentArenaHost(session, snapshot.group)) {
                setBusy(false);
            }
        }
    };
    return (
        <div className="stack">
            <p className="muted">
                {listing === 'listed' ? 'Listed in discovery.' : 'Unlisted: hidden from discovery and Quick Join.'}{' '}
                Anyone with the link can enter.
            </p>
            <button type="button" disabled={busy} onClick={() => void change()}>
                {listing === 'listed' ? 'Unlist room' : 'List room'}
            </button>
            {error && <p role="alert">{error}</p>}
        </div>
    );
}

async function copyRoomLink(link: string, setStatus: (status: string) => void): Promise<void> {
    try {
        await navigator.clipboard.writeText(link);
        setStatus('Room link copied.');
    }
    catch {
        setStatus('Copy is unavailable. Select and copy the room link above.');
    }
}
