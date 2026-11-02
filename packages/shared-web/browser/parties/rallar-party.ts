import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import {
    decodePartyMutationResult,
    type PartyMutationResult,
    type PartyRequest
} from '@shared/api/parties/party-request.ts';
import { decodePartyView, type PartyView } from '@shared/api/parties/party-view.ts';
import type { PartyRefusal, PartyRosterIntent } from '@shared/api/parties/party.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { AuthenticatedResource } from '../api/authenticated-resource.ts';
import { BrowserActivity } from '../browser-activity.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
import { partyHttpApi } from './party-http-api.ts';

const REFUSAL_MESSAGES: Readonly<Record<PartyRefusal, string>> = {
    unauthorized: 'Sign in again to update your party.',
    'already-in-party': 'You already belong to a party in this game. Leave it before joining another.',
    'party-unavailable': 'This party is no longer available.',
    'party-changed': 'Your party changed. Review its roster before trying again.',
    'party-full': 'This party has no remaining seats.',
    'invitation-capacity': 'The party invitation limit has been reached. Revoke an invitation before sending another.',
    'invitation-unavailable': 'This invitation is no longer available.',
    'person-unavailable': 'Only mutual friends can invite each other to a party.',
    'member-required': 'Join this party before changing it.',
    'leader-required': 'Only the party leader can do that.',
    'leader-present': 'The current party leader is still present.',
    'member-away': 'Be present in this game before joining or leading a party.'
};

export namespace RallarParty {
    export interface Api {
        read(input: AuthenticatedResource.ReadInput): Promise<PartyView>;
        change(input: AuthenticatedResource.ChangeInput<PartyRequest>): Promise<PartyMutationResult>;
    }
    export interface Dependencies extends AuthenticatedResource.Dependencies {
        readonly api: Api;
    }
}

/** Durable party consent is independent of room membership and game authority. */
export class RallarParty extends AuthenticatedResource<PartyView, PartyRequest> {
    private readonly scope: StateScope;
    private readonly createId: () => string;

    static createBrowser(
        browser: Pick<RallarRoomEntry.Browser, 'auth' | 'session'>,
        config: AuthenticatedResource.Config
    ): RallarParty {
        return new RallarParty({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            api: partyHttpApi,
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    constructor(dependencies: RallarParty.Dependencies, config: AuthenticatedResource.Config) {
        super(dependencies, config, {
            async read(attempt) {
                const view = decodePartyView(await dependencies.api.read(attempt));
                if (!isSameGroupScope(view.scope, attempt.scope) || view.principalId !== attempt.session.clientId) {
                    throw new TypeError('Party response belongs to another account or scope');
                }
                return view;
            },
            async change(attempt) {
                const result = decodePartyMutationResult(await dependencies.api.change(attempt));
                if (
                    !isSameGroupScope(result.ref, attempt.scope) ||
                    result.ref.partyId !== attempt.request.ref.partyId ||
                    result.principalId !== attempt.session.clientId || result.requestId !== attempt.requestId
                ) {
                    throw new TypeError('Party result belongs to another command');
                }
                return result.code === null ? null : REFUSAL_MESSAGES[result.code];
            }
        });
        this.scope = config.scope;
        this.createId = dependencies.createId;
    }

    create(): Promise<void> {
        const view = this.getState().view;
        return view === null || view.party !== null ? Promise.resolve() : this.act({
            ref: { ...this.scope, partyId: this.createId() },
            expectedRosterRevision: null,
            intent: { action: 'create' }
        });
    }

    invite(principalId: string): Promise<void> {
        return this.changeRoster({ action: 'invite', principalId, invitationId: this.createId() });
    }

    changeRoster(intent: Exclude<PartyRosterIntent, { action: 'create' | 'accept' | 'decline'; }>): Promise<void> {
        const party = this.getState().view?.party;
        return !party
            ? Promise.resolve()
            : this.act({ ref: party.ref, expectedRosterRevision: party.rosterRevision, intent });
    }

    respond(invitationId: string, action: 'accept' | 'decline'): Promise<void> {
        const invitation = this.getState().view?.invitations.find((candidate) =>
            candidate.invitationId === invitationId
        );
        return invitation === undefined ? Promise.resolve() : this.act({
            ref: invitation.ref,
            expectedRosterRevision: null,
            intent: { action, invitationId }
        });
    }
}
