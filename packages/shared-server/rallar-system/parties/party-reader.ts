import { decodePartyView, type PartyView } from '@shared/api/parties/party-view.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import { isPartyMemberPresent } from './party-member-presence.ts';
import type { PartyRepository } from './persistence/party-repository.ts';

export namespace PartyReader {
    export interface Dependencies {
        readonly parties: PartyRepository;
        readonly clients: Pick<ClientStateRepository, 'readSnapshot'>;
        readonly nowEpochMs: () => number;
    }
    export interface Config {
        readonly defaultMaxMembers: number;
        readonly maxMembersByApplication: Readonly<Record<string, number>>;
    }
}

export class PartyReader {
    private readonly dependencies: PartyReader.Dependencies;
    private readonly config: PartyReader.Config;

    constructor(dependencies: PartyReader.Dependencies, config: PartyReader.Config) {
        this.dependencies = dependencies;
        this.config = config;
    }

    async read(scope: StateScope, principalId: string): Promise<PartyView> {
        const current = await this.dependencies.parties.readCurrent(scope, principalId);
        const party = current.party;
        const snapshots = await Promise.all(
            (party?.members ?? []).map((member) =>
                this.dependencies.clients.readSnapshot({ ...scope, principalId: member.principalId })
            )
        );
        const observedAtEpochMs = Math.max(current.observedAtEpochMs, this.dependencies.nowEpochMs());
        const maxMembers = Object.hasOwn(this.config.maxMembersByApplication, scope.applicationId)
            ? this.config.maxMembersByApplication[scope.applicationId]!
            : this.config.defaultMaxMembers;
        return decodePartyView({
            scope,
            principalId,
            observedAtEpochMs,
            maxMembers,
            party: party === null ? null : {
                ref: party.ref,
                rosterRevision: party.rosterRevision,
                leaderPrincipalId: party.leaderPrincipalId!,
                members: party.members.map((member, index) => {
                    const snapshot = snapshots[index];
                    const present = isPartyMemberPresent(snapshot, observedAtEpochMs);
                    return {
                        ...member,
                        displayName: snapshot?.principal.displayName?.trim() || member.principalId,
                        presence: present ? 'present' : 'away'
                    };
                }),
                invitations: party.leaderPrincipalId === principalId
                    ? party.invitations.filter((invitation) => invitation.expiresAtEpochMs > observedAtEpochMs)
                    : []
            },
            invitations: current.invitedParties.flatMap((invited) =>
                invited.invitations.filter((invitation) =>
                    invitation.principalId === principalId && invitation.expiresAtEpochMs > observedAtEpochMs
                )
                    .map((invitation) => ({ ...invitation, ref: invited.ref }))
            )
        });
    }
}
