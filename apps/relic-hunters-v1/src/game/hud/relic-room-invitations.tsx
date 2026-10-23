import { rallar } from '@shared-web/browser/rallar.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { useState } from 'react';

interface RelicRoomInvitationsProps {
    readonly snapshot: GroupSnapshot;
}

export function RelicRoomInvitations({ snapshot }: RelicRoomInvitationsProps) {
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
