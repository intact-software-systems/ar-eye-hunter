import type { RallarFriends } from '@shared-web/browser/friends/rallar-friends.ts';
import type { RallarParty } from '@shared-web/browser/parties/rallar-party.ts';
import type { FriendsView } from '@shared/api/friends/friends-view.ts';
import type { PartyRosterView, PartyView } from '@shared/api/parties/party-view.ts';
import { useEffect, useState } from 'react';

export interface PartyPanelProps {
    readonly owner: RallarParty;
    readonly friends: RallarFriends;
}

export function PartyPanel({ owner, friends }: PartyPanelProps) {
    const [state, setState] = useState(owner.getState());
    const [contacts, setContacts] = useState(friends.getState());
    useEffect(() => owner.onChange(setState), [owner]);
    useEffect(() => friends.onChange(setContacts), [friends]);
    useEffect(() => {
        void owner.start();
        return () => owner.stop();
    }, [owner]);
    const disabled = state.busy || state.retryPending;
    const view = state.view;
    const party = view?.party;
    return (
        <section className="panel stack" aria-label="Party">
            <strong>Party</strong>
            <p>Stay together between games. Your party belongs to this game and workspace.</p>
            {!view && !state.error && <p role="status">Checking your party…</p>}
            {view && !party && (
                <button type="button" disabled={disabled} onClick={() => void owner.create()}>Create party</button>
            )}
            {view && party && <PartyRoster owner={owner} view={view} party={party} disabled={disabled} />}
            {view && party && party.leaderPrincipalId === view.principalId && (
                <PartyInvitations
                    owner={owner}
                    view={view}
                    party={party}
                    disabled={disabled}
                    contacts={contacts.view}
                />
            )}
            {view && <ReceivedPartyInvitations owner={owner} view={view} disabled={disabled} />}
            {state.busy && <p role="status">Updating your party…</p>}
            {state.error && <p role="alert">{state.error}</p>}
            {state.retryPending && (
                <button type="button" disabled={state.busy} onClick={() => void owner.retry()}>
                    Retry party request
                </button>
            )}
            <button type="button" disabled={state.busy} onClick={() => void owner.refresh()}>Refresh party</button>
        </section>
    );
}

interface PartyRosterProps {
    readonly owner: RallarParty;
    readonly view: PartyView;
    readonly party: PartyRosterView;
    readonly disabled: boolean;
}

function PartyRoster({ owner, view, party, disabled }: PartyRosterProps) {
    const leader = party.leaderPrincipalId === view.principalId;
    const leaderAway =
        party.members.find((member) => member.principalId === party.leaderPrincipalId)?.presence === 'away';
    return (
        <>
            <p role="status">{party.members.length} of {view.maxMembers} seats</p>
            <ul>
                {party.members.map((member) => (
                    <li key={member.principalId}>
                        {member.displayName} · {member.presence === 'present' ? 'Present' : 'Away'}
                        {member.principalId === party.leaderPrincipalId ? ' · Leader' : ''}
                        {leader && member.principalId !== view.principalId && (
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() =>
                                    void owner.changeRoster({ action: 'transfer', principalId: member.principalId })}
                            >
                                Make {member.displayName} party leader
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {!leader && leaderAway && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void owner.changeRoster({ action: 'take-leadership' })}
                >
                    Take party leadership
                </button>
            )}
            <p>Leaving the party keeps your room memberships and current game participation.</p>
            <button type="button" disabled={disabled} onClick={() => void owner.changeRoster({ action: 'leave' })}>
                Leave party
            </button>
            {leader && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void owner.changeRoster({ action: 'disband' })}
                >
                    Disband party
                </button>
            )}
        </>
    );
}

interface PartyInvitationsProps extends PartyRosterProps {
    readonly contacts: FriendsView | null;
}

function PartyInvitations({ owner, view, party, disabled, contacts }: PartyInvitationsProps) {
    const availableFriends =
        contacts?.contacts.filter((person) =>
            person.status === 'friend' && !party.members.some((member) => member.principalId === person.principalId) &&
            !party.invitations.some((invitation) => invitation.principalId === person.principalId)
        ) ?? [];
    return (
        <>
            <p>Invite mutual friends. They must accept before joining your party.</p>
            {availableFriends.map((person) => (
                <button
                    type="button"
                    key={person.principalId}
                    disabled={disabled || party.members.length >= view.maxMembers}
                    onClick={() => void owner.invite(person.principalId)}
                >
                    Invite {person.displayName || person.username} to party
                </button>
            ))}
            {availableFriends.length === 0 && <p>Add friends in Friends and invitations to invite them.</p>}
            {party.invitations.map((invitation) => (
                <article
                    key={invitation.invitationId}
                    aria-label={`Party invitation to ${invitation.principalId}`}
                >
                    <p>Invited {invitation.principalId}</p>
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                            void owner.changeRoster({
                                action: 'revoke',
                                invitationId: invitation.invitationId
                            })}
                    >
                        Revoke party invitation
                    </button>
                </article>
            ))}
        </>
    );
}

function ReceivedPartyInvitations({ owner, view, disabled }: Omit<PartyRosterProps, 'party'>) {
    return (
        <>
            {view.invitations.map((invitation) => (
                <article
                    key={invitation.ref.partyId}
                    aria-label={`Party invitation from ${invitation.senderPrincipalId}`}
                >
                    <p>{invitation.senderPrincipalId} invited you to their party.</p>
                    <button
                        type="button"
                        disabled={disabled || view.party !== null}
                        onClick={() => void owner.respond(invitation.ref, invitation.invitationId, 'accept')}
                    >
                        Accept party invitation
                    </button>
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => void owner.respond(invitation.ref, invitation.invitationId, 'decline')}
                    >
                        Decline party invitation
                    </button>
                    {view.party && <p>Leave your current party before accepting another invitation.</p>}
                </article>
            ))}
        </>
    );
}
