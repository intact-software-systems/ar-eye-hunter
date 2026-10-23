import { useEffect, useState } from 'react';

import { toRoomEntryUrl } from '@shared-web/browser/rallar-room-entry.ts';
import { rallar, type RallarPerson } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type {
    GroupJoinMode,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';

interface ArenaPrivateRoomsProps {
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

interface ArenaPrivateRoomActionsInput {
    readonly arena: ArenaPrivateRoomsProps['arena'];
    readonly snapshot: GroupSnapshot | undefined;
    readonly setBusy: (busy: boolean) => void;
    readonly setError: (error: string | undefined) => void;
    readonly setCode: (code: ArenaRoomCode | undefined) => void;
}

interface ArenaInvitationChange {
    readonly room: GroupRef;
    readonly principalId: string;
    readonly revoke: boolean;
    readonly setBusy: (busy: boolean) => void;
    readonly setError: (error: string | undefined) => void;
}

export function ArenaPrivateRooms({ arena }: ArenaPrivateRoomsProps) {
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
    const create = (joinMode: GroupJoinMode) => createPrivateArena(actions, joinMode);
    const rotate = () => rotateArenaCode(actions);
    const canShare = snapshot && snapshot.group.joinMode !== 'open' &&
        snapshot.members.some((member) =>
            member.principalId === arena.session?.clientId && member.status === 'active' &&
            (member.role === 'owner' || member.role === 'admin')
        );
    return (
        <section className="stack" aria-label="Private arena hosting">
            <div className="room-actions">
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

async function createPrivateArena(
    input: ArenaPrivateRoomActionsInput,
    joinMode: GroupJoinMode
): Promise<void> {
    const { arena, setBusy, setError, setCode } = input;
    const session = rallar.session();
    setBusy(true);
    setError(undefined);
    setCode(undefined);
    try {
        const snapshot = await arena.createArenaRoom(joinMode);
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
    input: ArenaPrivateRoomActionsInput
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

async function copyRoomLink(link: string, setStatus: (status: string) => void): Promise<void> {
    try {
        await navigator.clipboard.writeText(link);
        setStatus('Room link copied.');
    }
    catch {
        setStatus('Copy is unavailable. Select and copy the room link above.');
    }
}

function ArenaRoomInvitations({ snapshot }: Pick<ArenaRoomSharingProps, 'snapshot'>) {
    const [people, setPeople] = useState<readonly RallarPerson[]>([]);
    const [principalId, setPrincipalId] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const refresh = () => refreshKnownArenaPeople(snapshot.group, setPeople, setError);
    const changeInvitation = (principalId: string, revoke: boolean) =>
        changeArenaInvitation({ room: snapshot.group, principalId, revoke, setBusy, setError });
    const invitations = snapshot.members.filter((member) => member.status === 'invited');
    return (
        <div className="stack">
            <p className="muted">Only invited accounts can enter using this link.</p>
            <button type="button" onClick={() => void refresh()}>Refresh known people</button>
            <label>
                Invite account reference<input
                    value={principalId}
                    onChange={(event) => setPrincipalId(event.target.value.trim())}
                    autoComplete="off"
                />
            </label>
            <p className="muted">
                Ask the guest for the account reference shown in their profile, or choose someone already known below.
            </p>
            <label>
                Invite account<select value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>
                    <option value="">Choose an account</option>
                    {people.filter((person) => person.principalId !== rallar.session()?.clientId).map((person) => (
                        <option key={person.principalId} value={person.principalId}>
                            {person.displayName || person.username} (@{person.username})
                        </option>
                    ))}
                </select>
            </label>
            <button
                type="button"
                disabled={!principalId || busy}
                onClick={() => void changeInvitation(principalId, false)}
            >
                Invite account
            </button>
            <ArenaInvitationList
                invitations={invitations}
                people={people}
                busy={busy}
                revoke={(principalId) => changeInvitation(principalId, true)}
            />
            {error && <p role="alert">{error}</p>}
        </div>
    );
}

interface ArenaInvitationListProps {
    readonly invitations: GroupSnapshot['members'];
    readonly people: readonly RallarPerson[];
    readonly busy: boolean;
    readonly revoke: (principalId: string) => Promise<void>;
}

function ArenaInvitationList({ invitations, people, busy, revoke }: ArenaInvitationListProps) {
    return (
        <>
            {invitations.map((invitation) => (
                <div key={invitation.principalId}>
                    <p>
                        {people.find((person) => person.principalId === invitation.principalId)?.username ??
                            invitation.principalId} — invited
                        {invitation.invitationExpiresAtEpochMs !== null &&
                            ` until ${new Date(invitation.invitationExpiresAtEpochMs).toLocaleString()}`}
                    </p>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void revoke(invitation.principalId)}
                    >
                        Revoke invitation
                    </button>
                </div>
            ))}
        </>
    );
}

async function refreshKnownArenaPeople(
    room: GroupRef,
    setPeople: (people: readonly RallarPerson[]) => void,
    setError: (error: string | undefined) => void
): Promise<void> {
    const session = rallar.session();
    setError(undefined);
    try {
        const state = await rallar.people.refresh({ scope: room });
        if (isCurrentArenaHost(session, room)) {
            setPeople(state.people);
        }
    }
    catch {
        setError('Could not refresh known people. Try again.');
    }
}

async function changeArenaInvitation(
    invitation: ArenaInvitationChange
): Promise<void> {
    const { room, principalId, revoke, setBusy, setError } = invitation;
    setBusy(true);
    setError(undefined);
    try {
        if (revoke) {
            await rallar.rooms.revokeInvite(room, principalId);
        }
        else {
            await rallar.rooms.invite(room, principalId);
        }
    }
    catch {
        setError('Could not update the invitation. Check the account reference and try again.');
    }
    finally {
        setBusy(false);
    }
}
