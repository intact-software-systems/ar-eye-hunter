import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type {
    MatchmakingMutationResult,
    MatchmakingRefusal,
    MatchmakingRequest
} from '@shared/api/matchmaking/matchmaking-request.ts';
import { decodeMatchmakingSnapshot, type MatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import type { PartyRosterView } from '@shared/api/parties/party-view.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { AuthenticatedResource } from '../api/authenticated-resource.ts';
import { subscribeViewInvalidations } from '../api/subscribe-view-invalidations.ts';
import type { SubscribeViewRecovery } from '../api/subscribe-view-recovery.ts';
import { BrowserActivity } from '../browser-activity.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
import { matchmakingHttpApi } from './matchmaking-http-api.ts';

const REFUSAL_MESSAGES: Readonly<Record<MatchmakingRefusal, string>> = {
    unauthorized: 'Sign in again to find players.',
    'search-not-current': 'Your search changed. Review its current state before continuing.',
    'party-required': 'Search with your party, or leave it to search alone.',
    'party-changed': 'Your party changed. Review its roster before searching again.',
    'party-leader-required': 'Only the party leader can start a group search.',
    'party-member-away': 'Everyone in your party must be present before searching.',
    'search-capacity': 'Matchmaking is busy. Please try a new search shortly.',
    'search-ended': 'This search has ended. Start a new search to find players.'
};

export namespace RallarMatchmaking {
    export interface Config {
        readonly scope: StateScope;
    }
    export interface Api {
        read(input: AuthenticatedResource.ReadInput): Promise<MatchmakingSnapshot>;
        change(input: AuthenticatedResource.ChangeInput<MatchmakingRequest>): Promise<MatchmakingMutationResult>;
    }
    export interface Dependencies extends AuthenticatedResource.Dependencies {
        readonly api: Api;
        onChanged(listener: () => Promise<void>): () => void;
        readonly entry: Pick<RallarRoomEntry, 'enter'>;
    }
}

/** Owns search consent and recovery; RoomEntry and each game retain entry and gameplay authority. */
export class RallarMatchmaking extends AuthenticatedResource<MatchmakingSnapshot, MatchmakingRequest> {
    private readonly entry: Pick<RallarRoomEntry, 'enter'>;
    private readonly createId: () => string;

    static createBrowser(
        browser: SubscribeViewRecovery.Browser & Pick<RallarRoomEntry.Browser, 'auth'>,
        entry: RallarRoomEntry,
        config: RallarMatchmaking.Config
    ): RallarMatchmaking {
        return new RallarMatchmaking({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            onChanged: (changed) =>
                subscribeViewInvalidations({ browser, scope: config.scope, resource: 'matchmaking', changed }),
            api: matchmakingHttpApi,
            entry,
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    constructor(dependencies: RallarMatchmaking.Dependencies, config: RallarMatchmaking.Config) {
        super(dependencies, { scope: config.scope, subscribeRefresh: dependencies.onChanged }, {
            async read(attempt) {
                const snapshot = decodeMatchmakingSnapshot(await dependencies.api.read(attempt));
                assertMatchmakingAccountScope(snapshot, attempt);
                return snapshot;
            },
            async change(attempt) {
                const result = await dependencies.api.change(attempt);
                assertMatchmakingAccountScope(result, attempt);
                if (result.requestId !== attempt.requestId) {
                    throw new TypeError('Matchmaking result belongs to another request');
                }
                return result.code === null ? null : REFUSAL_MESSAGES[result.code];
            }
        });
        this.entry = dependencies.entry;
        this.createId = dependencies.createId;
    }

    find(party?: Pick<PartyRosterView, 'ref' | 'rosterRevision'>): Promise<void> {
        const state = this.getState().view?.state;
        if (state === undefined || state.status === 'searching' || state.status === 'confirming') {
            return Promise.resolve();
        }
        const searchId = this.createId();
        return this.act(
            party === undefined
                ? { action: 'start', searchId }
                : { action: 'start-party', searchId, partyId: party.ref.partyId, rosterRevision: party.rosterRevision }
        );
    }

    confirm(): Promise<void> {
        const state = this.getState().view?.state;
        return state?.status === 'confirming'
            ? this.act({ action: 'confirm', searchId: state.searchId })
            : Promise.resolve();
    }

    cancel(): Promise<void> {
        const state = this.getState().view?.state;
        return state?.status === 'searching' || state?.status === 'confirming'
            ? this.act({ action: 'cancel', searchId: state.searchId })
            : Promise.resolve();
    }

    async enter(): Promise<void> {
        const attempt = this.beginOperation();
        if (attempt === null) {
            return;
        }
        try {
            await this.refresh();
            const state = this.getState().view?.state;
            if (this.current(attempt) && state?.status === 'matched') {
                this.entry.enter({ intent: 'join', roomRef: state.roomRef, joinCode: null, participation: 'player' });
            }
        }
        catch (error) {
            if (this.current(attempt)) {
                this.setError(toError(error).message);
            }
        }
        finally {
            this.finishOperation(attempt);
        }
    }
}

function assertMatchmakingAccountScope(
    value: Pick<MatchmakingSnapshot, 'scope' | 'principalId'>,
    attempt: AuthenticatedResource.ReadInput
): void {
    if (!isSameGroupScope(value.scope, attempt.scope) || value.principalId !== attempt.session.clientId) {
        throw new TypeError('Matchmaking response belongs to another account or scope');
    }
}
