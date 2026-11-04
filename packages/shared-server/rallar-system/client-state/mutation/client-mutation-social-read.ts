import type { RuntimeStateReadBatchLiveSelection } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type { RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { FriendsProfileRead } from '../../friends/friends-mutation-contracts.ts';
import { isFriendOnline } from '../../friends/friends-presence-publication.ts';
import { FRIENDS_PROFILE_NAMESPACE, friendsProfileKey } from '../../friends/friends-profile.ts';
import { decodeFriendsProfileRead } from '../../friends/friends-repository.ts';
import { PARTY_ACCOUNTS_NAMESPACE, partyAccountKey } from '../../parties/persistence/party-account.ts';
import { decodePartyAccountEntry, type PartyRepository } from '../../parties/persistence/party-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { ClientMutationCommand, ClientMutationRead } from './client-mutation-contracts.ts';

export interface ClientMutationSocialRead {
    readonly partyAccount: PartyRepository.AccountRead | null;
    readonly friendsProfile: FriendsProfileRead | null;
}

export interface DecodeClientMutationSocialReadInput {
    readonly command: ClientMutationCommand;
    readonly state: Pick<ClientMutationRead, 'idempotency' | 'principal' | 'snapshot'>;
    readonly selections: readonly RuntimeStateReadBatchLiveSelection<JsonWireValue>[];
    readonly audienceObservedAtEpochMs: number;
}

/** Own social predecessors share the client snapshot; only dependent party/peer reads happen afterward. */
export function clientMutationSocialSelectors(
    command: ClientMutationCommand
): readonly RuntimeStateReadBatchSelector[] {
    const ref = command.aggregateRef;
    return [
        {
            selectorId: 'party-account',
            kind: 'key',
            namespace: PARTY_ACCOUNTS_NAMESPACE,
            key: partyAccountKey(ref, ref.principalId)
        },
        {
            selectorId: 'friends-profile',
            kind: 'key',
            namespace: FRIENDS_PROFILE_NAMESPACE,
            key: friendsProfileKey(ref.principalId)
        }
    ];
}

export function decodeClientMutationSocialRead(input: DecodeClientMutationSocialReadInput): ClientMutationSocialRead {
    const { command, state, selections, audienceObservedAtEpochMs } = input;
    if (state.idempotency !== null || command.operation === 'upsertInstance') {
        return { partyAccount: null, friendsProfile: null };
    }
    if (
        selections.length !== 2 || selections[0].selectorId !== 'party-account' ||
        selections[1].selectorId !== 'friends-profile'
    ) {
        throw new TypeError('Client social companions differ from their requested point selectors');
    }
    const [party, friends] = selections;
    const needsFriends = command.operation !== 'heartbeatSession' ||
        !isFriendOnline(state.snapshot, audienceObservedAtEpochMs);
    // Durable social rows must never expire: a physically expired observation is corruption, not absence.
    return {
        partyAccount: needsPartyMemberRead(command, state, audienceObservedAtEpochMs)
            ? decodePartyAccountEntry(
                party.entries[0]?.entry ?? party.expiredEntries[0],
                command.aggregateRef,
                command.aggregateRef.principalId
            )
            : null,
        friendsProfile: needsFriends
            ? decodeFriendsProfileRead(
                command.aggregateRef.principalId,
                friends.entries[0]?.entry ?? friends.expiredEntries[0]
            )
            : null
    };
}

function needsPartyMemberRead(
    command: ClientMutationCommand,
    state: DecodeClientMutationSocialReadInput['state'],
    observedAtEpochMs: number
): boolean {
    if (state.idempotency !== null || command.operation === 'upsertInstance') {
        return false;
    }
    if (command.operation !== 'heartbeatSession') {
        return true;
    }
    return state.principal?.value.status === 'active' &&
        !state.snapshot?.activeSessions.some((session) =>
            session.status === 'active' && session.disconnectedAtEpochMs === null &&
            session.expiresAtEpochMs > observedAtEpochMs
        );
}
