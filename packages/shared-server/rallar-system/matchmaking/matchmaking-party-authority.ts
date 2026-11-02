import type { MatchmakingRefusal } from '@shared/api/matchmaking/matchmaking-request.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import type { ClientPrincipalSnapshotRead } from '../client-state/persistence/client-state-persistence-contracts.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import { CLIENT_STATE_PRINCIPALS_NAMESPACE } from '../client-state/persistence/client-state-runtime-namespaces.ts';
import { PARTY_RECORDS_NAMESPACE } from '../parties/persistence/party-account.ts';
import type { PartyRepository } from '../parties/persistence/party-repository.ts';
import type { MatchmakingCommand } from './matchmaking-command.ts';
import type { MatchmakingPartyStart } from './matchmaking-party-search.ts';
import type { MatchmakingRepository } from './matchmaking-repository.ts';

export interface MatchmakingPartyAuthority {
    readonly parties: readonly PartyRepository.Read[];
    readonly presence: readonly ClientPrincipalSnapshotRead[];
    readonly sessions: readonly RuntimeStateEntryValue<PersistedAuthSession>[];
}

export interface MatchmakingPartyAuthorityInput {
    readonly command: MatchmakingCommand;
    readonly pool: MatchmakingRepository.Read;
    readonly requestedParty: PartyRepository.Read | null;
    readonly parties: PartyRepository;
    readonly clients: Pick<ClientStateRepository, 'readPrincipalSnapshot'>;
    readonly authSessions: Pick<AuthSessionPersistence, 'findSessionBySessionIdEntry'>;
}

export async function readMatchmakingPartyAuthority(
    input: MatchmakingPartyAuthorityInput
): Promise<MatchmakingPartyAuthority> {
    const { command, pool } = input;
    const actorParty = pool.partyAccounts[command.principalId]?.account.partyId ?? null;
    const proposal = pool.pool.proposals.find((proposal) =>
        proposal.participants.some((player) =>
            player.principalId === command.principalId && player.searchId === command.request.searchId
        )
    );
    const proposalSearches = new Set(proposal?.participants.map((player) => player.searchId) ?? []);
    const refs = command.request.action === 'start-party'
        ? actorParty === command.request.partyId ? [{ ...command.scope, partyId: actorParty }] : []
        : pool.partySearches.filter((party) => party.searchIds.some((id) => proposalSearches.has(id))).map((party) =>
            party.ref
        );
    const parties = await Promise.all(refs.map((ref) =>
        input.requestedParty?.ref.partyId === ref.partyId
            ? input.requestedParty
            : input.parties.read(ref)
    ));
    const start = command.request.action === 'start-party' ? parties[0]?.record : null;
    const presenceReads = start?.leaderPrincipalId === command.principalId
        ? await Promise.all(
            start.members.map((member) =>
                input.clients.readPrincipalSnapshot({ ...command.scope, principalId: member.principalId })
            )
        )
        : [];
    const presence = presenceReads.filter((read): read is ClientPrincipalSnapshotRead => read !== undefined);
    const sessionIds = [
        ...new Set(presence.flatMap((read) => read.snapshot.activeSessions.map((session) => session.sessionId)))
    ];
    const sessions = await Promise.all(
        sessionIds.map((sessionId) => input.authSessions.findSessionBySessionIdEntry(sessionId))
    );
    return {
        parties,
        presence,
        sessions: sessions.filter((read): read is RuntimeStateEntryValue<PersistedAuthSession> => read !== undefined)
    };
}

export interface MatchmakingPartyStartInput {
    readonly command: MatchmakingCommand;
    readonly pool: MatchmakingRepository.Read;
    readonly authority: MatchmakingPartyAuthority;
    readonly nowEpochMs: number;
}

export function computeMatchmakingPartyStart(
    input: MatchmakingPartyStartInput
): Either<MatchmakingRefusal, MatchmakingPartyStart> {
    const { command, authority, pool, nowEpochMs } = input;
    if (command.request.action !== 'start-party') {
        throw new TypeError('Party matchmaking start requires a party request');
    }
    const request = command.request;
    const party = authority.parties.find((read) => read.ref.partyId === request.partyId)?.record;
    if (
        pool.partyAccounts[command.principalId]?.account.partyId !== command.request.partyId ||
        party?.status !== 'active' || party.rosterRevision !== command.request.rosterRevision ||
        !party.members.some((member) => member.principalId === command.principalId)
    ) {
        return Either.ofLeft('party-changed');
    }
    if (party.leaderPrincipalId !== command.principalId) {
        return Either.ofLeft('party-leader-required');
    }
    const members = [];
    for (const member of party.members) {
        const present = authority.presence.find((read) => read.snapshot.principal.principalId === member.principalId)
            ?.snapshot;
        const liveSessionIds = new Set(
            present?.principal.status === 'active'
                ? present.activeSessions.filter((session) =>
                    session.status === 'active' && session.disconnectedAtEpochMs === null &&
                    session.expiresAtEpochMs > nowEpochMs
                ).map((session) => session.sessionId)
                : []
        );
        const sessions = authority.sessions.filter((stored) =>
            stored.value.clientId === member.principalId &&
            stored.value.expiresAtEpochMs > nowEpochMs && liveSessionIds.has(stored.value.sessionId)
        ).toSorted((left, right) =>
            left.value.sessionId < right.value.sessionId ? -1 : left.value.sessionId > right.value.sessionId ? 1 : 0
        );
        const session = sessions.find((stored) => stored.value.sessionId === command.sessionId)?.value ??
            sessions[0]?.value;
        if (session === undefined) {
            return Either.ofLeft('party-member-away');
        }
        members.push({
            principalId: member.principalId,
            sessionId: session.sessionId,
            sessionIssuedAtEpochMs: session.issuedAtEpochMs,
            sessionExpiresAtEpochMs: session.expiresAtEpochMs
        });
    }
    return Either.ofRight({
        ref: party.ref,
        rosterRevision: party.rosterRevision,
        leaderPrincipalId: party.leaderPrincipalId,
        members
    });
}

export function areMatchmakingPartiesCurrent(input: MatchmakingPartyStartInput): boolean {
    const searches = [
        ...input.pool.pool.searching,
        ...input.pool.pool.proposals.flatMap((proposal) => proposal.participants)
    ];
    return input.authority.parties.every((read) => {
        const binding = input.pool.partySearches.find((party) => party.ref.partyId === read.ref.partyId);
        if (binding === undefined) {
            return input.command.request.action === 'start-party';
        }
        const party = read.record;
        const members = searches.filter((search) => binding.searchIds.includes(search.searchId)).map((search) =>
            search.principalId
        );
        return party?.status === 'active' && party.rosterRevision === binding.rosterRevision &&
            party.leaderPrincipalId === binding.leaderPrincipalId && party.members.length === members.length &&
            party.members.every((member) => members.includes(member.principalId));
    });
}

export function computeMatchmakingPartyGuards(
    authority: MatchmakingPartyAuthority
): readonly RuntimeStateGuardedBatchEffect[] {
    const guards: RuntimeStateGuardedBatchEffect[] = [];
    for (const read of authority.parties) {
        if (read.entry === null) {
            throw new TypeError('Accepted party search requires an observed party record');
        }
        guards.push({
            effectId: `party:${read.ref.partyId}`,
            namespace: PARTY_RECORDS_NAMESPACE,
            operation: 'update',
            key: read.entry.key,
            expectedRevision: read.entry.revision,
            value: read.entry.value,
            expireAtTimestamp: read.entry.expireAtTimestamp
        });
    }
    for (const read of authority.presence) {
        const entry = read.principal.entry;
        guards.push({
            effectId: `presence:${entry.key}`,
            namespace: CLIENT_STATE_PRINCIPALS_NAMESPACE,
            operation: 'update',
            key: entry.key,
            expectedRevision: entry.revision,
            value: entry.value,
            expireAtTimestamp: entry.expireAtTimestamp
        });
    }
    return guards;
}
