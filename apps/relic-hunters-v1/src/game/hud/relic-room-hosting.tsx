import { useEffect, useState } from 'react';
import { RelicRoomInvitations } from './relic-room-invitations.tsx';

import { toRoomEntryUrl } from '@shared-web/browser/rallar-room-entry.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import {
    toGroupDirectoryListing,
    type GroupDirectoryListing
} from '@shared/api/group-directory/group-directory-listing.ts';
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

interface RelicHostingOperation {
    readonly game: RelicHuntersRuntime.Connection;
    readonly snapshot: GroupSnapshot | undefined;
    readonly setBusy: (busy: boolean) => void;
    readonly setError: (error: string | undefined) => void;
    readonly setCode: (code: RelicRoomCode | undefined) => void;
}

export function RelicRoomHosting({ game }: RelicRoomHostingProps) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [code, setCode] = useState<RelicRoomCode | undefined>();
    const snapshot = game.rooms.find((room) => room.roomId === game.roomId)?.snapshot;
    useEffect(() => {
        setCode((current) =>
            current && current.sessionId === game.session?.sessionId && snapshot &&
                isSameGroupRef(current.response.snapshot.group, snapshot.group)
                ? current
                : undefined
        );
        setError(undefined);
    }, [game.session?.sessionId, game.roomId]);
    const operation = { game, snapshot, setBusy, setError, setCode };
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
                    key={`${game.session?.sessionId}:${game.roomId}`}
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
    operation.setBusy(true);
    operation.setError(undefined);
    operation.setCode(undefined);
    try {
        const snapshot = await operation.game.createRoom(joinMode, directoryListing);
        if (snapshot && session && isCurrentRelicRoom(session, snapshot.group) && joinMode === 'code') {
            const response = await rallar.rooms.rotateJoinCode(snapshot.group);
            if (isCurrentRelicRoom(session, snapshot.group)) {
                operation.setCode({ sessionId: session.sessionId, response });
            }
        }
    }
    catch {
        operation.setError(
            'Could not finish creating the room. Check your connection and current room, then retry.'
        );
    }
    finally {
        operation.setBusy(false);
    }
}

async function rotateRelicRoomCode(operation: RelicHostingOperation): Promise<void> {
    const session = rallar.session();
    const room = operation.snapshot?.group;
    if (!session || !room) {
        return;
    }
    operation.setBusy(true);
    operation.setError(undefined);
    operation.setCode(undefined);
    try {
        const response = await rallar.rooms.rotateJoinCode(room);
        if (isCurrentRelicRoom(session, room)) {
            operation.setCode({ sessionId: session.sessionId, response });
        }
    }
    catch {
        operation.setError('Could not rotate the room code. No new code is available; try again.');
    }
    finally {
        operation.setBusy(false);
    }
}

function isCurrentRelicRoom(session: AuthSession, room: GroupRef): boolean {
    const current = rallar.session();
    const currentRoom = rallar.rooms.state().currentRoomRef;
    return current?.sessionId === session.sessionId && current.clientId === session.clientId &&
        currentRoom !== undefined && isSameGroupRef(currentRoom, room);
}

interface RelicRoomSharingProps {
    readonly snapshot: GroupSnapshot;
    readonly code: GroupJoinCodeResponse | undefined;
    readonly busy: boolean;
    readonly rotate: () => Promise<void>;
}

function RelicRoomSharing({ snapshot, code, busy, rotate }: RelicRoomSharingProps) {
    const [copyStatus, setCopyStatus] = useState('');
    const codeMatches = code && isSameGroupRef(code.snapshot.group, snapshot.group);
    const link = snapshot.group.joinMode === 'code' && !codeMatches ? '' : toRoomEntryUrl(window.location.href, {
        roomRef: snapshot.group,
        joinCode: codeMatches ? code.joinCode : null
    }).fold(() => '', (url) => url);
    return (
        <div className="stack">
            <p>
                Room reference: <strong>{snapshot.group.groupId}</strong>
            </p>
            <label>
                Room link<input value={link} readOnly />
            </label>
            <button type="button" disabled={!link} onClick={() => void copyRelicRoomLink(link, setCopyStatus)}>
                Copy room link
            </button>
            {copyStatus && <p>{copyStatus}</p>}
            {snapshot.group.joinMode === 'open' && <RelicDirectoryListing snapshot={snapshot} />}
            {snapshot.group.joinMode === 'code' && (
                <>
                    {codeMatches && (
                        <p>
                            Room code: <strong>{code.joinCode}</strong>
                            <br />Expires {new Date(code.expiresAtEpochMs).toLocaleString()}
                        </p>
                    )}
                    <button type="button" disabled={busy} onClick={() => void rotate()}>Rotate room code</button>
                    <small>Rotating the code stops new entries with the old code. Current members can return.</small>
                </>
            )}
            {snapshot.group.joinMode === 'invite-only' && <RelicRoomInvitations snapshot={snapshot} />}
        </div>
    );
}

function RelicDirectoryListing({ snapshot }: Pick<RelicRoomSharingProps, 'snapshot'>) {
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
            if (isCurrentRelicRoom(session, snapshot.group)) {
                setError('Could not change room listing. Check your connection and try again.');
            }
        }
        finally {
            if (isCurrentRelicRoom(session, snapshot.group)) {
                setBusy(false);
            }
        }
    };
    return (
        <div className="stack">
            <small>
                {listing === 'listed' ? 'Listed in discovery.' : 'Unlisted: hidden from discovery and Quick Join.'}{' '}
                Anyone with the link can enter.
            </small>
            <button type="button" disabled={busy} onClick={() => void change()}>
                {listing === 'listed' ? 'Unlist room' : 'List room'}
            </button>
            {error && <p role="alert">{error}</p>}
        </div>
    );
}

async function copyRelicRoomLink(link: string, setStatus: (status: string) => void): Promise<void> {
    try {
        await navigator.clipboard.writeText(link);
        setStatus('Room link copied.');
    }
    catch {
        setStatus('Copy is unavailable. Select and copy the room link above.');
    }
}
