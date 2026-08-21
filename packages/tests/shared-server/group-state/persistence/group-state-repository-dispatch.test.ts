import { describe, expect, it } from 'vitest';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';

describe('GroupStateRepository facade dispatch', () => {
    it('dispatches every persistence read through the protected facade decoder', async () => {
        const runtime = new SnapshotRevisionRuntime();
        const repository = new TrackingGroupStateRepository(runtime);
        const fixture = createFixture();
        await seedFixture(repository, fixture);
        await expectDirectReadsUseFacadeDecoder(repository, fixture);
        await expectSnapshotReadsUseFacadeDecoder(repository, fixture);
    });
});

describe('GroupStateRepository snapshot facade dispatch', () => {
    it('dispatches unstable scope snapshots through the facade readSnapshot override', async () => {
        const runtime = new SnapshotRevisionRuntime();
        const repository = new TrackingGroupStateRepository(runtime);
        const fixture = createFixture();
        await seedFixture(repository, fixture);
        runtime.changeScopeListRevision = true;
        repository.resetDispatchCalls();

        await expect(repository.listSnapshots(fixture.group)).resolves.toHaveLength(1);

        expect(repository.dispatchCalls.readSnapshot).toBe(1);
    });

    it('dispatches page child reads and changed groups through facade overrides', async () => {
        const runtime = new SnapshotRevisionRuntime();
        const repository = new TrackingGroupStateRepository(runtime);
        const fixture = createFixture();
        await seedFixture(repository, fixture);
        runtime.changePageRevision = true;
        repository.resetDispatchCalls();

        await expect(repository.listSnapshotsPage(fixture.group, { limit: 10 })).resolves.toMatchObject(
            { snapshots: [expect.any(Object)] }
        );

        expect(repository.dispatchCalls).toMatchObject({
            readSnapshot: 1,
            listMembers: 2,
            findPresenceSummaryEntry: 2,
            listPresenceSessions: 2
        });
    });

    it('dispatches fallback authority reads through facade overrides', async () => {
        const repository = new TrackingGroupStateRepository(new SnapshotRevisionRuntime());
        const fixture = createFixture();
        await seedFixture(repository, fixture);
        repository.resetDispatchCalls();

        await expect(repository.readSnapshotWithAuthorityGuard(fixture.group)).resolves.toMatchObject({
            snapshot: expect.any(Object)
        });

        expect(repository.dispatchCalls).toMatchObject({
            findGroupEntry: 2,
            listMembers: 1,
            findPresenceSummaryEntry: 1,
            listPresenceSessions: 1
        });
    });
});

class TrackingGroupStateRepository extends GroupStateRepository {
    readonly liveNamespaces: string[] = [];
    readonly dispatchCalls = {
        readSnapshot: 0,
        findGroupEntry: 0,
        listMembers: 0,
        findPresenceSummaryEntry: 0,
        listPresenceSessions: 0
    };

    protected override async toLiveEntryValue<T>(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        this.liveNamespaces.push(namespace);
        return await super.toLiveEntryValue<T>(namespace, entry);
    }

    override async readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        this.dispatchCalls.readSnapshot += 1;
        return await super.readSnapshot(ref);
    }

    override async findGroupEntry(ref: GroupRef): Promise<RuntimeStateEntryValue<Group> | undefined> {
        this.dispatchCalls.findGroupEntry += 1;
        return await super.findGroupEntry(ref);
    }

    override async listMembers(ref: GroupRef): Promise<readonly GroupMember[]> {
        this.dispatchCalls.listMembers += 1;
        return await super.listMembers(ref);
    }

    override async findPresenceSummaryEntry(
        ref: GroupRef
    ): Promise<RuntimeStateEntryValue<GroupPresenceSummary> | undefined> {
        this.dispatchCalls.findPresenceSummaryEntry += 1;
        return await super.findPresenceSummaryEntry(ref);
    }

    override async listPresenceSessions(ref: GroupRef): Promise<readonly GroupPresenceSession[]> {
        this.dispatchCalls.listPresenceSessions += 1;
        return await super.listPresenceSessions(ref);
    }

    resetLiveNamespaces(): void {
        this.liveNamespaces.length = 0;
    }

    resetDispatchCalls(): void {
        for (const name of Object.keys(this.dispatchCalls) as Array<keyof typeof this.dispatchCalls>) {
            this.dispatchCalls[name] = 0;
        }
    }
}

class SnapshotRevisionRuntime extends FakeRuntimeStateRepository {
    changeScopeListRevision = false;
    changePageRevision = false;
    private groupScopeListCount = 0;

    override async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        const entries = await super.findEntriesByPrefix(namespace, keyPrefix);
        if (namespace !== 'group-state:groups' || !this.changeScopeListRevision) {
            return entries;
        }
        this.groupScopeListCount += 1;
        return this.groupScopeListCount === 2
            ? entries.map((entry) => ({ ...entry, revision: entry.revision + 1 }))
            : entries;
    }

    override async findEntriesByKeys(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntry[]> {
        const entries = await super.findEntriesByKeys(namespace, keys);
        return namespace === 'group-state:groups' && this.changePageRevision
            ? entries.map((entry) => ({ ...entry, revision: entry.revision + 1 }))
            : entries;
    }
}

interface DispatchFixture {
    readonly group: Group;
    readonly owner: GroupMember;
    readonly session: GroupPresenceSession;
    readonly admission: GroupPresenceAdmission;
    readonly summary: GroupPresenceSummary;
}

interface DispatchFixtureContext {
    readonly ref: GroupRef;
    readonly audit: Group['created'];
    readonly observedAtEpochMs: number;
}

async function expectDirectReadsUseFacadeDecoder(
    repository: TrackingGroupStateRepository,
    fixture: DispatchFixture
): Promise<void> {
    const reads = [
        ['group entry', 'group-state:groups', () => repository.readGroupEntry(fixture.group)],
        ['group list', 'group-state:groups', () => repository.listGroups(fixture.group)],
        ['member entry', 'group-state:members', () => repository.findMemberEntry(fixture.owner)],
        ['member list', 'group-state:members', () => repository.listMemberEntries(fixture.group)],
        ['session entry', 'group-state:sessions', () => repository.readPresenceEntry(fixture.session)],
        [
            'session list',
            'group-state:sessions',
            () => repository.listPresenceSessionEntries(fixture.group)
        ],
        ['all sessions', 'group-state:sessions', () => repository.listAllPresenceSessions()],
        [
            'admission entry',
            'group-state:presence-admissions',
            () => repository.findPresenceAdmissionEntry(fixture.admission)
        ],
        [
            'admission list',
            'group-state:presence-admissions',
            () => repository.listPresenceAdmissionEntries(fixture.group)
        ],
        [
            'summary entry',
            'group-state:presence-summaries',
            () => repository.findPresenceSummaryEntry(fixture.group)
        ]
    ] as const;

    for (const [label, namespace, read] of reads) {
        repository.resetLiveNamespaces();
        await read();
        expect(repository.liveNamespaces, label).toContain(namespace);
    }
}

async function expectSnapshotReadsUseFacadeDecoder(
    repository: TrackingGroupStateRepository,
    fixture: DispatchFixture
): Promise<void> {
    const reads = [
        ['snapshot list', () => repository.listSnapshots(fixture.group)],
        ['snapshot page', () => repository.listSnapshotsPage(fixture.group, { limit: 10 })],
        ['authority snapshot', () => repository.readSnapshotWithAuthorityGuard(fixture.group)]
    ] as const;
    const expectedNamespaces = new Set([
        'group-state:groups',
        'group-state:members',
        'group-state:presence-summaries',
        'group-state:sessions'
    ]);

    for (const [label, read] of reads) {
        repository.resetLiveNamespaces();
        await read();
        expect(new Set(repository.liveNamespaces), label).toEqual(expectedNamespaces);
    }
}

async function seedFixture(
    repository: GroupStateRepository,
    fixture: DispatchFixture
): Promise<void> {
    await repository.insertGroup(fixture.group);
    await repository.putMember(fixture.owner);
    await repository.putPresenceSession(fixture.session);
    await repository.insertPresenceAdmission(fixture.admission);
    await repository.insertPresenceSummary(fixture.summary);
}

function createFixture(): DispatchFixture {
    const observedAtEpochMs = Date.now();
    const ref = {
        applicationId: 'facade-dispatch-app',
        workspaceId: 'facade-dispatch-workspace',
        groupId: 'facade-dispatch-group'
    };
    const audit = {
        atEpochMs: observedAtEpochMs - 1_000,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null
    } satisfies Group['created'];
    const context = { ref, audit, observedAtEpochMs };
    const group = createDispatchGroup(context);
    const owner = createDispatchOwner(context);
    const session = createDispatchSession(context);
    return {
        group,
        owner,
        session,
        admission: createDispatchAdmission(context, session),
        summary: createDispatchSummary(context, session)
    };
}

function createDispatchGroup(context: DispatchFixtureContext): Group {
    return createTestGroup({
        ...context.ref,
        displayName: 'Facade dispatch group',
        activeMemberCount: 1,
        ownerPrincipalId: 'owner',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: context.audit,
        updated: context.audit
    });
}

function createDispatchOwner(context: DispatchFixtureContext): GroupMember {
    return {
        ...context.ref,
        principalId: 'owner',
        role: 'owner',
        status: 'active',
        joined: context.audit,
        updated: context.audit,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    };
}

function createDispatchSession(context: DispatchFixtureContext): GroupPresenceSession {
    return {
        ...context.ref,
        sessionId: 'facade-dispatch-session',
        principalId: 'owner',
        generationId: 'facade-dispatch-generation',
        generationVersion: context.observedAtEpochMs - 500,
        connectedAtEpochMs: context.observedAtEpochMs - 500,
        lastHeartbeatAtEpochMs: context.observedAtEpochMs - 100,
        expiresAtEpochMs: context.observedAtEpochMs + 60_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function createDispatchAdmission(
    context: DispatchFixtureContext,
    session: GroupPresenceSession
): GroupPresenceAdmission {
    return {
        ...context.ref,
        principalId: 'owner',
        admittedSessions: [
            {
                sessionId: session.sessionId,
                generationId: session.generationId,
                generationVersion: session.generationVersion,
                connectedAtEpochMs: session.connectedAtEpochMs
            }
        ],
        updatedAtEpochMs: context.observedAtEpochMs
    };
}

function createDispatchSummary(
    context: DispatchFixtureContext,
    session: GroupPresenceSession
): GroupPresenceSummary {
    return {
        ...context.ref,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        activePrincipalIds: ['owner'],
        activeSessionIds: [session.sessionId],
        activeSessions: [session],
        activePrincipalCount: 1,
        activeSessionCount: 1,
        computedAtEpochMs: context.observedAtEpochMs
    };
}
