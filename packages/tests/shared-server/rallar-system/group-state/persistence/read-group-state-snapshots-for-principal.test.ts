import {
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    GROUPS_NAMESPACE,
    MEMBERS_NAMESPACE
} from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupRole,
    GroupScope,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import { createTestGroup } from '../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const SCOPE: GroupScope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const NEVER_EXPIRES_MS = Number.MAX_SAFE_INTEGER;

class PrincipalReadRuntime extends FakeRuntimeStateRepository {
    readonly batches: (readonly RuntimeStateReadBatchSelector[])[] = [];
    afterBatch?: (selectors: readonly RuntimeStateReadBatchSelector[]) => Promise<boolean>;

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const scopePrefix = `${groupStateScopeStorageKey(SCOPE)}:`;
        if (
            selectors.some((selector) => selector.kind === 'prefix' && selector.keyPrefix === scopePrefix)
        ) {
            throw new Error('The principal read requested every group-state row in the scope');
        }
        this.batches.push(selectors);
        const selections = await super.readRuntimeStateBatch(selectors);
        if (this.afterBatch !== undefined && await this.afterBatch(selectors)) {
            this.afterBatch = undefined;
        }
        return selections;
    }
}

describe('group-state snapshots for a principal', () => {
    it('returns each active group of the principal with its full roster, in member key order', async () => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, {
            groupId: 'room-one',
            ownerId: 'alice',
            activeIds: ['bob'],
            leftIds: ['carol']
        });
        await seedGroup(groups, {
            groupId: 'room-two',
            ownerId: 'dave',
            activeIds: ['alice'],
            leftIds: []
        });
        await seedGroup(groups, {
            groupId: 'left-room',
            ownerId: 'mallory',
            activeIds: [],
            leftIds: ['alice']
        });
        await seedGroup(groups, {
            groupId: 'unrelated',
            ownerId: 'mallory',
            activeIds: ['erin'],
            leftIds: []
        });

        const snapshots = await groups.listSnapshotsForPrincipal(SCOPE, 'alice');

        expect(snapshots.map(toRoster)).toEqual([
            { groupId: 'room-one', members: ['alice:active', 'bob:active', 'carol:left'] },
            { groupId: 'room-two', members: ['alice:active', 'dave:active'] }
        ]);
        expect(runtime.batches.map((batch) => batch.map((selector) => selector.kind))).toEqual([
            ['prefix-suffix'],
            ['key', 'key'],
            ['prefix', 'key', 'prefix', 'prefix', 'key', 'prefix'],
            ['prefix-suffix'],
            ['key', 'key']
        ]);
    });

    it('omits memberships in another scope, expired member rows, and purged or expired groups', async () => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, { groupId: 'kept', ownerId: 'alice', activeIds: [], leftIds: [] });
        await seedGroup(groups, {
            groupId: 'purged',
            ownerId: 'alice',
            activeIds: [],
            leftIds: []
        });
        await seedGroup(groups, {
            groupId: 'expired',
            ownerId: 'alice',
            activeIds: [],
            leftIds: []
        });
        await seedGroup(groups, {
            groupId: 'expired-member',
            ownerId: 'alice',
            activeIds: [],
            leftIds: []
        });
        await seedGroup(groups, {
            groupId: 'kept',
            ownerId: 'alice',
            activeIds: [],
            leftIds: [],
            workspaceId: 'workspace-2'
        });
        await groups.removeGroup({ ...SCOPE, groupId: 'purged' });
        const expiredGroupKey = groupStateGroupStorageKey({ ...SCOPE, groupId: 'expired' });
        const expiredGroup = await runtime.findEntry(GROUPS_NAMESPACE, expiredGroupKey);
        await runtime.upsert(
            GROUPS_NAMESPACE,
            expiredGroupKey,
            requireValue(expiredGroup),
            Date.now() - 1
        );
        const expiredMemberKey = groupStateMemberStorageKey({
            ...SCOPE,
            groupId: 'expired-member',
            principalId: 'alice'
        });
        const expiredMember = await runtime.findEntry(MEMBERS_NAMESPACE, expiredMemberKey);
        await runtime.upsert(
            MEMBERS_NAMESPACE,
            expiredMemberKey,
            requireValue(expiredMember),
            Date.now() - 1
        );

        const snapshots = await groups.listSnapshotsForPrincipal(SCOPE, 'alice');

        expect(snapshots.map((snapshot) => snapshot.group)).toEqual([
            expect.objectContaining({ ...SCOPE, groupId: 'kept' })
        ]);
    });

    it('tolerates a corrupt group and a corrupt member row the principal does not belong to', async () => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, {
            groupId: 'room-one',
            ownerId: 'alice',
            activeIds: [],
            leftIds: []
        });
        await seedGroup(groups, {
            groupId: 'unrelated',
            ownerId: 'mallory',
            activeIds: ['erin'],
            leftIds: []
        });
        await runtime.upsert(
            GROUPS_NAMESPACE,
            groupStateGroupStorageKey({ ...SCOPE, groupId: 'unrelated' }),
            '{',
            NEVER_EXPIRES_MS
        );
        await runtime.upsert(
            MEMBERS_NAMESPACE,
            groupStateMemberStorageKey({ ...SCOPE, groupId: 'unrelated', principalId: 'erin' }),
            '{',
            NEVER_EXPIRES_MS
        );

        const snapshots = await groups.listSnapshotsForPrincipal(SCOPE, 'alice');

        expect(snapshots.map((snapshot) => snapshot.group.groupId)).toEqual(['room-one']);
    });

    it.each([
        [
            'member row',
            (): string => groupStateMemberStorageKey({ ...SCOPE, groupId: 'room-one', principalId: 'alice' }),
            MEMBERS_NAMESPACE
        ],
        [
            'live group row',
            (): string => groupStateGroupStorageKey({ ...SCOPE, groupId: 'room-one' }),
            GROUPS_NAMESPACE
        ],
        [
            'co-member child row',
            (): string => groupStateMemberStorageKey({ ...SCOPE, groupId: 'room-one', principalId: 'bob' }),
            MEMBERS_NAMESPACE
        ]
    ])('rejects a corrupt selected %s', async (_label, toStorageKey, namespace) => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, {
            groupId: 'room-one',
            ownerId: 'alice',
            activeIds: ['bob'],
            leftIds: []
        });
        await runtime.upsert(namespace, toStorageKey(), '{', NEVER_EXPIRES_MS);

        await expect(groups.listSnapshotsForPrincipal(SCOPE, 'alice')).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption',
            storageKey: toStorageKey()
        });
    });

    it('rejects a selected group row whose value names another group', async () => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, {
            groupId: 'room-one',
            ownerId: 'alice',
            activeIds: [],
            leftIds: []
        });
        const groupKey = groupStateGroupStorageKey({ ...SCOPE, groupId: 'room-one' });
        await runtime.upsert(
            GROUPS_NAMESPACE,
            groupKey,
            JSON.stringify(
                createTestGroup({ ...SCOPE, groupId: 'room-two', ownerPrincipalId: 'alice' })
            ),
            NEVER_EXPIRES_MS
        );

        await expect(groups.listSnapshotsForPrincipal(SCOPE, 'alice')).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption',
            storageKey: groupKey
        });
    });

    it('selects principal identifiers literally, whatever characters they encode', async () => {
        const { groups } = createRuntime();
        const principalIds = ['50%_off', '50ab25Xoff', 'a:b', 'ünï😀', 'ali', 'alice'];
        for (const [index, principalId] of principalIds.entries()) {
            await seedGroup(groups, {
                groupId: `room-${index}`,
                ownerId: principalId,
                activeIds: [],
                leftIds: []
            });
        }

        const selected = await Promise.all(
            principalIds.map(async (principalId) => (await groups.listSnapshotsForPrincipal(SCOPE, principalId)).map((snapshot) => snapshot.group.groupId))
        );

        expect(selected).toEqual(principalIds.map((_principalId, index) => [`room-${index}`]));
    });

    it('adds a group the principal joins after the first selection', async () => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, {
            groupId: 'joined-room',
            ownerId: 'mallory',
            activeIds: ['bob'],
            leftIds: []
        });
        runtime.afterBatch = async (selectors) => {
            if (selectors[0].kind !== 'prefix-suffix') {
                return false;
            }
            await groups.putMember(
                member({
                    groupId: 'joined-room',
                    principalId: 'alice',
                    role: 'member',
                    status: 'active'
                })
            );
            await bumpGroup(groups, 'joined-room', 1);
            return true;
        };

        const snapshots = await groups.listSnapshotsForPrincipal(SCOPE, 'alice');

        expect(snapshots.map(toRoster)).toEqual([
            { groupId: 'joined-room', members: ['alice:active', 'bob:active', 'mallory:active'] }
        ]);
    });

    it('drops a group the principal leaves after its children were read', async () => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, {
            groupId: 'left-room',
            ownerId: 'mallory',
            activeIds: ['alice'],
            leftIds: []
        });
        await seedGroup(groups, {
            groupId: 'kept-room',
            ownerId: 'alice',
            activeIds: [],
            leftIds: []
        });
        runtime.afterBatch = async (selectors) => {
            if (!selectors.some((selector) => selector.selectorId.startsWith('members:'))) {
                return false;
            }
            await groups.putMember(
                member({
                    groupId: 'left-room',
                    principalId: 'alice',
                    role: 'member',
                    status: 'left'
                })
            );
            await bumpGroup(groups, 'left-room', -1);
            return true;
        };

        const snapshots = await groups.listSnapshotsForPrincipal(SCOPE, 'alice');

        expect(snapshots.map((snapshot) => snapshot.group.groupId)).toEqual(['kept-room']);
    });

    it('assembles again from current authority when the group or the member revision moved', async () => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, {
            groupId: 'grown-room',
            ownerId: 'alice',
            activeIds: [],
            leftIds: []
        });
        await seedGroup(groups, {
            groupId: 'promoted-room',
            ownerId: 'mallory',
            activeIds: ['alice'],
            leftIds: []
        });
        runtime.afterBatch = async (selectors) => {
            if (!selectors.some((selector) => selector.selectorId.startsWith('members:'))) {
                return false;
            }
            await groups.putMember(
                member({
                    groupId: 'grown-room',
                    principalId: 'erin',
                    role: 'member',
                    status: 'active'
                })
            );
            await bumpGroup(groups, 'grown-room', 1);
            await groups.putMember(
                member({
                    groupId: 'promoted-room',
                    principalId: 'alice',
                    role: 'admin',
                    status: 'active'
                })
            );
            return true;
        };

        const snapshots = await groups.listSnapshotsForPrincipal(SCOPE, 'alice');

        expect(snapshots.map(toRoster)).toEqual([
            { groupId: 'grown-room', members: ['alice:active', 'erin:active'] },
            { groupId: 'promoted-room', members: ['alice:active', 'mallory:active'] }
        ]);
        expect(snapshots[1].members.find((entry) => entry.principalId === 'alice')?.role).toBe(
            'admin'
        );
    });

    it('reuses the children read when neither the group nor the member revision moved', async () => {
        const { runtime, groups } = createRuntime();
        await seedGroup(groups, {
            groupId: 'room-one',
            ownerId: 'alice',
            activeIds: ['bob'],
            leftIds: []
        });

        const [snapshot] = await groups.listSnapshotsForPrincipal(SCOPE, 'alice');

        expect(snapshot.group.groupId).toBe('room-one');
        expect(runtime.batches).toHaveLength(5);
    });
});

interface SeedGroupInput {
    readonly groupId: string;
    readonly ownerId: string;
    readonly activeIds: readonly string[];
    readonly leftIds: readonly string[];
    readonly workspaceId?: string;
}

interface MemberInput {
    readonly groupId: string;
    readonly principalId: string;
    readonly role: GroupRole;
    readonly status: 'active' | 'left';
    readonly workspaceId?: string;
}

function createRuntime() {
    const runtime = new PrincipalReadRuntime();
    return { runtime, groups: createTestGroupStateRepository(runtime) };
}

async function seedGroup(
    groups: ReturnType<typeof createTestGroupStateRepository>,
    input: SeedGroupInput
): Promise<void> {
    const workspaceId = input.workspaceId ?? SCOPE.workspaceId;
    await groups.putGroup(createTestGroup({
        applicationId: SCOPE.applicationId,
        workspaceId,
        groupId: input.groupId,
        ownerPrincipalId: input.ownerId,
        activeMemberCount: input.activeIds.length + 1,
        snapshotVersion: 1,
        rosterVersion: 1
    }));
    await groups.putMember(
        member({
            groupId: input.groupId,
            principalId: input.ownerId,
            role: 'owner',
            status: 'active',
            workspaceId
        })
    );
    for (const principalId of input.activeIds) {
        await groups.putMember(
            member({
                groupId: input.groupId,
                principalId,
                role: 'member',
                status: 'active',
                workspaceId
            })
        );
    }
    for (const principalId of input.leftIds) {
        await groups.putMember(
            member({
                groupId: input.groupId,
                principalId,
                role: 'member',
                status: 'left',
                workspaceId
            })
        );
    }
}

async function bumpGroup(
    groups: ReturnType<typeof createTestGroupStateRepository>,
    groupId: string,
    activeMemberDelta: number
): Promise<void> {
    const group = await groups.findGroup({ ...SCOPE, groupId });
    if (group === undefined) {
        throw new Error(`Expected group ${groupId} before the concurrent write`);
    }
    await groups.putGroup({
        ...group,
        activeMemberCount: group.activeMemberCount + activeMemberDelta,
        snapshotVersion: group.snapshotVersion + 1,
        rosterVersion: group.rosterVersion + 1
    });
}

function member(input: MemberInput): GroupMember {
    const common = {
        applicationId: SCOPE.applicationId,
        workspaceId: input.workspaceId ?? SCOPE.workspaceId,
        groupId: input.groupId,
        principalId: input.principalId,
        role: input.role,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        joined: audit(),
        removed: null,
        banned: null,
        updated: audit()
    };
    return input.status === 'active'
        ? { ...common, status: 'active', left: null }
        : { ...common, status: 'left', left: audit() };
}

function toRoster(
    snapshot: GroupSnapshot
): Readonly<{ groupId: string; members: readonly string[]; }> {
    return {
        groupId: snapshot.group.groupId,
        members: snapshot.members.map((entry) => `${entry.principalId}:${entry.status}`).sort()
    };
}

function requireValue(entry: Readonly<{ value: string; }> | undefined): string {
    if (entry === undefined) {
        throw new Error('Expected a seeded runtime-state row');
    }
    return entry.value;
}

function audit(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
