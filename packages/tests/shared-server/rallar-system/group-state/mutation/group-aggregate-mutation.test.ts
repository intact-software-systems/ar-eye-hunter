import {
    describe,
    expect,
    it
} from 'vitest';

import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationCommand, GroupMutationFacts } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { assertGroupMutationOperationReads } from '@shared-server/rallar-system/group-state/mutation/state-validation/assert-group-mutation-operation-reads.ts';
import { assertGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/assert-group-mutation.ts';

import type { CreateGroupRequest } from '@shared/api/state-types.ts';
import {
    createMutationCommand,
    createMutationFacts,
    createMutationRead
} from '../group-state-concurrency-test-fixtures.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { createService } from '../presence/group-presence-test-runtime.ts';
import { createGroupAuthorityRead, SCOPE, transitionCommand } from './group-mutation-test-runtime.ts';
import {
    computeDescriptorMutation,
    GRANT_ROOM,
    readGrantRow,
    requireWrite,
    toTopicGrants
} from './group-publication-grant-test-runtime.ts';

describe('group aggregate mutation computation', () => {
    it('keeps pure mutation computation synchronous, deterministic, and input preserving', () => {
        const command = deepFreeze(createMutationCommand());
        const read = deepFreeze(createMutationRead());
        const facts = deepFreeze(createMutationFacts());

        const first = computeGroupMutation({ command, read, facts });
        const second = computeGroupMutation({ command, read, facts });
        assertGroupMutation({ command, read, facts, computed: first });
        assertGroupMutation({ command, read, facts, computed: second });

        expect(first).toEqual(second);
        expect(command).toEqual(createMutationCommand());
        expect(read).toEqual(createMutationRead());
    });

    it('binds resolved join-code facts to the command operation and explicit intent', () => {
        const read = createMutationRead();
        const update = createMutationCommand();
        const explicitRotate = createMutationCommand({
            operation: 'rotateGroupJoinCode',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                joinCode: 'EXPLICIT',
                expiresAtEpochMs: null
            }
        });
        const omittedRotate = createMutationCommand({
            operation: 'rotateGroupJoinCode',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                joinCode: null,
                expiresAtEpochMs: null
            }
        });
        const codeFacts: GroupMutationFacts = {
            ...createMutationFacts(),
            resolvedJoinCode: 'OTHER',
            joinCodeVerifier: 'verifier'
        };

        expect(() => computeGroupMutation({ command: update, read, facts: codeFacts })).toThrow(
            /resolved.*join code|operation|unrelated/i
        );
        expect(() =>
            computeGroupMutation({
                command: explicitRotate,
                read: { ...read, activeMemberPrincipalIds: null, activeMembers: null },
                facts: codeFacts
            })
        ).toThrow(/resolved.*join code|explicit|command/i);
        expect(() =>
            computeGroupMutation({
                command: omittedRotate,
                read: { ...read, activeMemberPrincipalIds: null, activeMembers: null },
                facts: createMutationFacts()
            })
        ).toThrow(/resolved.*join code|generated|missing/i);
    });
});

describe('group mutation roster read contract', () => {
    const actor = { actorPrincipalId: 'alice', actorSessionId: 'alice-session', reason: null };
    const identity = { aggregateRef: createMutationCommand().aggregateRef, commandId: 'read', requestId: 'read' };
    const countOnlyCommands: readonly GroupMutationCommand[] = [
        createMutationCommand(),
        { ...identity, operation: 'joinGroup', targetPrincipalId: 'bob', input: { ...actor, participation: null, inviteToken: null, joinCode: null } },
        { ...identity, operation: 'acceptGroupInvite', targetPrincipalId: 'bob', input: { ...actor, participation: null, inviteToken: null, joinCode: null } },
        {
            ...identity,
            operation: 'upsertMember',
            targetPrincipalId: 'bob',
            input: { ...actor, role: null, status: 'active', invitedByPrincipalId: null, invitationExpiresAtEpochMs: null }
        },
        { ...identity, operation: 'setGroupMemberRole', targetPrincipalId: 'bob', input: { ...actor, role: 'spectator' } },
        { ...identity, operation: 'transferGroupOwnership', targetPrincipalId: 'bob', input: actor }
    ];
    const electorateCommands: readonly GroupMutationCommand[] = [
        transitionCommand('activateGroup'),
        transitionCommand('reconfigureGroup'),
        transitionCommand('failGroupFormation'),
        transitionCommand('planGroupLayout'),
        transitionCommand('connectGroup'),
        transitionCommand('startGroupFormation'),
        transitionCommand('resetGroupFormation'),
        { ...identity, operation: 'pauseGroupTransport', input: actor },
        { ...identity, operation: 'resumeGroupTransport', input: actor },
        { ...identity, operation: 'grantGroupAdmission', targetPrincipalId: 'bob', input: actor },
        { ...identity, operation: 'declineGroupAdmission', targetPrincipalId: 'bob', input: actor }
    ];

    it.each(countOnlyCommands)('$operation accepts complete member facts without electorate IDs', (command) => {
        const read = createGroupAuthorityRead({});
        expect(() =>
            assertGroupMutationOperationReads({
                ...read,
                lifecyclePolicy: command.operation === 'updateGroup' ? null : read.lifecyclePolicy,
                activeMemberPrincipalIds: null
            }, command)
        ).not.toThrow();
    });

    it.each(electorateCommands)('$operation rejects a missing electorate ID list', (command) => {
        const read = createGroupAuthorityRead({});
        expect(() =>
            assertGroupMutationOperationReads({
                ...read,
                activeMemberPrincipalIds: null
            }, command)
        ).toThrow(/missing the active member principal ids/);
    });

    it('validates every count-only member row even without electorate IDs', () => {
        const read = createMutationRead();
        const member = read.actorMember;
        if (member === null || member.status !== 'active') {
            throw new Error('Expected the active fixture actor');
        }
        const command = createMutationCommand();
        const facts = { ...read, activeMemberPrincipalIds: null };
        expect(() => assertGroupMutationOperationReads({ ...facts, activeMembers: null }, command)).toThrow();
        expect(() => assertGroupMutationOperationReads({ ...facts, activeMembers: [member, member] }, command)).toThrow(/duplicate/);
        expect(() => assertGroupMutationOperationReads({ ...facts, activeMembers: [{ ...member, groupId: 'other-room' }] }, command)).toThrow(/scope|group/i);
        expect(() => assertGroupMutationOperationReads({ ...facts, activeMembers: [{ ...member, status: 'left', left: member.updated }] }, command)).toThrow(
            /inactive/
        );
        expect(() =>
            assertGroupMutationOperationReads({
                ...facts,
                // @ts-expect-error Malformed JavaScript input must not masquerade as an empty roster.
                activeMembers: ''
            }, command)
        ).toThrow();
    });

    it('rejects unrelated IDs and preserves electorate identity equality', () => {
        const read = createGroupAuthorityRead({});
        expect(() => assertGroupMutationOperationReads({ ...read, lifecyclePolicy: null }, createMutationCommand())).toThrow(
            /must not carry active member principal ids/
        );
        expect(() => assertGroupMutationOperationReads({ ...read, activeMemberPrincipalIds: ['other'] }, transitionCommand('startGroupFormation'))).toThrow(
            /identities differ/
        );
    });
});

describe('group creation with a declared publication grant', () => {
    const createRequest = (publicationGrants?: CreateGroupRequest['publicationGrants']): CreateGroupRequest => ({
        groupId: GRANT_ROOM,
        displayName: GRANT_ROOM,
        kind: 'room',
        createdByPrincipalId: 'alice',
        requestId: 'create-grant-room-declared',
        ...(publicationGrants === undefined ? {} : { publicationGrants })
    });

    it('create with publicationGrants writes the creator\'s row in the create batch; absent or {} writes none', async () => {
        const declared = { 'room.feed': { publish: true, subscribe: true } };
        const runtime = new GroupBarrierRepository();
        const { computed } = await computeDescriptorMutation(
            runtime,
            'alice',
            mutationDescriptor({ operation: 'createGroup', scope: SCOPE, groupId: GRANT_ROOM, request: createRequest(declared) })
        );
        const write = requireWrite(computed);
        const createStamp = write.guard.kind === 'group' ? write.guard.value.created : null;
        const created = (await createService(runtime, 3_000).createGroup(SCOPE, createRequest(declared))).result;

        expect(write.publicationGrantEffects).toEqual([
            { operation: 'insert', value: { ...GRANT_ROOM_REF, principalId: 'alice', topics: declared, updated: createStamp } }
        ]);
        expect(write.persistence.guardedBatch.effects.map((effect) => effect.effectId)).toContain('publication-grant:alice');
        expect(await readGrantRow(runtime, 'alice')).toMatchObject({ topics: declared, updated: created.snapshot.group.created });
        expect(created.snapshot.publicationGrants).toEqual([await readGrantRow(runtime, 'alice')]);
        for (const publicationGrants of [undefined, {}]) {
            const empty = new GroupBarrierRepository();
            const { result } = await createService(empty, 3_000).createGroup(SCOPE, createRequest(publicationGrants));
            expect(await readGrantRow(empty, 'alice')).toBeUndefined();
            expect(result.snapshot.publicationGrants).toEqual([]);
        }
    });

    it('create refuses a 65-topic or both-false declaration', async () => {
        for (
            const publicationGrants of [
                toTopicGrants(65),
                { 'room.feed': { publish: false, subscribe: false } },
                { feed: { publish: true, subscribe: true } }
            ]
        ) {
            const runtime = new GroupBarrierRepository();
            await expect(createService(runtime, 3_000).createGroup(SCOPE, createRequest(publicationGrants))).rejects
                .toBeInstanceOf(TypeError);
            expect(await readGrantRow(runtime, 'alice')).toBeUndefined();
        }
    });
});

const GRANT_ROOM_REF = { ...SCOPE, groupId: GRANT_ROOM };

function deepFreeze<T>(value: T): T {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}
