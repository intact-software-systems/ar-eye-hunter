import {
    computeGroupMoveExpiry,
    computeGroupMoveMutation,
    validateGroupMoveExpiry,
    validateGroupMoveMutation
} from '@shared-server/rallar-system/group-state/move/compute-group-move-mutation.ts';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { decodeGroupMoveDeadline } from '@shared-server/rallar-system/group-state/move/group-move-deadline.ts';
import { GroupMoveRepository } from '@shared-server/rallar-system/group-state/move/group-move-repository.ts';
import { GroupMoveService } from '@shared-server/rallar-system/group-state/move/group-move-service.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { partyAccountKey, partyRecordKey } from '@shared-server/rallar-system/parties/persistence/party-account.ts';
import type { PartyRecord } from '@shared-server/rallar-system/parties/persistence/party-record.ts';
import { PartyRepository } from '@shared-server/rallar-system/parties/persistence/party-repository.ts';
import { WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodePersistedALMessageRow } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupMoveParty } from '@shared/api/mutation/group-move.ts';
import type { GroupMove, GroupMoveAction } from '@shared/api/mutation/group-move.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createTestAuthSession } from '../group-state-test-runtime.ts';
import { createGroupMoveTestDatabase, DESTINATION, type GroupMoveTestDatabase } from './group-move-test-database.ts';

const TARGET = { ...DESTINATION, groupId: 'target' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0)) {
        await close();
    }
});

interface GroupMoveServiceFixture extends GroupMoveTestDatabase {
    readonly moves: GroupMoveRepository;
    readonly moveService: GroupMoveService;
    storeParty(members: readonly string[], rosterRevision?: number, leaderPrincipalId?: string): Promise<void>;
    act(action: GroupMoveAction, principalId?: string, party?: GroupMoveParty): Promise<GroupMove>;
    prepareMove(action: GroupMoveAction, principalId?: string, party?: GroupMoveParty): Promise<GroupMoveService.Computed>;
    ready(): Promise<void>;
    advance(duration: number): void;
}

async function database(): Promise<GroupMoveServiceFixture> {
    const fixture = await createGroupMoveTestDatabase();
    cleanups.push(fixture.storage.close);
    await seedMoveRooms(fixture);
    let nowEpochMs = fixture.nowEpochMs;
    const moves = new GroupMoveRepository(fixture.runtime, () => nowEpochMs);
    const service = new GroupMoveService({
        groups: fixture.repository,
        moves,
        parties: new PartyRepository(fixture.runtime, () => nowEpochMs),
        authSessions: new AuthSessionPersistence(fixture.runtime),
        mutations: fixture.service
    }, { serviceId: 'move-service-test', finishedRetentionMs: 86_400_000, now: () => nowEpochMs });
    async function prepare(action: GroupMoveAction, principalId = 'alice', party?: GroupMoveParty): Promise<GroupMoveService.Computed> {
        const session = createTestAuthSession(principalId);
        const command = service.authorize({
            requestId: `${action}-${principalId}`,
            moveId: 'move-1',
            source: DESTINATION,
            destination: TARGET,
            action,
            joinCode: null,
            inviteToken: null,
            ...(party === undefined ? {} : { party })
        }, session);
        const ingress = await service.capture(command, session);
        const read = await service.read(ingress, { attemptCount: 1, traceId: 'move-test' });
        const computed = computeGroupMoveMutation(read);
        expect(validateGroupMoveMutation(read, computed)).toEqual([]);
        return computed.fold((rejection) => {
            throw new Error(rejection.message);
        }, (value) => value);
    }
    async function act(action: GroupMoveAction, principalId = 'alice', party?: GroupMoveParty): Promise<GroupMove> {
        const computed = await prepare(action, principalId, party);
        await fixture.storage.sql.begin((transaction) => service.write(transaction, computed));
        return computed.result;
    }
    async function ready() {
        await act('propose');
        await act('confirm');
        await act('confirm', 'bob');
    }
    return {
        ...fixture,
        storeParty: (members: readonly string[], rosterRevision = 0, leaderPrincipalId = 'alice') =>
            storeParty({ fixture, members, rosterRevision, leaderPrincipalId }),
        moves,
        moveService: service,
        act,
        prepareMove: prepare,
        ready,
        advance: (duration: number) => {
            nowEpochMs += duration;
        }
    };
}

interface StorePartyInput {
    readonly fixture: GroupMoveTestDatabase;
    readonly members: readonly string[];
    readonly rosterRevision: number;
    readonly leaderPrincipalId: string;
}

async function storeParty(
    { fixture, members, rosterRevision, leaderPrincipalId }: StorePartyInput
): Promise<void> {
    const ref = { applicationId: DESTINATION.applicationId, workspaceId: DESTINATION.workspaceId, partyId: 'party-one' };
    const record: PartyRecord = {
        ref,
        status: 'active',
        leaderPrincipalId,
        rosterRevision,
        createdAtEpochMs: fixture.nowEpochMs,
        members: members.map((principalId) => ({ principalId, joinedAtEpochMs: fixture.nowEpochMs })),
        invitations: []
    };
    await fixture.runtime.upsert({
        namespace: 'parties:records',
        key: partyRecordKey(ref),
        value: JSON.stringify(record),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    });
    for (const principalId of members) {
        await fixture.runtime.upsert(
            {
                namespace: 'parties:accounts',
                key: partyAccountKey(ref, principalId),
                value: JSON.stringify({
                    scope: { applicationId: ref.applicationId, workspaceId: ref.workspaceId },
                    principalId,
                    partyId: ref.partyId,
                    invitations: []
                }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
    }
}

async function seedMoveRooms(fixture: GroupMoveTestDatabase): Promise<void> {
    const bob = computeGroupMutation(await fixture.join('bob'));
    if (bob.outcome !== 'write') {
        throw new Error('Expected Bob to join source');
    }
    await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, bob));
    await connectSourcePlayers(fixture);
    const target = await fixture.prepare(
        mutationDescriptor({
            operation: 'createGroup',
            scope: TARGET,
            groupId: TARGET.groupId,
            request: {
                requestId: 'create-target',
                groupId: TARGET.groupId,
                displayName: 'Target',
                kind: 'room',
                joinMode: 'open',
                maxMembers: 3,
                createdByPrincipalId: 'carol'
            }
        }),
        'carol'
    );
    const created = computeGroupMutation(target);
    if (created.outcome !== 'write') {
        throw new Error('Expected target');
    }
    await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, created));
}

async function connectSourcePlayers(fixture: GroupMoveTestDatabase): Promise<void> {
    for (const principalId of ['alice', 'bob']) {
        const prepared = await fixture.prepare(
            mutationDescriptor({
                operation: 'connectPresence',
                scope: DESTINATION,
                groupId: DESTINATION.groupId,
                sessionId: `${principalId}-session`,
                request: {
                    requestId: `connect-${principalId}`,
                    actorPrincipalId: principalId,
                    principalId,
                    generationId: `${principalId}-generation`,
                    publicationKey: null,
                    connectionGenerationId: `${principalId}-connection`,
                    connectedAtEpochMs: fixture.nowEpochMs,
                    lastHeartbeatAtEpochMs: fixture.nowEpochMs,
                    expiresAtEpochMs: fixture.nowEpochMs + 60_000
                }
            }),
            principalId
        );
        const connected = computeGroupMutation(prepared);
        if (connected.outcome !== 'write') {
            throw new Error('Expected connected source presence');
        }
        await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, connected));
    }
}

describe('group move service', () => {
    it('moves the complete selected party without taking an unrelated present room player', async () => {
        const fixture = await database();
        await fixture.storeParty(['alice']);
        const party = { partyId: 'party-one', rosterRevision: 0 };
        const proposal = await fixture.act('propose', 'alice', party);
        expect(proposal.participants.map((participant) => participant.principalId)).toEqual(['alice']);
        expect(proposal.party).toEqual(party);
        expect(await fixture.moves.listForPrincipal(DESTINATION, 'bob')).toEqual([]);
        await fixture.act('confirm', 'alice', party);
        const moved = await fixture.act('commit', 'alice', party);
        expect(moved.status).toBe('committed');
        expect((await fixture.repository.readSnapshot(TARGET))?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'carol']);
        expect((await fixture.repository.readSnapshot(DESTINATION))?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob']);
    });

    it('requires the current leader and complete co-located party, never a caller-selected subset', async () => {
        const fixture = await database();
        await fixture.storeParty(['alice', 'bob', 'carol']);
        const party = { partyId: 'party-one', rosterRevision: 0 };
        await expect(fixture.act('propose', 'alice', party)).rejects.toThrow(/every party member/i);
        await fixture.storeParty(['alice', 'bob']);
        await expect(fixture.act('propose', 'bob', party)).rejects.toThrow(/leader/i);
        await expect(fixture.act('propose', 'alice', { ...party, rosterRevision: 9 })).rejects.toThrow(/party.*changed/i);
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
    });

    it('fences a party roster change against already-computed admission and cancels on a fresh attempt', async () => {
        const fixture = await database();
        await fixture.storeParty(['alice', 'bob']);
        const party = { partyId: 'party-one', rosterRevision: 0 };
        await fixture.act('propose', 'alice', party);
        await fixture.act('confirm', 'alice', party);
        await fixture.act('confirm', 'bob', party);
        const commit = await fixture.prepareMove('commit', 'alice', party);
        await fixture.storeParty(['alice', 'bob'], 1, 'bob');
        await expect(fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, commit)))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
        expect(await fixture.act('commit', 'alice', party)).toMatchObject({ status: 'cancelled', reason: 'party-roster-changed' });
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
    });

    it('stores scoped participant wakeups and a durable proposal deadline in the same transaction', async () => {
        const fixture = await database();
        const computed = await fixture.prepareMove('propose');
        const messages = computed.outbox.map((write) => JSON.parse(write.entry.resource));
        const notices = messages.filter((message) => message.payload.typeId === 'view.invalidated');
        expect(notices.map((message) => JSON.parse(message.payload.resource).resource)).toEqual(['room-move', 'room-move']);
        expect(notices.map((message) => message.targets.principalRef.principalId).sort()).toEqual(['alice', 'bob']);
        const deadline = computed.outbox.find((write) => JSON.parse(write.entry.resource).payload.typeId === 'GROUP_MOVE_DEADLINE');
        expect(deadline?.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(computed.result.expiresAtEpochMs);
        await fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, computed));
        const rows = await fixture.storage.sql<{ count: string; }[]>`select count(*)::text as count from resource_inbox where ri_topic_id = 'view.invalidated'`;
        expect(Number(rows[0].count)).toBe(2);
    });

    it('resolves Move Together delivery to the current account sessions after commit, including a replacement session', async () => {
        const fixture = await database();
        const computed = await fixture.prepareMove('propose');
        const entry = computed.outbox.find((write) => decodePersistedALMessageRow(write.entry).targets?.mode === 'broadcast')!.entry;
        const message = decodePersistedALMessageRow(entry);
        await fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, computed));
        const reader = new WsOutboxProvenanceReader({
            repository: fixture.runtime,
            nowMs: () => fixture.nowEpochMs,
            readPrincipalSessionIds: async (principal) => {
                expect(principal).toEqual({ applicationId: DESTINATION.applicationId, workspaceId: DESTINATION.workspaceId, principalId: 'alice' });
                return ['replacement-session'];
            }
        });
        expect(await reader.readProducerProvenance(message, entry)).toEqual({
            admittedAudience: ['replacement-session'],
            principalTargetId: 'alice',
            recipientScope: { applicationId: DESTINATION.applicationId, workspaceId: DESTINATION.workspaceId }
        });
    });

    it('expires durably without requiring any participant to send another request', async () => {
        const fixture = await database();
        const move = await fixture.act('propose');
        fixture.advance(120_000);
        const read = await fixture.moveService.readExpiry({ source: move.source, moveId: move.moveId, expiresAtEpochMs: move.expiresAtEpochMs }, 'expiry-test');
        const computed = computeGroupMoveExpiry(read);
        expect(validateGroupMoveExpiry(read, computed)).toEqual([]);
        await fixture.storage.sql.begin((transaction) => fixture.moveService.writeExpiry(transaction, computed));
        expect((await fixture.moves.listForPrincipal(DESTINATION, 'bob'))[0].status).toBe('expired');
    });

    it('publishes terminal history removal to the immutable accounts after physical record and lookup collection', async () => {
        const fixture = await database();
        await fixture.act('propose');
        const cancelled = await fixture.prepareMove('cancel');
        const deadline = cancelled.outbox.find((write) => decodePersistedALMessageRow(write.entry).payload.typeId === 'GROUP_MOVE_DEADLINE');
        expect(deadline).toBeDefined();
        const command = decodeGroupMoveDeadline(JSON.parse(decodePersistedALMessageRow(deadline!.entry).payload.resource));
        const dueAtEpochMs = cancelled.result.completedAtEpochMs! + 86_400_000;
        expect(deadline!.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(dueAtEpochMs);
        await fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, cancelled));
        expect((await fixture.moves.listForPrincipal(DESTINATION, 'bob'))[0].status).toBe('cancelled');
        const early = await fixture.moveService.readExpiry(command, 'too-early');
        expect(() => computeGroupMoveExpiry(early)).toThrow('not due');
        const old = (await fixture.moves.find(cancelled.result))!;
        fixture.advance(86_400_000);
        await fixture.storage.sql`delete from runtime_state_store where store_namespace in ('group_moves','group_move_participant_lookup')`;
        expect(await fixture.moves.listForPrincipal(DESTINATION, 'bob')).toEqual([]);
        const replacement = await recreateMoveForAnotherCohort(fixture, { key: old.entry.key, original: cancelled.result, atEpochMs: dueAtEpochMs });
        const oldProposal = { source: cancelled.result.source, moveId: cancelled.result.moveId, expiresAtEpochMs: cancelled.result.expiresAtEpochMs };
        expect(computeGroupMoveExpiry(await fixture.moveService.readExpiry(oldProposal, 'reused-proposal')).result).toBeNull();
        const read = await fixture.moveService.readExpiry(command, 'retained-history-expired');
        const computed = computeGroupMoveExpiry(read);
        expect(validateGroupMoveExpiry(read, computed)).toEqual([]);
        if (computed.kind !== 'terminal-retention') {
            throw new Error('Expected retained-history publication');
        }
        expect(validateGroupMoveExpiry(read, { ...computed, publication: { ...computed.publication, outbox: [] } })).not.toEqual([]);
        await assertHistoryOutboxRollback(fixture, computed);
        await fixture.storage.sql.begin((transaction) => fixture.moveService.writeExpiry(transaction, computed));
        expect((await fixture.moves.find(replacement))!.value.move).toEqual(replacement);
        const rows = await fixture.storage.sql<{ ri_resource: string; }[]>`select ri_resource from resource_inbox where ri_topic_id='view.invalidated'`;
        const recipients = rows.map(({ ri_resource }) => JSON.parse(ri_resource)).filter((notice) => notice.id.traceId === 'retained-history-expired')
            .map((notice) => notice.targets.principalRef.principalId).sort();
        expect(recipients).toEqual(['alice', 'bob']);
    });

    it('rejects a stale expiry write after cancellation and replays the terminal outcome on retry', async () => {
        const fixture = await database();
        const move = await fixture.act('propose');
        fixture.advance(120000);
        const deadline = { source: move.source, moveId: move.moveId, expiresAtEpochMs: move.expiresAtEpochMs };
        const staleRead = await fixture.moveService.readExpiry(deadline, 'expiry-race');
        const stale = computeGroupMoveExpiry(staleRead);
        fixture.advance(-120000);
        await fixture.act('cancel');
        await expect(fixture.storage.sql.begin((transaction) => fixture.moveService.writeExpiry(transaction, stale)))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        fixture.advance(120000);
        const retryRead = await fixture.moveService.readExpiry(deadline, 'expiry-retry');
        const retry = computeGroupMoveExpiry(retryRead);
        expect(retry).toMatchObject({ result: { status: 'cancelled' }, mutation: null });
    });

    it('requires both confirmations and commits both destination admissions with one outcome', async () => {
        const fixture = await database();
        await fixture.act('propose');
        await fixture.act('confirm');
        await expect(fixture.act('commit')).rejects.toThrow(/Every player/);
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
        await fixture.act('confirm', 'bob');
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
        const result = await fixture.act('commit');
        expect(result.status).toBe('committed');
        expect((await fixture.repository.readSnapshot(TARGET))?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob', 'carol']);
        expect((await fixture.repository.readSnapshot(DESTINATION))?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob']);
        expect(await fixture.moves.listForPrincipal(DESTINATION, 'bob')).toEqual([result]);
    });

    it('rejects a stale commit after Bob revokes his confirmation', async () => {
        const fixture = await database();
        await fixture.ready();
        const commit = await fixture.prepareMove('commit');
        await fixture.act('withdraw', 'bob');
        await expect(fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, commit))).rejects.toThrow(
            RuntimeStateWriteConflictError
        );
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
    });

    it('rejects an already-computed commit when a participant session is revoked', async () => {
        const fixture = await database();
        await fixture.ready();
        const commit = await fixture.prepareMove('commit');
        await fixture.auth.deleteSession(createTestAuthSession('bob'));
        await expect(fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, commit))).rejects.toThrow(
            RuntimeStateWriteConflictError
        );
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
    });

    it('expires instead of committing after the two-minute deadline', async () => {
        const fixture = await database();
        await fixture.ready();
        fixture.advance(120_000);
        expect((await fixture.act('commit')).status).toBe('expired');
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
    });
});

interface ReplacementMoveInput {
    readonly key: string;
    readonly original: GroupMove;
    readonly atEpochMs: number;
}

async function recreateMoveForAnotherCohort(fixture: GroupMoveServiceFixture, { key, original, atEpochMs }: ReplacementMoveInput): Promise<GroupMove> {
    const move: GroupMove = {
        ...original,
        participants: [{
            principalId: 'carol',
            sessionId: 'carol-new',
            generationId: 'carol-generation',
            generationVersion: atEpochMs,
            arrivedAtEpochMs: null,
            confirmedAtEpochMs: null
        }],
        organizerSessionId: 'carol-new',
        createdAtEpochMs: atEpochMs,
        expiresAtEpochMs: atEpochMs + 120000,
        completedAtEpochMs: null,
        status: 'proposed',
        reason: null,
        admissionFailure: null
    };
    await fixture.runtime.upsert({
        namespace: 'group_moves',
        key,
        value: JSON.stringify({ move, credentials: [] }),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    });
    return move;
}

async function assertHistoryOutboxRollback(fixture: GroupMoveServiceFixture, computed: GroupMoveService.ExpiryComputed): Promise<void> {
    const proofs = () =>
        fixture.storage.sql<{ count: number; }[]>`select count(*)::integer as count from runtime_state_store where store_namespace='ws-outbox-provenance'`;
    const before = await proofs();
    await fixture.storage.sql`create function reject_move_notice() returns trigger language plpgsql as 'begin return null; end'`;
    await fixture.storage.sql`create trigger reject_move_notice before insert on resource_inbox for each row execute function reject_move_notice()`;
    await expect(fixture.storage.sql.begin((transaction) => fixture.moveService.writeExpiry(transaction, computed))).rejects.toThrow();
    expect(await proofs()).toEqual(before);
    await fixture.storage.sql`drop trigger reject_move_notice on resource_inbox`;
}
