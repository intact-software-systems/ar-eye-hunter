import { useState } from 'react';

import { rallar } from '@shared-web/browser/rallar.ts';
import { toRoomEntryUrl } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { toGroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';

import { RelicRoomInvitations } from './relic-room-invitations.tsx';

export function isCurrentRelicRoom(session: AuthSession | undefined, room: GroupRef | undefined): boolean {
    const current = rallar.session();
    const currentRoom = rallar.rooms.state().currentRoomRef;
    if (!session || current?.sessionId !== session.sessionId || current.clientId !== session.clientId) {
        return false;
    }
    return room === undefined
        ? currentRoom === undefined
        : currentRoom !== undefined && isSameGroupRef(currentRoom, room);
}

interface RelicRoomSharingProps {
    readonly snapshot: GroupSnapshot;
    readonly code: GroupJoinCodeResponse | undefined;
    readonly busy: boolean;
    readonly rotate: () => Promise<void>;
}

export function RelicRoomSharing({ snapshot, code, busy, rotate }: RelicRoomSharingProps) {
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
