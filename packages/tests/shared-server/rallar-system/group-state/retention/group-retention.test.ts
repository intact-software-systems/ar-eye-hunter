import {
    describe,
    expect,
    it
} from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import type { Group } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createTestGroupStateRuntime } from '../group-state-test-runtime.ts';
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
    it('protects an empty court until its automatic successor has finished, including after a delayed worker', async () => {
        const fixture = await createFixture();
        const start = fixture.nowEpochMs;
        const clock = {
            name: 'match', revision: 1, startedAtRevision: 1, phase: 'warmup', status: 'running',
            startedBy: 'director', startedAtEpochMs: start, endsAtEpochMs: start + 2_000,
            successor: { phase: 'play', durationMs: 10_000 }
        };
        await storeClock(fixture, clock);
        await reconcile(fixture, 'empty-court');
        fixture.nowEpochMs += 4_000;
        await reconcile(fixture, 'delayed-successor');
        expect((await group(fixture)).status).toBe('active');

        await storeClock(fixture, {
            ...clock, phase: 'play', startedBy: 'automatic', revision: 2, startedAtRevision: 2,
            startedAtEpochMs: start + 2_000, endsAtEpochMs: start + 12_000, successor: null
        });
        fixture.nowEpochMs = start + 11_999;
        await reconcile(fixture, 'still-playing');
        expect((await group(fixture)).status).toBe('active');
        fixture.nowEpochMs += 1;
        await reconcile(fixture, 'match-ended');
        expect((await group(fixture)).status).toBe('archived');
    });

    it.each([[undefined, 3_600_000], [5_000, 5_000]] as const)(
        'starts the paused-room window at the later of empty observation and pause, with override %s',
        async (override, duration) => {
            const fixture = await createFixture(true, override);
            await reconcile(fixture, 'empty-court');
            fixture.nowEpochMs += 20_000;
            const pause = fixture.nowEpochMs;
            await storeClock(fixture, { ...pausedClock(fixture), successor: { phase: 'play', durationMs: 10_000 } });
            fixture.nowEpochMs = pause + duration - 1;
            await reconcile(fixture, 'still-recoverable');
            expect((await group(fixture)).status).toBe('active');
            fixture.nowEpochMs += 1;
            await reconcile(fixture, 'paused-window-expired');
            expect((await group(fixture)).status).toBe('archived');
        }
    );

    it('starts a fresh paused window after a player returns and leaves, even without a configured successor', async () => {
        const fixture = await createFixture(true, 5_000);
        await storeClock(fixture, pausedClock(fixture));
        await reconcile(fixture, 'first-empty');
        fixture.nowEpochMs += 4_000;
        await connectOwner(fixture);
        await reconcile(fixture, 'occupied');
        expect((await group(fixture)).emptySinceEpochMs).toBeNull();
        fixture.nowEpochMs += 1_500;
        await disconnectOwner(fixture, fixture.nowEpochMs);
        await reconcile(fixture, 'empty-again');
        fixture.nowEpochMs += 4_999;
        await reconcile(fixture, 'new-window-open');
        expect((await group(fixture)).status).toBe('active');
        fixture.nowEpochMs += 1;
        await reconcile(fixture, 'new-window-ended');
        expect((await group(fixture)).status).toBe('archived');
    });

    it.each([4_999, 5_000])('enforces the remaining paused window on arrival %i ms after lease expiry', async (elapsedMs) => {
        const fixture = await createFixture(true, 5_000);
        await storeClock(fixture, pausedClock(fixture));
        await connectOwner(fixture, 1_000);
        const { service, reader, sessions, runtimeRepository, repository } = fixture.harness;
        const runtime = createTestGroupStateRuntime({
            runtimeRepository, now: () => fixture.nowEpochMs, serviceId: 'expiry'
        });
        fixture.nowEpochMs += 1_000 + elapsedMs;
        expect(await runtime.maintenance.expireExpiredPresenceSessions(fixture.nowEpochMs)).toHaveLength(1);
        const returning = presenceConnectEnqueue(REF.groupId, 'owner', fixture.nowEpochMs);
        if (returning.type !== AppInboxType.GROUP_PRESENCE_CONNECT) throw new Error('Expected presence entry');
        const result = await processAuthenticated({
            service, reader, authority: sessions.owner,
            input: {
                ...returning, resourceId: 'return-to-court',
                data: { ...returning.data, request: { ...returning.data.request, requestId: 'return-to-court', generationId: 'returning' } }
            }
        });
        const session = await repository.findPresenceEntry({ ...REF, sessionId: 'owner-session' });
        if (elapsedMs < 5_000) {
            expect(result.left).toBeUndefined();
            expect(session?.value).toMatchObject({ status: 'active', generationId: 'returning' });
        } else {
            expect(result.left?.code).toBe('group-mutation-rejected');
            expect(session?.value.status).toBe('disconnected');
        }
        await reconcile(fixture, 'maintenance-recovered');
        expect((await group(fixture)).status).toBe(elapsedMs < 5_000 ? 'active' : 'archived');
    });

    it('keeps an empty scheduled room through the no-show window and then starts the full grace', async () => {
        const fixture = await createFixture();
        const startsAtEpochMs = fixture.nowEpochMs + 3_600_000;
        const current = await group(fixture);
        await fixture.harness.repository.putGroup({
            ...current,
            maxMembers: 4,
            metadata: {
                ...current.metadata,
                rallarSessionSchedule: { revision: 1, startsAtEpochMs, cancelledAtEpochMs: null }
            }
        });

        await reconcile(fixture, 'upcoming');
        expect(await group(fixture)).toMatchObject({ status: 'active', emptySinceEpochMs: null });
        fixture.nowEpochMs = startsAtEpochMs + 599_999;
        await reconcile(fixture, 'no-shows-waiting');
        expect(await group(fixture)).toMatchObject({ status: 'active', emptySinceEpochMs: null });
        fixture.nowEpochMs += 1;
        await reconcile(fixture, 'no-shows-expired');
        expect(await group(fixture)).toMatchObject({ status: 'active', emptySinceEpochMs: fixture.nowEpochMs });
        fixture.nowEpochMs += 999;
        await reconcile(fixture, 'grace-waiting');
        expect((await group(fixture)).status).toBe('active');
        fixture.nowEpochMs += 1;
        await reconcile(fixture, 'grace-expired');
        expect((await group(fixture)).status).toBe('archived');
    });

    it('clears old idle observations during a schedule hold and releases the hold on cancellation', async () => {
        const fixture = await createFixture();
        await reconcile(fixture, 'old-idle');
        const current = await group(fixture);
        const schedule = { revision: 1, startsAtEpochMs: fixture.nowEpochMs + 3_600_000, cancelledAtEpochMs: null };
        await fixture.harness.repository.putGroup({
            ...current,
            maxMembers: 4,
            metadata: { ...current.metadata, rallarSessionSchedule: schedule }
        });
        fixture.nowEpochMs += 10_000;
        await reconcile(fixture, 'held');
        const held = await group(fixture);
        expect(held).toMatchObject({ status: 'active', emptySinceEpochMs: null });
        await fixture.harness.repository.putGroup({
            ...held,
            metadata: {
                ...held.metadata,
                rallarSessionSchedule: { ...schedule, cancelledAtEpochMs: fixture.nowEpochMs }
            }
        });
        await reconcile(fixture, 'cancelled');
        expect(await group(fixture)).toMatchObject({ status: 'active', emptySinceEpochMs: fixture.nowEpochMs });
        fixture.nowEpochMs += 1_000;
        await reconcile(fixture, 'cancelled-grace-expired');
        expect((await group(fixture)).status).toBe('archived');
    });

    it('does not reuse pre-schedule idle time when maintenance resumes after the no-show deadline', async () => {
        const fixture = await createFixture();
        await reconcile(fixture, 'before-scheduling');
        const current = await group(fixture);
        const startsAtEpochMs = fixture.nowEpochMs + 3_600_000;
        await fixture.harness.repository.putGroup({
            ...current,
            maxMembers: 4,
            metadata: {
                ...current.metadata,
                rallarSessionSchedule: { revision: 1, startsAtEpochMs, cancelledAtEpochMs: null }
            }
        });
        fixture.nowEpochMs = startsAtEpochMs + 700_000;

        await reconcile(fixture, 'maintenance-recovered');

        expect(await group(fixture)).toMatchObject({ status: 'active', emptySinceEpochMs: fixture.nowEpochMs });
    });

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
        await disconnectOwner(fixture);
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
        const read = await fixture.service.read(ingress, { attemptCount: 2, traceId: 'trace-group-retention' });
        const computed = fixture.service.compute(read);
        expect(fixture.service.validate(read, computed)).toEqual([]);
        await fixture.harness.database.begin((transaction) => fixture.service.write(transaction, computed));
        expect((await group(fixture)).emptySinceEpochMs).toBe(fixture.nowEpochMs);
        const count = (await fixture.harness.repository.listEvents(REF)).length;
        fixture.nowEpochMs += 10_000;
        const replay = fixture.service.compute(await fixture.service.read(ingress, { attemptCount: 3, traceId: 'trace-group-retention' }));
        expect(replay).toEqual({ outcome: 'replay', receipt: computed.receipt });
        expect((await fixture.harness.repository.listEvents(REF)).length).toBe(count);
        const changed = fixture.service.capture({ ...ingress.command, observedAtEpochMs: fixture.nowEpochMs });
        await expect(fixture.service.read(changed, { attemptCount: 1, traceId: 'trace-group-retention' })).rejects.toMatchObject({ status: 409 });
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
            {
                namespace: GROUPS_NAMESPACE,
                key: groupStateGroupStorageKey(REF),
                value: JSON.stringify({ ...(await group(fixture)), workspaceId: 'other-workspace' }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
        const ingress = fixture.service.capture({ groupRef: REF, requestId: 'corrupt', observedAtEpochMs: fixture.nowEpochMs });

        await expect(fixture.service.read(ingress, { attemptCount: 1, traceId: 'trace-group-retention' })).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    });

    it('validates the complete prepared write and is independent of authority row ordering', async () => {
        const fixture = await createFixture();
        const ingress = fixture.service.capture({ groupRef: REF, requestId: 'validate', observedAtEpochMs: fixture.nowEpochMs });
        const read = await fixture.service.read(ingress, { attemptCount: 1, traceId: 'trace-group-retention' });
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

async function createFixture(temporary = true, pausedTimelineRetentionMs?: number): Promise<RetentionFixture> {
    const clock = { nowEpochMs: Date.now() };
    const harness = await createAuthorityHarness(['owner'], { now: () => clock.nowEpochMs });
    const service = new GroupRetentionService({
        runtime: harness.runtimeRepository,
        repository: harness.repository,
        groupOwnedAppData: { read: async () => [] }
    }, {
        now: () => clock.nowEpochMs,
        finishedRetentionMs: 60000,
        serviceId: 'retention-service'
    });
    const result = await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions.owner,
        input: {
            traceId: 'trace-test-fixture',
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
                    ...(temporary ? { retention: { mode: 'temporary', reconnectGraceMs: 1_000,
                        ...(pausedTimelineRetentionMs === undefined ? {} : { pausedTimelineRetentionMs }) } } : {})
                }
            }
        }
    });
    expect(result.left).toBeUndefined();
    return Object.assign(clock, { harness, service });
}

async function reconcile(fixture: RetentionFixture, requestId: string): Promise<GroupRetentionService.Computed> {
    const ingress = fixture.service.capture({ groupRef: REF, requestId, observedAtEpochMs: fixture.nowEpochMs });
    const read = await fixture.service.read(ingress, { attemptCount: 1, traceId: 'trace-group-retention' });
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

async function connectOwner(fixture: RetentionFixture, leaseMs = 60_000): Promise<void> {
    const enqueue = presenceConnectEnqueue(REF.groupId, 'owner', fixture.harness.nowEpochMs);
    if (enqueue.type !== AppInboxType.GROUP_PRESENCE_CONNECT) throw new Error('Expected presence entry');
    const result = await processAuthenticated({
        service: fixture.harness.service,
        reader: fixture.harness.reader,
        authority: fixture.harness.sessions.owner,
        input: { ...enqueue, data: { ...enqueue.data, request: { ...enqueue.data.request, expiresAtEpochMs: fixture.harness.nowEpochMs + leaseMs } } }
    });
    expect(result.left).toBeUndefined();
}

async function disconnectOwner(fixture: RetentionFixture, disconnectedAtEpochMs = fixture.harness.nowEpochMs): Promise<void> {
    const result = await processAuthenticated({
        service: fixture.harness.service,
        reader: fixture.harness.reader,
        authority: fixture.harness.sessions.owner,
        input: {
            traceId: 'trace-test-fixture',
            type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
            resourceId: 'disconnect-owner',
            contextId: REF.groupId,
            data: {
                scope: SCOPE,
                groupId: REF.groupId,
                sessionId: 'owner-session',
                request: {
                    requestId: 'disconnect-owner',
                    generationId: 'owner-generation',
                    disconnectedAtEpochMs
                }
            }
        }
    });
    expect(result.left).toBeUndefined();
}

async function storeClock(fixture: RetentionFixture, clock: ApiJsonObject): Promise<void> {
    const current = await group(fixture);
    await fixture.harness.repository.putGroup({ ...current, metadata: { ...current.metadata, rallarRoomClocks: [clock] } });
}

function pausedClock(fixture: RetentionFixture): ApiJsonObject {
    return {
        name: 'match', phase: 'warmup', revision: 2, startedAtRevision: 1,
        startedBy: 'director', startedAtEpochMs: fixture.harness.nowEpochMs, status: 'paused',
        remainingMs: 40_000, pausedAtEpochMs: fixture.nowEpochMs, successor: null
    };
}
