import { rallar, type RallarPerson } from '@shared-web/browser/rallar.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { useState } from 'react';

interface ArenaInvitationChange {
    readonly room: GroupRef;
    readonly principalId: string;
    readonly revoke: boolean;
    readonly setBusy: (busy: boolean) => void;
    readonly setError: (error: string | undefined) => void;
}

interface ArenaRoomInvitationsProps {
    readonly snapshot: GroupSnapshot;
}

export function ArenaRoomInvitations({ snapshot }: ArenaRoomInvitationsProps) {
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
    setError(undefined);
    try {
        const state = await rallar.people.refresh({ scope: room });
        setPeople(state.people);
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
