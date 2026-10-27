import {
    describe,
    expect,
    it
} from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import type { Group } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { presenceConnectEnqueue } from '../inbox/group-state-inbox-presence-fixtures.ts';
import {
    createAuthorityHarness,
    processAuthenticated,
    SCOPE,
    type AuthorityHarness
} from '../inbox/group-state-inbox-test-runtime.ts';

const REF = { ...SCOPE, groupId: 'retained-room' };

interface RetentionFixture {
    readonly harness: AuthorityHarness;
    readonly service: GroupRetentionService;
    nowEpochMs: number;
}

describe('temporary room retention decisions', () => {
    it('starts grace at the fresh observation and archives at its exact deadline', async () => {
        const fixture = await createFixture();
        const initial = await reconcile(fixture, 'first');
        const observed = await group(fixture);
        expect(initial.receipt?.outcome).toBe('applied');
        expect(observed.emptySinceEpochMs).toBe(fixture.nowEpochMs);
        expect(observed.metadata.rallarRetention).toMatchObject({ emptyPresenceFingerprint: expect.stringMatching(/^sha256:/u) });

        fixture.nowEpochMs += 999;
        const waiting = await reconcile(fixture, 'waiting');
        expect(waiting.receipt?.outcome).toBe('no-op');
        expect(await group(fixture)).toEqual(observed);
        fixture.nowEpochMs += 1;
        const archived = await reconcile(fixture, 'archive');
        expect(archived.receipt?.outcome).toBe('applied');
        expect(await group(fixture)).toMatchObject({ status: 'archived', deleted: null, archived: { atEpochMs: fixture.nowEpochMs } });
        expect((await fixture.harness.repository.listEvents(REF)).map((event) => event.eventType))
            .toEqual(['group-created', 'group-updated', 'group-archived']);
    });

    it('clears an idle observation from live admitted authority even when its summary is still empty', async () => {
        const fixture = await createFixture();
        await reconcile(fixture, 'first');
        await connectOwner(fixture);
        expect((await fixture.harness.repository.findPresenceSummaryEntry(REF))?.value.activeSessionCount).toBe(0);
        fixture.nowEpochMs += 1_000;

        await reconcile(fixture, 'live');

        expect(await group(fixture)).toMatchObject({
            status: 'active',
            emptySinceEpochMs: null,
            metadata: { rallarRetention: { emptyPresenceFingerprint: null } }
        });
    });

    it('restarts grace after between-scan activity whose ingress predates the idle observation', async () => {
        const fixture = await createFixture();
        fixture.nowEpochMs += 2_000;
        await reconcile(fixture, 'first');
        const original = await group(fixture);
        await connectOwner(fixture);
        const result = await processAuthenticated({
            service: fixture.harness.service,
            reader: fixture.harness.reader,
            authority: fixture.harness.sessions.owner,
            input: {
                type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
                resourceId: 'old-disconnect',
                contextId: REF.groupId,
                data: {
                    scope: SCOPE,
                    groupId: REF.groupId,
                    sessionId: 'owner-session',
                    request: {
                        requestId: 'old-disconnect',
                        generationId: 'owner-generation',
                        disconnectedAtEpochMs: fixture.harness.nowEpochMs
                    }
                }
            }
        });
        expect(result.left).toBeUndefined();
        fixture.nowEpochMs += 1_000;

        await reconcile(fixture, 'changed-empty');

        const restarted = await group(fixture);
        expect(restarted.status).toBe('active');
        expect(restarted.emptySinceEpochMs).toBe(fixture.nowEpochMs);
        expect(restarted.metadata.rallarRetention).not.toEqual(original.metadata.rallarRetention);
    });

    it('uses fresh attempt time for delayed maintenance and replays the exact accepted receipt', async () => {
        const fixture = await createFixture();
        const ingress = fixture.service.capture({ groupRef: REF, requestId: 'delayed', observedAtEpochMs: fixture.nowEpochMs });
        fixture.nowEpochMs += 10_000;
        const read = await fixture.service.read(ingress, 2, 'trace-group-retention');
        const computed = fixture.service.compute(read);
        expect(fixture.service.validate(read, computed)).toEqual([]);
        await fixture.harness.database.begin((transaction) => fixture.service.write(transaction, computed));
        expect((await group(fixture)).emptySinceEpochMs).toBe(fixture.nowEpochMs);
        const count = (await fixture.harness.repository.listEvents(REF)).length;
        fixture.nowEpochMs += 10_000;
        const replay = fixture.service.compute(await fixture.service.read(ingress, 3, 'trace-group-retention'));
        expect(replay).toEqual({ outcome: 'replay', receipt: computed.receipt });
        expect((await fixture.harness.repository.listEvents(REF)).length).toBe(count);
        const changed = fixture.service.capture({ ...ingress.command, observedAtEpochMs: fixture.nowEpochMs });
        await expect(fixture.service.read(changed, 1, 'trace-group-retention')).rejects.toMatchObject({ status: 409 });
    });

    it.each(['persistent', 'archived', 'missing'] as const)('leaves %s rooms unchanged', async (mode) => {
        const fixture = await createFixture(mode !== 'persistent');
        if (mode === 'archived') {
            await fixture.harness.repository.putGroup({
                ...(await group(fixture)),
                status: 'archived',
                archived: { ...(await group(fixture)).updated, atEpochMs: fixture.nowEpochMs },
                deleted: null
            });
        }
        if (mode === 'missing') {
            await fixture.harness.repository.removeGroup(REF);
        }
        const before = await fixture.harness.repository.findGroup(REF);
        const outboxCount = fixture.harness.database.outboxEntries.size;

        const computed = await reconcile(fixture, 'ignored');

        expect(computed.outcome).toBe(mode === 'missing' ? 'absent' : 'no-op');
        expect(await fixture.harness.repository.findGroup(REF)).toEqual(before);
        expect(fixture.harness.database.outboxEntries.size).toBe(outboxCount);
    });

    it('rejects scope corruption before any retention decision', async () => {
        const fixture = await createFixture();
        await fixture.harness.runtimeRepository.upsert(
            GROUPS_NAMESPACE,
            groupStateGroupStorageKey(REF),
            JSON.stringify({ ...(await group(fixture)), workspaceId: 'other-workspace' }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        const ingress = fixture.service.capture({ groupRef: REF, requestId: 'corrupt', observedAtEpochMs: fixture.nowEpochMs });

        await expect(fixture.service.read(ingress, 1, 'trace-group-retention')).rejects.toMatchObject({ code: 'group-state-repository-invariant-corruption' });
    });

    it('validates the complete prepared write and is independent of authority row ordering', async () => {
        const fixture = await createFixture();
        const ingress = fixture.service.capture({ groupRef: REF, requestId: 'validate', observedAtEpochMs: fixture.nowEpochMs });
        const read = await fixture.service.read(ingress, 1, 'trace-group-retention');
        const computed = fixture.service.compute(read);
        expect(fixture.service.validate(read, computed)).toEqual([]);
        if (computed.outcome === 'absent') {
            throw new Error('Expected an existing room');
        }
        expect(fixture.service.validate(read, { ...computed, receipt: { ...computed.receipt, commandHash: 'sha256:wrong' } }).length)
            .toBeGreaterThan(0);
        const reversed = {
            ...read,
            authority: {
                ...read.authority,
                members: read.authority.members.toReversed(),
                admissions: read.authority.admissions.toReversed(),
                presenceSessions: read.authority.presenceSessions.toReversed()
            }
        };
        expect(fixture.service.compute(reversed)).toEqual(computed);
    });
});

async function createFixture(temporary = true): Promise<RetentionFixture> {
    const harness = await createAuthorityHarness(['owner']);
    const clock = { nowEpochMs: harness.nowEpochMs };
    const service = new GroupRetentionService({ repository: harness.repository, groupOwnedAppData: { read: async () => [] } }, {
        now: () => clock.nowEpochMs,
        serviceId: 'retention-service'
    });
    const result = await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions.owner,
        input: {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'create-retained',
            contextId: REF.groupId,
            data: {
                scope: SCOPE,
                request: {
                    requestId: 'create-retained',
                    groupId: REF.groupId,
                    displayName: 'Retained room',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    ...(temporary ? { retention: { mode: 'temporary', reconnectGraceMs: 1_000 } } : {})
                }
            }
        }
    });
    expect(result.left).toBeUndefined();
    return Object.assign(clock, { harness, service });
}

async function reconcile(fixture: RetentionFixture, requestId: string): Promise<GroupRetentionService.Computed> {
    const ingress = fixture.service.capture({ groupRef: REF, requestId, observedAtEpochMs: fixture.nowEpochMs });
    const read = await fixture.service.read(ingress, 1, 'trace-group-retention');
    const computed = fixture.service.compute(read);
    expect(fixture.service.validate(read, computed)).toEqual([]);
    await fixture.harness.database.begin((transaction) => fixture.service.write(transaction, computed));
    return computed;
}

async function group(fixture: RetentionFixture): Promise<Group> {
    const found = await fixture.harness.repository.findGroup(REF);
    if (found === undefined) {
        throw new Error('Expected the retained room');
    }
    return found;
}

async function connectOwner(fixture: RetentionFixture): Promise<void> {
    const enqueue = presenceConnectEnqueue(REF.groupId, 'owner', fixture.harness.nowEpochMs);
    const result = await processAuthenticated({
        service: fixture.harness.service,
        reader: fixture.harness.reader,
        authority: fixture.harness.sessions.owner,
        input: enqueue
    });
    expect(result.left).toBeUndefined();
}
