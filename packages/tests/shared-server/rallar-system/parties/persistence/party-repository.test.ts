import { writeRuntimeStateConditionalBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { describe, expect, it } from 'vitest';

import { computePartyStorage } from '@shared-server/rallar-system/parties/persistence/compute-party-storage.ts';
import type { PartyRecord } from '@shared-server/rallar-system/parties/persistence/party-record.ts';
import { PartyRepository } from '@shared-server/rallar-system/parties/persistence/party-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createResourceInboxTestStorage } from '../../../queuebox/resource-inbox-test-storage.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };

function party(partyId: string, leaderPrincipalId: string): PartyRecord {
    return {
        ref: { ...scope, partyId },
        status: 'active',
        leaderPrincipalId,
        rosterRevision: 0,
        createdAtEpochMs: 1000,
        members: [{ principalId: leaderPrincipalId, joinedAtEpochMs: 1000 }],
        invitations: []
    };
}

describe('party membership conditional storage', () => {
    it('rolls back a competing party creation when the account already joined elsewhere', async () => {
        const storage = await createResourceInboxTestStorage('party_account_race');
        try {
            const repository = new PartyRepository(new PSqlRuntimeStateRepository(storage.sql), () => 1000);
            const first = party('first', 'alice');
            const second = party('second', 'alice');
            const firstWrite = computePartyStorage({ read: await repository.read(first.ref, ['alice']), party: first });
            const secondWrite = computePartyStorage({ read: await repository.read(second.ref, ['alice']), party: second });
            await storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, firstWrite));
            await expect(storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, secondWrite)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await repository.readAccount(scope, 'alice')).account.partyId).toBe('first');
            expect((await repository.read(second.ref)).record).toBeNull();
            expect((await repository.readAccount({ ...scope, workspaceId: 'other' }, 'alice')).account.partyId).toBeNull();
        }
        finally {
            await storage.close();
        }
    });

    it('fences competing last-seat writes and never commits a partial account roster', async () => {
        const storage = await createResourceInboxTestStorage('party_last_seat');
        try {
            const repository = new PartyRepository(new PSqlRuntimeStateRepository(storage.sql), () => 1000);
            const initial = party('together', 'alice');
            const created = computePartyStorage({ read: await repository.read(initial.ref, ['alice']), party: initial });
            await storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, created));
            const read = await repository.read(initial.ref, ['bob', 'charlie']);
            const bob = computePartyStorage({
                read,
                party: {
                    ...initial,
                    rosterRevision: 1,
                    members: [...initial.members, { principalId: 'bob', joinedAtEpochMs: 2000 }]
                }
            });
            const charlie = computePartyStorage({
                read,
                party: {
                    ...initial,
                    rosterRevision: 1,
                    members: [...initial.members, { principalId: 'charlie', joinedAtEpochMs: 2000 }]
                }
            });
            await storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, bob));
            await expect(storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, charlie)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await repository.read(initial.ref)).record?.members.map((member) => member.principalId)).toEqual(['alice', 'bob']);
            expect((await repository.readAccount(scope, 'charlie')).account.partyId).toBeNull();
            const departure = computePartyStorage({
                read: await repository.read(initial.ref),
                party: {
                    ...initial,
                    rosterRevision: 2,
                    leaderPrincipalId: 'bob',
                    members: [{ principalId: 'bob', joinedAtEpochMs: 2000 }]
                }
            });
            await expect(storage.sql.begin(async (transaction) => {
                await writeRuntimeStateConditionalBatch(transaction, departure);
                throw new Error('durable result failed');
            })).rejects.toThrow('durable result failed');
            expect((await repository.readAccount(scope, 'alice')).account.partyId).toBe('together');
            expect((await repository.read(initial.ref)).record?.leaderPrincipalId).toBe('alice');
        }
        finally {
            await storage.close();
        }
    });

    it('rejects an intervening expired account row rather than overwriting observed absence', async () => {
        const storage = await createResourceInboxTestStorage('party_absence_race');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new PartyRepository(runtime, () => 1000);
            const initial = party('together', 'alice');
            const prepared = computePartyStorage({ read: await repository.read(initial.ref, ['alice']), party: initial });
            await runtime.upsert('parties:accounts', 'app=game:ws=default:principal=alice', 'unexpected expired value', 1);
            await expect(storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, prepared)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await repository.read(initial.ref)).record).toBeNull();
            expect((await runtime.findEntry('parties:accounts', 'app=game:ws=default:principal=alice'))?.value)
                .toBe('unexpected expired value');
        }
        finally {
            await storage.close();
        }
    });

    it('reclaims expired invitation lookup slots without requiring either old party to return', async () => {
        const storage = await createResourceInboxTestStorage('party_invitation_slots');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const clock = { now: 1000 };
            const repository = new PartyRepository(runtime, () => clock.now);
            const first = {
                ...party('first', 'alice'),
                invitations: [{
                    invitationId: 'first-invite',
                    senderPrincipalId: 'alice',
                    principalId: 'bob',
                    createdAtEpochMs: 1000,
                    expiresAtEpochMs: 2000
                }]
            };
            const firstRead = await repository.read(first.ref, ['alice', 'bob']);
            const firstWrite = computePartyStorage({ read: firstRead, party: first });
            await storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, firstWrite));
            clock.now = 3000;
            const second = {
                ...party('second', 'charlie'),
                invitations: [{
                    invitationId: 'second-invite',
                    senderPrincipalId: 'charlie',
                    principalId: 'bob',
                    createdAtEpochMs: 3000,
                    expiresAtEpochMs: 4000
                }]
            };
            const secondRead = await repository.read(second.ref, ['charlie', 'bob']);
            const secondWrite = computePartyStorage({ read: secondRead, party: second });
            await storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, secondWrite));
            expect((await repository.readAccount(scope, 'bob')).account.invitations)
                .toEqual([{ partyId: 'second', invitationId: 'second-invite', expiresAtEpochMs: 4000 }]);
            expect((await repository.read(first.ref)).record?.invitations).toEqual(first.invitations);
            const account = await repository.readAccount(scope, 'bob');
            await runtime.upsert(
                'parties:accounts',
                account.entry!.key,
                JSON.stringify({ ...account.account, invitations: [{ partyId: 'first', invitationId: '', expiresAtEpochMs: 2000 }] }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            await expect(repository.readAccount(scope, 'bob')).rejects.toThrow(/identity|non-empty/);
        }
        finally {
            await storage.close();
        }
    });

    it('fails on a foreign account slot or inconsistent membership instead of hiding corruption', async () => {
        const storage = await createResourceInboxTestStorage('party_corruption');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new PartyRepository(runtime, () => 1000);
            await runtime.upsert(
                'parties:accounts',
                'app=game:ws=default:principal=alice',
                JSON.stringify({
                    scope,
                    principalId: 'mallory',
                    partyId: null,
                    invitations: []
                }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            await expect(repository.readAccount(scope, 'alice')).rejects.toThrow(/identity|slot/i);
            await runtime.deleteByKey('parties:accounts', 'app=game:ws=default:principal=alice');
            const initial = party('together', 'alice');
            const prepared = computePartyStorage({ read: await repository.read(initial.ref, ['alice']), party: initial });
            await storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, prepared));
            await runtime.deleteByKey('parties:accounts', 'app=game:ws=default:principal=alice');
            await expect(repository.read(initial.ref)).rejects.toThrow(/membership|lookup/i);
        }
        finally {
            await storage.close();
        }
    });
});
