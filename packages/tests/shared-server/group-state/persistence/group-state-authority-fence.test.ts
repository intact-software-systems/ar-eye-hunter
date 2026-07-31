import { describe, expect, it } from 'vitest';
import type { Group, GroupMember, GroupRef } from '@shared/api/group-types.ts';
import type {
    RuntimeStateEntry,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
    GroupStateRepository,
} from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    groupStateGroupStorageKey,
    groupStateMemberStorageKey,
} from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';

describe('GroupStateRepository authority fence', () => {
    it('preserves the exact raw group bytes, physical expiry, and every domain field', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const { group, owner } = fixture();
        await repository.insertGroup(group);
        await repository.putMember(owner);
        const inserted = await repository.findGroupEntry(group);
        const semanticallyValidLegacyRaw = JSON.stringify(group, null, 2);
        await runtime.upsert(
            'group-state:groups',
            inserted!.entry.key,
            semanticallyValidLegacyRaw,
            inserted!.entry.expireAtTimestamp,
        );
        const observation = await repository.readSnapshotWithAuthorityGuard(group);
        const before = observation!.authorityGuard.entry;
        expect(before.value).toBe(semanticallyValidLegacyRaw);

        await expect(repository.advanceAuthorityFence(observation!.authorityGuard))
            .resolves.toEqual({ status: 'applied', revision: before.revision + 1 });

        const after = await repository.findGroupEntry(group);
        expect(after!.entry.value).toBe(before.value);
        expect(after!.entry.expireAtTimestamp).toBe(before.expireAtTimestamp);
        expect(after!.entry.revision).toBe(before.revision + 1);
        expect(after!.value).toEqual(group);
    });

    it('conflicts for a stale observed storage revision', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const { group, owner } = fixture();
        await repository.insertGroup(group);
        await repository.putMember(owner);
        const observation = await repository.readSnapshotWithAuthorityGuard(group);

        expect(await repository.advanceAuthorityFence(observation!.authorityGuard))
            .toMatchObject({ status: 'applied' });
        await expect(repository.advanceAuthorityFence(observation!.authorityGuard))
            .resolves.toEqual({ status: 'conflict' });
    });

    it('keeps domain causal revision stable across physical authority fences', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const { group, owner } = fixture();
        await repository.insertGroup(group);
        await repository.putMember(owner);
        const before = await repository.readSnapshotWithAuthorityGuard(group);
        await repository.advanceAuthorityFence(before!.authorityGuard);
        const after = await repository.readSnapshotWithAuthorityGuard(group);

        expect(after!.snapshot.causalRevision.groupRevision)
            .toBe(before!.snapshot.causalRevision.groupRevision);
        expect(after!.authorityGuard.causalGroupRevision)
            .toBe(before!.authorityGuard.causalGroupRevision);
        expect(await repository.readCausalRevision(group)).toMatchObject({
            groupRevision: group.snapshotVersion,
        });
        expect(after!.snapshot.group).toEqual(before!.snapshot.group);
    });

    it('uses one dense batch read as the authority snapshot on capable repositories', async () => {
        const runtime = new BatchReadRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const { group, owner } = fixture();
        await repository.insertGroup(group);
        await repository.putMember(owner);
        const expiredMember = {
            ...owner,
            principalId: 'expired-member',
            role: 'member',
        } as const satisfies GroupMember;
        await repository.putMember(expiredMember);
        const expiredMemberKey = groupStateMemberStorageKey(expiredMember);
        const expiredEntry = await runtime.findEntry(
            'group-state:members',
            expiredMemberKey,
        );
        await runtime.upsert(
            'group-state:members',
            expiredMemberKey,
            expiredEntry!.value,
            Date.now() - 1,
        );
        const fallbackRuntime = cloneRuntime(runtime);
        const expected = await new GroupStateRepository(fallbackRuntime)
            .readSnapshotWithAuthorityGuard(group);
        runtime.rejectLegacyReads = true;

        const observation = await repository.readSnapshotWithAuthorityGuard(group);
        const groupKey = groupStateGroupStorageKey(group);

        expect(runtime.batchReadCalls).toEqual([[
            {
                selectorId: 'group',
                kind: 'key',
                namespace: 'group-state:groups',
                key: groupKey,
            },
            {
                selectorId: 'members',
                kind: 'prefix',
                namespace: 'group-state:members',
                keyPrefix: `${groupKey}:`,
            },
            {
                selectorId: 'presence-summary',
                kind: 'key',
                namespace: 'group-state:presence-summaries',
                key: groupKey,
            },
            {
                selectorId: 'presence-sessions',
                kind: 'prefix',
                namespace: 'group-state:sessions',
                keyPrefix: `${groupKey}:`,
            },
        ]]);
        expect(observation).toEqual(expected);
        expect(observation?.snapshot.members).toEqual([owner]);
        expect(
            [...runtime.data.values()].some((entry) => entry.key === expiredMemberKey),
        ).toBe(true);
    });
});

type BatchReadSelector =
    | Readonly<{
        selectorId: string;
        kind: 'key';
        namespace: string;
        key: string;
    }>
    | Readonly<{
        selectorId: string;
        kind: 'prefix';
        namespace: string;
        keyPrefix: string;
    }>;

class BatchReadRuntimeStateRepository extends FakeRuntimeStateRepository {
    readonly runtimeStateReadBatchCapability = true as const;
    readonly runtimeStateReadBatchConsistency = 'single-database-snapshot' as const;
    readonly batchReadCalls: BatchReadSelector[][] = [];
    rejectLegacyReads = false;

    override findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        if (this.rejectLegacyReads) throw new Error('legacy findEntry called');
        return super.findEntry(namespace, key);
    }

    override findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        if (this.rejectLegacyReads) {
            throw new Error('legacy findEntriesByPrefix called');
        }
        return super.findEntriesByPrefix(namespace, keyPrefix);
    }

    async readRuntimeStateBatch(
        selectors: readonly BatchReadSelector[],
    ): Promise<readonly Readonly<{
        selectorId: string;
        entries: readonly RuntimeStateEntry[];
    }>[]> {
        this.batchReadCalls.push(selectors.map((selector) => ({ ...selector })));
        const snapshot = cloneRuntime(this);
        return await Promise.all(selectors.map(async (selector) => ({
            selectorId: selector.selectorId,
            entries: selector.kind === 'key'
                ? [await snapshot.findEntry(selector.namespace, selector.key)]
                    .filter((entry): entry is RuntimeStateEntry => entry !== undefined)
                : await snapshot.findEntriesByPrefix(
                    selector.namespace,
                    selector.keyPrefix,
                ),
        })));
    }
}

function cloneRuntime(
    source: FakeRuntimeStateRepository,
): FakeRuntimeStateRepository {
    const clone = new FakeRuntimeStateRepository();
    for (const [key, entry] of source.data) {
        clone.data.set(key, { ...entry });
    }
    return clone;
}

function fixture(): Readonly<{ group: Group; owner: GroupMember }> {
    const ref: GroupRef = {
        applicationId: 'authority-fence-app',
        workspaceId: 'authority-fence-workspace',
        groupId: 'authority-fence-room',
    };
    const audit = {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
    } satisfies Group['created'];
    return {
        group: {
            ...ref,
            slug: null,
            displayName: 'Authority fence room',
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: audit,
            updated: audit,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
        },
        owner: {
            ...ref,
            principalId: 'owner',
            role: 'owner',
            status: 'active',
            joined: audit,
            updated: audit,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
        },
    };
}
