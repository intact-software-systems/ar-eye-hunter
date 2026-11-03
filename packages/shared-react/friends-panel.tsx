import type { RallarFriends } from '@shared-web/browser/friends/rallar-friends.ts';
import type { RallarScheduledSessions } from '@shared-web/browser/rooms/sessions/rallar-scheduled-sessions.ts';
import type { FriendsRequest } from '@shared/api/friends/friends-request.ts';
import type { FriendPerson, FriendsView } from '@shared/api/friends/friends-view.ts';
import type { FriendInvitation } from '@shared/api/friends/friendship.ts';
import type { GroupSessionPreview } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { useEffect, useState, type FormEvent } from 'react';

export interface FriendsPanelProps {
    readonly owner: RallarFriends;
    readonly sessions: Pick<RallarScheduledSessions, 'getState' | 'onChange'>;
    readonly enabled: boolean;
    readonly roomRef: GroupRef | null;
    readonly scope: StateScope;
}

interface InvitationDestination {
    readonly key: string;
    readonly label: string;
    readonly kind: FriendInvitation['kind'];
    readonly roomRef: GroupRef;
}

export function FriendsPanel({ owner, sessions, enabled, roomRef, scope }: FriendsPanelProps) {
    const [state, setState] = useState(owner.getState());
    useEffect(() => owner.onChange(setState), [owner]);
    useEffect(() => {
        if (enabled) {
            void owner.start();
        }
        return () => owner.stop();
    }, [owner, enabled]);
    const disabled = !enabled || state.busy || state.retryPending;
    return (
        <section className="panel stack" aria-label="Friends and invitations">
            <details>
                <summary>Friends and invitations</summary>
                <p>
                    Your friend list works across games. Online sharing is optional; room locations are shared only by
                    invitation.
                </p>
                <FriendRequestForm owner={owner} disabled={disabled} />
                {state.view && <FriendsVisibility owner={owner} view={state.view} disabled={disabled} />}
                {state.view && (
                    <FriendsDirectory
                        owner={owner}
                        sessions={sessions}
                        roomRef={roomRef}
                        scope={scope}
                        view={state.view}
                        disabled={disabled}
                    />
                )}
                {state.busy && <p role="status">Updating friends…</p>}
                {state.error && <p role="alert">{state.error}</p>}
                {state.retryPending && (
                    <button
                        type="button"
                        disabled={!enabled || state.busy}
                        onClick={() => void owner.retry()}
                    >
                        Retry friends request
                    </button>
                )}
                <button type="button" disabled={!enabled || state.busy} onClick={() => void owner.refresh()}>
                    Refresh friends
                </button>
            </details>
        </section>
    );
}

interface FriendsDirectoryProps extends Pick<FriendsPanelProps, 'owner' | 'sessions' | 'roomRef' | 'scope'> {
    readonly view: FriendsView;
    readonly disabled: boolean;
}

function FriendsDirectory({ owner, sessions, roomRef, scope, view, disabled }: FriendsDirectoryProps) {
    const [scheduled, setScheduled] = useState(sessions.getState());
    const [selected, setSelected] = useState('current');
    useEffect(() => sessions.onChange(setScheduled), [sessions]);
    const destinations = toInvitationDestinations(roomRef, scheduled.sessions);
    const destination = destinations.find((candidate) => candidate.key === selected) ?? null;
    return (
        <>
            <label>
                Invitation destination
                <select
                    aria-label="Invitation destination"
                    value={selected}
                    disabled={disabled}
                    onChange={(event) => setSelected(event.target.value)}
                >
                    <option value="">Choose a room or scheduled session</option>
                    {destinations.map((candidate) => (
                        <option key={candidate.key} value={candidate.key}>{candidate.label}</option>
                    ))}
                </select>
            </label>
            {view.contacts.map((person) => (
                <FriendCard
                    key={person.principalId}
                    person={person}
                    owner={owner}
                    disabled={disabled}
                    destination={destination}
                />
            ))}
            {view.contacts.length === 0 && <p>No friends or pending requests yet.</p>}
            {view.invitations.filter((invite) =>
                invite.roomRef.applicationId === scope.applicationId &&
                invite.roomRef.workspaceId === scope.workspaceId
            )
                .map((invitation) => (
                    <InvitationCard
                        key={invitation.invitationId}
                        invitation={invitation}
                        view={view}
                        owner={owner}
                        disabled={disabled}
                    />
                ))}
        </>
    );
}

function toInvitationDestinations(
    roomRef: GroupRef | null,
    sessions: readonly GroupSessionPreview[]
): InvitationDestination[] {
    const destinations: InvitationDestination[] = roomRef === null
        ? []
        : [{ key: 'current', label: 'Current room', kind: 'room', roomRef }];
    for (const session of sessions) {
        if (
            session.schedule.cancelledAtEpochMs === null &&
            (session.isOrganizer || session.participation === 'admitted')
        ) {
            destinations.push({
                key: `session:${session.roomRef.groupId}`,
                label: `Session: ${session.displayName}`,
                kind: 'scheduled-session',
                roomRef: session.roomRef
            });
        }
    }
    return destinations;
}

interface FriendRequestFormProps {
    readonly owner: RallarFriends;
    readonly disabled: boolean;
}

function FriendRequestForm({ owner, disabled }: FriendRequestFormProps) {
    const [username, setUsername] = useState('');
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (username.trim()) {
            void owner.act({ action: 'request', username: username.trim() });
        }
    };
    return (
        <form className="stack" onSubmit={submit}>
            <label>
                Friend username<input
                    value={username}
                    maxLength={128}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="off"
                />
            </label>
            <button type="submit" disabled={disabled || !username.trim()}>Send friend request</button>
        </form>
    );
}

interface FriendsVisibilityProps extends FriendRequestFormProps {
    readonly view: FriendsView;
}

function FriendsVisibility({ owner, view, disabled }: FriendsVisibilityProps) {
    return (
        <label>
            <input
                type="checkbox"
                checked={view.shareOnline}
                disabled={disabled}
                onChange={(event) => void owner.act({ action: 'visibility', shareOnline: event.target.checked })}
            />Share when I am online with friends
        </label>
    );
}

interface FriendCardProps extends FriendRequestFormProps {
    readonly person: FriendPerson;
    readonly destination: InvitationDestination | null;
}

function FriendCard({ person, owner, disabled, destination }: FriendCardProps) {
    const act = (action: Exclude<FriendsRequest['action'], 'request' | 'visibility' | 'invite' | 'dismiss'>) =>
        void owner.act({ action, principalId: person.principalId });
    return (
        <article className="stack" aria-label={`Friend ${person.username}`}>
            <strong>{person.displayName} (@{person.username})</strong>
            <p>{friendStatus(person)}</p>
            <div className="button-grid">
                {person.status === 'incoming' && (
                    <>
                        <button type="button" disabled={disabled} onClick={() => act('accept')}>Accept request</button>
                        <button type="button" disabled={disabled} onClick={() => act('decline')}>
                            Decline request
                        </button>
                    </>
                )}
                {person.status === 'outgoing' && (
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => act('cancel')}
                    >
                        Cancel request
                    </button>
                )}
                {person.status === 'friend' && (
                    <>
                        <InviteFriendButton
                            person={person}
                            owner={owner}
                            disabled={disabled}
                            destination={destination}
                        />
                        <button type="button" disabled={disabled} onClick={() => act('remove')}>Remove friend</button>
                    </>
                )}
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => act(person.status === 'blocked' ? 'unblock' : 'block')}
                >
                    {person.status === 'blocked' ? 'Unblock' : 'Block'}
                </button>
            </div>
        </article>
    );
}

function InviteFriendButton({ person, owner, disabled, destination }: FriendCardProps) {
    return (
        <button
            type="button"
            disabled={disabled || destination === null}
            onClick={() => {
                if (destination) {
                    void owner.act({
                        action: 'invite',
                        principalId: person.principalId,
                        kind: destination.kind,
                        roomRef: destination.roomRef
                    });
                }
            }}
        >
            Invite to destination
        </button>
    );
}

function friendStatus(person: FriendPerson): string {
    if (person.status === 'incoming') {
        return 'Wants to be your friend';
    }
    if (person.status === 'outgoing') {
        return 'Friend request sent';
    }
    if (person.status === 'blocked') {
        return 'Blocked. Unblocking will not restore friendship.';
    }
    return person.presence === 'online'
        ? 'Online in this game'
        : person.presence === 'away'
        ? 'Away from this game'
        : 'Online status private';
}

interface InvitationCardProps extends FriendsVisibilityProps {
    readonly invitation: FriendInvitation;
}

function InvitationCard({ invitation, view, owner, disabled }: InvitationCardProps) {
    const sender = view.contacts.find((person) => person.principalId === invitation.senderPrincipalId);
    return (
        <article className="stack" aria-label={`Invitation from ${sender?.username ?? invitation.senderPrincipalId}`}>
            <strong>
                {sender?.displayName ?? invitation.senderPrincipalId} invited you to{' '}
                {invitation.kind === 'room' ? 'a room' : 'a scheduled session'}
            </strong>
            <p>Normal admission rules apply. Opening an invitation does not reserve a seat.</p>
            <button
                type="button"
                disabled={disabled}
                onClick={() =>
                    void owner.openInvitation(invitation.invitationId)}
            >
                {invitation.kind === 'room' ? 'Join invited room' : 'View invited session'}
            </button>
            <button
                type="button"
                disabled={disabled}
                onClick={() =>
                    void owner.act({ action: 'dismiss', invitationId: invitation.invitationId })}
            >
                Dismiss invitation
            </button>
        </article>
    );
}
