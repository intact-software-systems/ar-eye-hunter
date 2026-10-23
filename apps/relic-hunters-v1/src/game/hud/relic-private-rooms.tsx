import { useEffect, useState } from 'react';

import { toRoomEntryUrl } from '@shared-web/browser/rallar-room-entry.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupJoinMode, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';

import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';

interface RelicPrivateRoomsProps {
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

export function RelicPrivateRooms({ game }: RelicPrivateRoomsProps) {
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
    const hosting = snapshot && snapshot.group.joinMode !== 'open' &&
        snapshot.members.some((member) =>
            member.principalId === game.session?.clientId && member.status === 'active' &&
            (member.role === 'owner' || member.role === 'admin')
        );
    const currentCode = code?.sessionId === game.session?.sessionId ? code?.response : undefined;
    return (
        <section className="stack" aria-label="Private expedition hosting">
            <div className="button-grid">
                <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => void createPrivateRelicRoom(operation, 'code')}
                >
                    New code room
                </button>
                <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => void createPrivateRelicRoom(operation, 'invite-only')}
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

async function createPrivateRelicRoom(operation: RelicHostingOperation, joinMode: GroupJoinMode): Promise<void> {
    const session = rallar.session();
    operation.setBusy(true);
    operation.setError(undefined);
    operation.setCode(undefined);
    try {
        const snapshot = await operation.game.createRoom(joinMode);
        if (snapshot && session && isCurrentRelicRoom(session, snapshot.group) && joinMode === 'code') {
            const response = await rallar.rooms.rotateJoinCode(snapshot.group);
            if (isCurrentRelicRoom(session, snapshot.group)) {
                operation.setCode({ sessionId: session.sessionId, response });
            }
        }
    }
    catch {
        operation.setError(
            'Could not finish creating the private room. Check your connection and current room, then retry.'
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

async function copyRelicRoomLink(link: string, setStatus: (status: string) => void): Promise<void> {
    try {
        await navigator.clipboard.writeText(link);
        setStatus('Room link copied.');
    }
    catch {
        setStatus('Copy is unavailable. Select and copy the room link above.');
    }
}

interface RelicRoomInvitationsProps {
    readonly snapshot: GroupSnapshot;
}

function RelicRoomInvitations({ snapshot }: RelicRoomInvitationsProps) {
    const [principalId, setPrincipalId] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const change = (principalId: string, revoke: boolean) =>
        changeRelicInvitation({
            room: snapshot.group,
            principalId,
            revoke,
            setBusy,
            setError
        });
    return (
        <div className="stack">
            <label>
                Account reference<input
                    value={principalId}
                    onChange={(event) => setPrincipalId(event.target.value)}
                    autoComplete="off"
                />
            </label>
            <small>Ask the guest to share the account reference shown in their profile.</small>
            <button
                type="button"
                disabled={busy || !principalId.trim()}
                onClick={() => void change(principalId.trim(), false)}
            >
                Invite account
            </button>
            {snapshot.members.filter((member) => member.status === 'invited').map((member) => (
                <div key={member.principalId}>
                    <p>
                        {member.principalId} — invited{member.invitationExpiresAtEpochMs !== null &&
                            ` until ${new Date(member.invitationExpiresAtEpochMs).toLocaleString()}`}
                    </p>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            void change(member.principalId, true)}
                    >
                        Revoke invitation
                    </button>
                </div>
            ))}
            {error && <p role="alert">{error}</p>}
        </div>
    );
}

interface RelicInvitationChange {
    readonly room: GroupRef;
    readonly principalId: string;
    readonly revoke: boolean;
    readonly setBusy: (busy: boolean) => void;
    readonly setError: (error: string | undefined) => void;
}

async function changeRelicInvitation(invitation: RelicInvitationChange): Promise<void> {
    invitation.setBusy(true);
    invitation.setError(undefined);
    try {
        if (invitation.revoke) {
            await rallar.rooms.revokeInvite(invitation.room, invitation.principalId);
        }
        else {
            await rallar.rooms.invite(invitation.room, invitation.principalId);
        }
    }
    catch {
        invitation.setError('Could not update the invitation. Check the account reference and try again.');
    }
    finally {
        invitation.setBusy(false);
    }
}
