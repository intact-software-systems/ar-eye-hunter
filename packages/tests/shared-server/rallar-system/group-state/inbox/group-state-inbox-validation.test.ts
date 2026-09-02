import { describe, expect, it } from 'vitest';

import { classifyAppInboxError } from '@shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts';
import { toFormationActivateCommand } from '@shared-server/rallar-system/group-state/group-formation-mutation-command.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import {
    computeGroupStateInboxMutation,
    validateGroupStateInboxMutation,
    type ComputeGroupStateInboxMutationInput
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { validateGroupMutationAuthority } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-authority.ts';
import { validateGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { validateComputedRosterFacts } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-computed-roster-facts.ts';
import { validateGroupMutationFacts } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation-facts.ts';
import { validateGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { toApplyPlannedLayoutCommand } from '@shared-server/rallar-system/group-state/to-apply-planned-layout-command.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupPresenceAdmission, GroupPresenceSession } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    createGroupAuthorityFacts,
    createGroupAuthorityRead
} from '../mutation/group-mutation-test-runtime.ts';
import { createAuthorityHarness, createResilience, createRoom, SCOPE } from './group-state-inbox-test-runtime.ts';

describe('group mutation validation issues', () => {
    it('collects malformed command fields without skipping independent fields', async () => {
        const input = await readUpdateInput();
        const command = {
            ...input.command.command,
            input: { ...input.command.command.input, displayName: '', maxMembers: 0 }
        };

        expect(validateGroupMutationCommand(command)).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('displayName') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('maxMembers') }) })
        ]));
    });

    it('keeps malformed command issues terminal HTTP 400 at the validation boundary', async () => {
        const input = await readUpdateInput();
        if (input.command.command.operation !== 'updateGroup') {
            throw new Error('Expected update command fixture');
        }
        const command = {
            ...input.command.command,
            input: { ...input.command.command.input, displayName: '', maxMembers: 0 }
        };
        const computed = computeGroupMutation({
            command: input.command.command,
            read: input.read,
            facts: input.command.facts
        });
        const failure = validateGroupMutation({
            command,
            read: input.read,
            facts: input.command.facts,
            computed
        })[0]?.cause;

        expect(failure).toBeInstanceOf(TypeError);
        expect(classifyAppInboxError(failure)).toMatchObject({
            kind: 'terminal',
            code: 'app-inbox-malformed-command',
            result: { status: 400, code: 'app-inbox-malformed-command' }
        });
    });

    it('collects independent scalar fact issues at their canonical owner', async () => {
        const input = await readUpdateInput();
        const facts = { ...input.command.facts, attemptCount: 0, serviceId: '', eventId: '' };

        expect(validateGroupMutationFacts(facts)).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('attemptCount') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('serviceId') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('eventId') }) })
        ]));
    });

    it('collects lifecycle criteria and layout fence errors independently', async () => {
        const input = await readUpdateInput();
        const command = {
            ...input.command.command,
            operation: 'activateGroup',
            input: {
                actorPrincipalId: 'owner',
                actorSessionId: 'owner-session',
                reason: null,
                traceId: null,
                observedRate: 2,
                degraded: 'yes',
                expectedFormationEpoch: -1,
                expectedLayout: { groupRevision: -1, presenceRevision: -1, version: -1, state: 'unknown' }
            }
        };

        const issues = validateGroupMutationCommand(command);

        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('observedRate') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('degraded') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('expectedFormationEpoch') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('groupRevision') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('presenceRevision') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('version') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('state') }) })
        ]));
    });

    it('reports independent invalid facts together without throwing or changing the candidate', async () => {
        const input = await readUpdateInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const before = JSON.stringify(computed);
        const facts = { ...input.command.facts, attemptCount: 0, serviceId: '', eventId: '' };

        const issues = validateGroupMutation({ command: input.command.command, read: input.read, facts, computed });

        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('attemptCount') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('serviceId') }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('eventId') }) })
        ]));
        expect(JSON.stringify(computed)).toBe(before);
    });

    it('collects malformed original read branches without throwing and still reports invalid facts', async () => {
        const input = await readUpdateInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const read = structuredClone(input.read);
        if (read.group === null) {
            throw new Error('Expected existing group');
        }
        Object.assign(read.group, { value: null });
        Object.assign(read, { authorityPresenceSessions: null, authorityPresenceSessionEntries: null });

        const issues = validateGroupMutation({
            command: input.command.command,
            read,
            facts: { ...input.command.facts, serviceId: '' },
            computed
        });

        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Stored group value must be an object' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Authority presence sessions must be arrays' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Group mutation serviceId must be a non-empty string' }) })
        ]));
    });

    it('rejects non-record original read slots as issues instead of interpreting them as absence', async () => {
        const input = await readUpdateInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const read = { ...input.read };
        Object.assign(read, { group: false, actorMember: false, actorMemberEntry: false });

        const issues = validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed });

        expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['read.group', 'read.actorMember', 'read.actorMemberEntry']));
    });

    it('collects invalid stored authority session identities before deriving storage keys', async () => {
        const input = await readUpdateInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        if (input.read.group === null) {
            throw new Error('Expected existing group');
        }
        const read = { ...input.read };
        Object.assign(read, {
            authorityPresenceSessions: [{ sessionId: null }],
            authorityPresenceSessionEntries: [{ entry: input.read.group.entry, value: { sessionId: null } }]
        });

        const issues = validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed });

        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Stored authority presence sessionId must be a non-empty string' }) })
        ]));
    });

    it('returns the original policy denial as an issue when recomputing a candidate against non-admin read facts', async () => {
        const input = await readUpdateInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const read = structuredClone(input.read);
        if (read.actorMember === null || read.actorMemberEntry === null) {
            throw new Error('Expected actor member');
        }
        Object.assign(read.actorMember, { role: 'member' });
        Object.assign(read.actorMemberEntry.value, { role: 'member' });
        for (const stored of [read.actorMemberEntry, read.targetMemberEntry, read.authorityMemberEntry]) {
            if (stored !== null) {
                Object.assign(stored.entry, { value: JSON.stringify(stored.value) });
            }
        }

        const issues = validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed });

        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Forbidden: Only active group owners/admins can update groups.' }) })
        ]));
        const cause = issues[0].cause;
        expect(cause).toBeInstanceOf(GroupPolicyDeniedError);
        expect(cause).toMatchObject({
            status: 403,
            denial: { allowed: false, code: 'forbidden-role', message: 'Only active group owners/admins can update groups.' }
        });
        expect(classifyAppInboxError(cause)).toMatchObject({ kind: 'terminal', result: { status: 403 } });
    });

    it('keeps a recorded replay valid after update authority is revoked', async () => {
        const input = await readUpdateInput();
        const written = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const read = structuredClone(input.read);
        if (written.outcome !== 'write' || written.idempotency === null || read.group === null) {
            throw new Error('Expected a recorded update candidate');
        }
        Object.assign(read, {
            actorMember: null,
            actorMemberEntry: null,
            idempotency: {
                entry: {
                    ...read.group.entry,
                    key: groupStateIdempotencyStorageKey(input.command.command.aggregateRef, input.command.command.commandId),
                    value: JSON.stringify(written.idempotency)
                },
                value: written.idempotency
            }
        });
        const replay = computeGroupMutation({ command: input.command.command, read, facts: input.command.facts });
        expect(replay.outcome).toBe('replay');

        expect(validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed: replay })).toEqual([]);
        expect(replay).toMatchObject({ receipt: written.receipt });
    });

    it('collects the original join-code governance denial before canonical recomputation', async () => {
        const input = await readJoinCodeInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const read = structuredClone(input.read);
        if (read.actorMember === null || read.actorMemberEntry === null) {
            throw new Error('Expected actor member');
        }
        Object.assign(read.actorMember, { role: 'member' });
        Object.assign(read.actorMemberEntry.value, { role: 'member' });
        for (const stored of [read.actorMemberEntry, read.targetMemberEntry, read.authorityMemberEntry]) {
            if (stored !== null) {
                Object.assign(stored.entry, { value: JSON.stringify(stored.value) });
            }
        }

        const issues = validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed });

        expect(issues[0].cause).toBeInstanceOf(GroupPolicyDeniedError);
        expect(issues[0].cause).toMatchObject({
            message: 'Forbidden: Only active group owners/admins can govern group members.',
            status: 403,
            denial: { allowed: false, code: 'forbidden-role' }
        });
        expect(classifyAppInboxError(issues[0].cause)).toMatchObject({ kind: 'terminal', result: { status: 403 } });
    });

    it.each(['missing-default', 'missing-verifier'] as const)(
        'rejects join-code %s from the original command/facts without escaping recomputation',
        async (failure) => {
            const input = await readJoinCodeInput();
            const command = structuredClone(input.command.command);
            if (failure === 'missing-default') {
                Object.assign(command.input, { joinCode: null });
            }
            const computed = computeGroupMutation({ command, read: input.read, facts: input.command.facts });
            const facts = { ...input.command.facts, resolvedJoinCode: null, joinCodeVerifier: null };
            const message = 'Group rotate mutation is missing its generated join code facts';
            const issues = validateGroupMutation({ command, read: input.read, facts, computed });

            expect(issues.length).toBeGreaterThan(0);
            expect(issues[0].cause.message).toBe(message);
        }
    );

    it('collects the original update capacity rejection before canonical recomputation', async () => {
        const input = await readUpdateInput();
        const read = structuredClone(input.read);
        if (read.group === null || input.command.command.operation !== 'updateGroup') {
            throw new Error('Expected an existing group update');
        }
        Object.assign(read.group.value, { activeMemberCount: 2 });
        Object.assign(read.group.entry, { value: JSON.stringify(read.group.value) });
        const computed = computeGroupMutation({ command: input.command.command, read, facts: input.command.facts });
        const command = { ...input.command.command, input: { ...input.command.command.input, maxMembers: 1 } };

        const issues = validateGroupMutation({ command, read, facts: input.command.facts, computed });

        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                cause: expect.objectContaining({ name: 'GroupMutationRejectedError', message: 'Group maxMembers cannot be lower than activeMemberCount.' })
            })
        ]));
        expect(classifyAppInboxError(issues[0].cause)).toMatchObject({ kind: 'terminal', result: { status: 400, code: 'group-mutation-rejected' } });
    });

    it.each(['planGroupLayout', 'pauseGroupTransport', 'createGroupInvite'] as const)(
        'collects revoked %s authority from original reads without escaping recomputation',
        async (operation) => {
            const input = await readGovernedInput(operation);
            const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
            const read = {
                ...input.read,
                actorMember: null,
                actorMemberEntry: null,
                targetMember: null,
                targetMemberEntry: null,
                authorityMember: null,
                authorityMemberEntry: null,
                directorMember: null,
                directorMemberEntry: null
            };

            const issues = validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed });

            const classification = classifyAppInboxError(issues[0].cause);
            expect(classification).toMatchObject({ kind: 'terminal' });
            if (classification.kind !== 'terminal') {
                throw new Error('Expected terminal validation classification');
            }
            expect([400, 403]).toContain(classification.result.status);
        }
    );

    it.each(['lifecyclePolicy', 'plannedLayoutRow', 'acceptedLayoutRow'] as const)(
        'collects a malformed nested %s original read before canonical recomputation',
        async (field) => {
            const input = await readPublicationInput();
            const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
            const read = structuredClone(input.read);
            Object.assign(read, {
                [field]: field === 'lifecyclePolicy'
                    ? { status: 'present', policy: { topology: null } }
                    : { snapshot: null, revision: 1 }
            });

            const issues = validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed });

            expect(issues.some((issue) => issue.path.startsWith(`read.${field}`))).toBe(true);
            expect(issues.every((issue) => issue.cause instanceof TypeError)).toBe(true);
        }
    );

    it('collects a banned invite target denial from original membership reads', async () => {
        const input = await readGovernedInput('createGroupInvite');
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const actor = input.read.actorMemberEntry;
        if (actor === null) {
            throw new Error('Expected owner member entry');
        }
        const member = {
            ...actor.value,
            principalId: 'invitee',
            role: 'member' as const,
            status: 'banned' as const,
            left: null,
            removed: null,
            banned: actor.value.updated
        };
        const read = {
            ...input.read,
            targetMember: member,
            targetMemberEntry: {
                entry: { ...actor.entry, key: groupStateMemberStorageKey(member), value: JSON.stringify(member) },
                value: member
            }
        };

        const issues = validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed });

        expect(issues[0].cause).toMatchObject({ name: 'GroupMutationRejectedError', message: 'Cannot invite a banned group member.' });
    });

    it.each(
        [
            { operation: 'setGroupMemberRole', change: 'missing-target', message: 'Group member not found: invitee' },
            { operation: 'setGroupMemberRole', change: 'admin-actor', message: 'Group admins cannot grant the admin role.' },
            { operation: 'transferGroupOwnership', change: 'missing-target', message: 'Ownership target must be active.' },
            { operation: 'upsertMember', change: 'admin-actor', message: 'Group admins cannot grant the admin role.' },
            { operation: 'setGroupMemberRole', change: 'last-owner', message: 'Forbidden: Cannot remove or demote the last active owner.' }
        ] as const
    )('collects $operation $change denial with the original first cause', async ({ operation, change, message }) => {
        const input = await readMembershipInput(operation);
        const command = input.command.command;
        const facts = input.command.facts;
        const computed = computeGroupMutation({ command, read: input.read, facts });
        expect(validateGroupMutation({ command, read: input.read, facts, computed })).toEqual([]);
        const read = structuredClone(input.read);
        if (change === 'missing-target') {
            Object.assign(read, { targetMember: null, targetMemberEntry: null });
        }
        else if (change === 'admin-actor') {
            changeMembershipReadRole(read, 'owner', 'admin');
        }
        else {
            changeMembershipReadRole(read, 'invitee', 'owner');
            if (read.group === null) {
                throw new Error('Expected membership group');
            }
            Object.assign(read.group.value, { ownerPrincipalId: 'invitee' });
            Object.assign(read.group.entry, { value: JSON.stringify(read.group.value) });
            Object.assign(read, { authorityMember: read.targetMember, authorityMemberEntry: read.targetMemberEntry });
        }

        const issues = validateGroupMutation({ command, read, facts, computed });

        const denial = issues.find((issue) => issue.cause.message === message);
        expect(denial).toBeDefined();
        expect(classifyAppInboxError(denial?.cause)).toMatchObject({
            kind: 'terminal',
            result: { status: change === 'last-owner' ? 403 : 400 }
        });
    });

    it.each(['missing', 'archived'] as const)('collects a %s publication predecessor without escaping recomputation', async (state) => {
        const input = await readPublicationInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const read = structuredClone(input.read);
        if (read.group === null) {
            throw new Error('Expected existing publication group');
        }
        if (state === 'missing') {
            Object.assign(read, { group: null });
        }
        else {
            Object.assign(read.group.value, { status: 'archived', archived: read.group.value.updated });
            Object.assign(read.group.entry, { value: JSON.stringify(read.group.value) });
        }

        const issues = validateGroupMutation({ command: input.command.command, read, facts: input.command.facts, computed });

        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0].cause).toBeInstanceOf(
            state === 'missing' ? GroupMutationRejectedError : GroupPolicyDeniedError
        );
    });

    it('collects a self-upsert role change and retains the original rejection', async () => {
        const input = await readMembershipInput('upsertMember', 'invitee');
        const command = input.command.command;
        const facts = input.command.facts;
        const computed = computeGroupMutation({ command, read: input.read, facts });
        expect(validateGroupMutation({ command, read: input.read, facts, computed })).toEqual([]);
        const read = structuredClone(input.read);
        changeMembershipReadRole(read, 'invitee', 'admin');

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues[0].cause.message).toBe('Self upsert cannot change role.');
    });

    it('collects an unreadable admission policy from original join reads', async () => {
        const input = await readMembershipInput('joinGroup', 'invitee');
        const command = input.command.command;
        const facts = input.command.facts;
        const computed = computeGroupMutation({ command, read: input.read, facts });
        expect(validateGroupMutation({ command, read: input.read, facts, computed })).toEqual([]);
        const read = { ...input.read, lifecyclePolicy: { status: 'corrupt' as const, reason: 'invalid stored admission' } };

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues[0].cause.message).toBe('Group lifecycle policy is unreadable: invalid stored admission');
    });

    it.each(
        [
            { operation: 'connectPresence', change: 'missing-member', message: 'Forbidden: active group member required for presence: owner' },
            { operation: 'connectPresence', change: 'reused-generation', message: 'A generationId cannot be reused with a different connectedAtEpochMs.' },
            { operation: 'connectPresence', change: 'future-connection', message: 'Group presence connectedAtEpochMs is too far in the future.' },
            { operation: 'connectPresence', change: 'inconsistent-connection', message: 'Presence connection timestamps are causally inconsistent.' },
            { operation: 'connectPresence', change: 'admission-cap', message: 'Forbidden: Group member session capacity has been reached.' },
            { operation: 'heartbeatPresence', change: 'missing-session', message: 'Group presence session not found: owner-session' },
            { operation: 'heartbeatPresence', change: 'expired-lease', message: 'Presence heartbeat expiry must not predate the heartbeat.' },
            { operation: 'heartbeatPresence', change: 'future-heartbeat', message: 'Group presence lastHeartbeatAtEpochMs is too far in the future.' },
            { operation: 'disconnectPresence', change: 'missing-session', message: 'Group presence session not found: owner-session' },
            { operation: 'appointDirector', change: 'missing-member', message: 'Forbidden: Cannot confirm local room membership yet.' },
            { operation: 'appointDirector', change: 'missing-session', message: 'Forbidden: Only active room members can appoint the browser director.' }
        ] as const
    )('collects $operation $change from valid original read facts', async ({ operation, change, message }) => {
        const input = await readPresenceInput(operation);
        const command = structuredClone(input.command.command);
        if (change === 'future-connection' || change === 'inconsistent-connection') {
            Object.assign(command.input, { connectedAtEpochMs: null, generationId: 'generation-1' });
        }
        const originalFacts = input.command.facts;
        if (change === 'future-heartbeat' && input.read.targetPresence !== null) {
            Object.assign(input.read.targetPresence.value, { lastHeartbeatAtEpochMs: originalFacts.nowEpochMs });
            Object.assign(input.read.targetPresence.entry, { value: JSON.stringify(input.read.targetPresence.value) });
        }
        if (change === 'missing-session' && operation === 'heartbeatPresence' && input.read.targetPresence !== null) {
            Object.assign(command.input, { lastHeartbeatAtEpochMs: input.read.targetPresence.value.lastHeartbeatAtEpochMs });
        }
        if (change === 'missing-session' && operation === 'disconnectPresence' && input.read.targetPresence !== null) {
            Object.assign(input.read.targetPresence.value, {
                status: 'disconnected',
                disconnectedAtEpochMs: originalFacts.nowEpochMs,
                disconnectReason: 'closed'
            });
            Object.assign(input.read.targetPresence.entry, { value: JSON.stringify(input.read.targetPresence.value) });
        }
        const computed = computeGroupMutation({ command, read: input.read, facts: originalFacts });
        expect(validateGroupMutation({ command, read: input.read, facts: originalFacts, computed })).toEqual([]);
        const read = structuredClone(input.read);
        changePresencePolicyRead(read, change, originalFacts.nowEpochMs);
        const facts = change === 'future-heartbeat' ? { ...originalFacts, nowEpochMs: originalFacts.nowEpochMs - 300_001 } : originalFacts;

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues.map((issue) => issue.cause.message)).toContain(message);
    });

    it.each(
        [
            { mode: 'closed', message: 'Forbidden: Group admission is closed outside formation.' },
            { mode: 'deadline', message: 'Forbidden: Group admission closed at its deadline.' },
            { mode: 'member-cap', message: 'Forbidden: Group admission closed at its member-count limit.' }
        ] as const
    )('collects admission $mode from a valid original join read', async ({ mode, message }) => {
        const input = await readMembershipInput('joinGroup', 'invitee');
        const command = input.command.command;
        const facts = input.command.facts;
        const computed = computeGroupMutation({ command, read: input.read, facts });
        const policy = createDefaultGroupLifecyclePolicy();
        const read = {
            ...input.read,
            lifecyclePolicy: {
                status: 'present' as const,
                policy: {
                    ...policy,
                    admission: {
                        ...policy.admission,
                        mode: mode === 'closed' ? 'closed' as const : 'open' as const,
                        untilEpochMs: mode === 'deadline' ? facts.nowEpochMs : null,
                        untilMemberCount: mode === 'member-cap' ? 1 : null
                    }
                }
            }
        };

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues.map((issue) => issue.cause.message)).toContain(message);
    });

    it('collects an exhausted member admission fence before recomputation', async () => {
        const input = await readMembershipInput('upsertMember', 'invitee');
        const command = input.command.command;
        const facts = input.command.facts;
        if (input.read.group === null) {
            throw new Error('Expected membership group');
        }
        const admission: GroupPresenceAdmission = {
            ...command.aggregateRef,
            principalId: 'invitee',
            admittedSessions: [],
            updatedAtEpochMs: facts.nowEpochMs - 1
        };
        const original = {
            ...input.read,
            targetAdmission: {
                entry: { ...input.read.group.entry, key: groupStatePresenceAdmissionStorageKey(admission), value: JSON.stringify(admission) },
                value: admission
            }
        };
        const computed = computeGroupMutation({ command, read: original, facts });
        const read = structuredClone(original);
        Object.assign(read.targetAdmission.value, { updatedAtEpochMs: Number.MAX_SAFE_INTEGER });
        Object.assign(read.targetAdmission.entry, { value: JSON.stringify(read.targetAdmission.value) });

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues.map((issue) => issue.cause.message)).toContain('Presence admission fence timestamp cannot advance');
    });

    it.each(
        [
            { operation: 'grantGroupAdmission', change: 'missing-pending', message: 'No pending admission for group member: invitee' },
            { operation: 'grantGroupAdmission', change: 'capacity', message: 'Forbidden: Group member capacity has been reached.' },
            { operation: 'grantGroupAdmission', change: 'corrupt-policy', message: 'Group lifecycle policy is unreadable: admission audit' },
            { operation: 'declineGroupAdmission', change: 'corrupt-policy', message: 'Group lifecycle policy is unreadable: admission audit' },
            { operation: 'grantGroupAdmission', change: 'missing-manager', message: 'Forbidden: No group manager resolves under this policy.' },
            { operation: 'declineGroupAdmission', change: 'missing-manager', message: 'Forbidden: No group manager resolves under this policy.' }
        ] as const
    )('collects $operation $change at the admission decision boundary', async ({ operation, change, message }) => {
        const input = await readMembershipInput(operation);
        const command = input.command.command;
        const facts = input.command.facts;
        const computed = computeGroupMutation({ command, read: input.read, facts });
        expect(validateGroupMutation({ command, read: input.read, facts, computed })).toEqual([]);
        const read = structuredClone(input.read);
        if (read.group === null) {
            throw new Error('Expected admission group');
        }
        if (change === 'missing-pending') {
            Object.assign(read, { targetMember: null, targetMemberEntry: null });
        }
        if (change === 'capacity') {
            Object.assign(read.group.value, { maxMembers: read.group.value.activeMemberCount });
            Object.assign(read.group.entry, { value: JSON.stringify(read.group.value) });
        }
        if (change === 'corrupt-policy') {
            Object.assign(read, { lifecyclePolicy: { status: 'corrupt', reason: 'admission audit' } });
        }
        if (change === 'missing-manager') {
            Object.assign(read, { lifecyclePolicy: { status: 'absent' } });
        }

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues.map((issue) => issue.cause.message)).toContain(message);
    });

    it.each(['connectPresence', 'heartbeatPresence'] as const)('keeps stale %s a valid noop before later timestamp rejection', async (operation) => {
        const input = await readPresenceInput(operation);
        const command = structuredClone(input.command.command);
        const read = structuredClone(input.read);
        const facts = input.command.facts;
        if (read.targetPresence === null) {
            throw new Error('Expected original presence');
        }
        Object.assign(command.input, { lastHeartbeatAtEpochMs: facts.nowEpochMs + 600_000 });
        if (operation === 'connectPresence') {
            const value = read.targetPresence.value;
            Object.assign(value, {
                generationVersion: facts.nowEpochMs + 1,
                connectedAtEpochMs: facts.nowEpochMs + 1,
                lastHeartbeatAtEpochMs: facts.nowEpochMs + 1,
                expiresAtEpochMs: facts.nowEpochMs + 10_000
            });
            Object.assign(read.targetPresence.entry, { value: JSON.stringify(value) });
        }
        else {
            Object.assign(command.input, { generationId: 'older-generation' });
        }

        const computed = computeGroupMutation({ command, read, facts });

        expect(computed.outcome).toBe('no-op');
        expect(validateGroupMutation({ command, read, facts, computed })).toEqual([]);
    });

    it('keeps expiry redelivery with a missing presence row a valid noop', async () => {
        const input = await readPresenceInput('disconnectPresence');
        const command = structuredClone(input.command.command);
        Object.assign(command.input, { actorPrincipalId: null, actorSessionId: null, reason: 'expired' });
        const facts = { ...input.command.facts, authenticatedAuthority: null, internalAuthority: 'expiry' as const };
        const read = { ...input.read, actorMember: null, actorMemberEntry: null, targetPresence: null };

        const computed = computeGroupMutation({ command, read, facts });

        expect(computed.outcome).toBe('no-op');
        expect(validateGroupMutation({ command, read, facts, computed })).toEqual([]);
    });

    it('collects a returning non-authoritative owner before membership write projection', async () => {
        const input = await readMembershipInput('joinGroup', 'invitee');
        const command = input.command.command;
        const facts = input.command.facts;
        const computed = computeGroupMutation({ command, read: input.read, facts });
        const group = input.read.group;
        if (group === null) {
            throw new Error('Expected membership group');
        }
        const member = {
            ...command.aggregateRef,
            principalId: 'invitee',
            role: 'owner' as const,
            status: 'left' as const,
            joined: group.value.created,
            updated: group.value.created,
            left: group.value.created,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        };
        const entry = { entry: { ...group.entry, key: groupStateMemberStorageKey(member), value: JSON.stringify(member) }, value: member };
        const read = { ...input.read, actorMember: member, actorMemberEntry: entry, targetMember: member, targetMemberEntry: entry };

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues.map((issue) => issue.cause.message)).toContain('Ownership can only change through a single guarded transfer.');
    });

    it('collects an exhausted initial snapshot predecessor without changing raw revision acceptance', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const groupId = 'validation-recreated-room';
        await createRoom(harness, groupId, 'Initial');
        const prepared = await harness.groupStateService.prepareMutation(
            mutationDescriptor({
                operation: 'createGroup',
                scope: SCOPE,
                groupId,
                request: {
                    groupId,
                    displayName: 'Recreated',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'recreated-validation'
                }
            }),
            harness.sessions.owner
        );
        const command = prepared.command;
        const facts = { ...prepared.facts, attemptCount: 1 };
        const original = {
            ...await harness.groupStateService.read({ ...prepared, facts }),
            group: null,
            authorityMember: null,
            authorityMemberEntry: null
        };
        const computed = computeGroupMutation({ command, read: original, facts });
        expect(validateGroupMutation({ command, read: original, facts, computed })).toEqual([]);
        const read = structuredClone(original);
        if (read.presenceSummary === null) {
            throw new Error('Expected retained summary predecessor');
        }
        Object.assign(read.presenceSummary.value.causalRevision, { groupRevision: Number.MAX_SAFE_INTEGER });
        Object.assign(read.presenceSummary.entry, { value: JSON.stringify(read.presenceSummary.value) });

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues.map((issue) => issue.cause.message)).toContain('Initial group snapshot predecessor revision is invalid');
    });

    it('collects a criterion transition denial but preserves a preceding stale-fence domain rejection', () => {
        const original = createGroupAuthorityRead(
            { lifecycleState: 'forming', formationEpoch: 4 },
            { actorIsMember: false, activeMemberPrincipalIds: ['alice'] }
        );
        if (original.group === null) {
            throw new Error('Expected criterion group');
        }
        const groupRef = {
            applicationId: original.group.value.applicationId,
            workspaceId: original.group.value.workspaceId,
            groupId: original.group.value.groupId
        };
        const expectedLayout = { groupRevision: 4, presenceRevision: 0, version: 1, state: 'active' } as const;
        const plannedLayout: RallarOverlayTopologySnapshot = {
            sourceGroupStateCausalRevision: {
                groupRevision: expectedLayout.groupRevision,
                presenceRevision: expectedLayout.presenceRevision
            },
            state: expectedLayout.state,
            overlayId: toScopedOverlayId(groupRef),
            groupRef,
            name: 'criterion-validation-layout',
            topology: 'tree',
            activeSessionIds: [],
            nextHopsBySessionId: {},
            degreeLimit: 2,
            version: expectedLayout.version,
            createdByClientId: 'criterion-validation',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 1_000
        };
        Object.assign(original, { plannedLayoutRow: { snapshot: plannedLayout, revision: 1 } });
        const command = toFormationActivateCommand({
            groupRef,
            formationEpoch: 4,
            observedRate: 0.95,
            degraded: false,
            expectedLayout: toGroupLayoutIdentity(plannedLayout)
        });
        const facts: GroupMutationFacts = {
            ...createGroupAuthorityFacts(),
            internalAuthority: 'formation-criterion',
            authenticatedAuthority: null
        };
        const computed = computeGroupMutation({ command, read: original, facts });
        const read = structuredClone(original);
        if (read.group === null) {
            throw new Error('Expected changed criterion group');
        }
        Object.assign(read.group.value, { lifecycleState: 'active' });
        Object.assign(read.group.entry, { value: JSON.stringify(read.group.value) });

        const issues = validateGroupMutation({ command, read, facts, computed });

        expect(issues[0].cause).toBeInstanceOf(GroupPolicyDeniedError);
        if (command.operation !== 'activateGroup') {
            throw new Error('Expected activation command');
        }
        const staleCommand = { ...command, input: { ...command.input, expectedFormationEpoch: 3 } };
        const rejected = computeGroupMutation({ command: staleCommand, read, facts });
        expect(rejected.outcome).toBe('rejected');
        expect(validateGroupMutation({ command: staleCommand, read, facts, computed: rejected })).toEqual([]);
    });

    it('collects an incomplete recorded join-code receipt before composite result assembly', async () => {
        const input = await readJoinCodeInput();
        const written = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        if (written.outcome !== 'write' || written.idempotency === null || input.read.group === null) {
            throw new Error('Expected a join-code write candidate');
        }
        const receipt = { ...written.receipt, joinCode: null, joinCodeExpiresAtEpochMs: null };
        const record = { ...written.idempotency, receipt };
        const read = {
            ...input.read,
            idempotency: {
                entry: {
                    ...input.read.group.entry,
                    key: groupStateIdempotencyStorageKey(input.command.command.aggregateRef, input.command.command.commandId),
                    value: JSON.stringify(record)
                },
                value: record
            }
        };
        const mutation = computeGroupMutation({ command: input.command.command, read, facts: input.command.facts });
        expect(mutation.outcome).toBe('replay');

        const issues = validateGroupStateInboxMutation({
            ...input,
            read,
            recordedEvent: written.event,
            computed: { mutation, durableResult: undefined }
        });

        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: new TypeError('Join-code mutation result is incomplete') })
        ]));
    });

    it('collects independent malformed computed event and receipt branches without replacing the candidate', async () => {
        const input = await readUpdateInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        if (computed.outcome !== 'write') {
            throw new Error('Expected write candidate');
        }
        Object.assign(computed.event, { actor: null, payload: null });
        Object.assign(computed.receipt, { causalRevision: null, outboxIds: [null] });
        const before = JSON.stringify(computed);

        const issues = validateGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts, computed });

        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: 'GroupEvent.actor must be an object' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'GroupEvent.payload must be an object' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Group mutation computed receipt causalRevision must be an object' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Group mutation computed receipt outboxId must be a non-empty string' }) })
        ]));
        expect(JSON.stringify(computed)).toBe(before);
    });

    it('collects invalid roster deltas rather than throwing from derived count or ownership checks', async () => {
        const input = await readUpdateInput();
        const computed = computeGroupMutation({ command: input.command.command, read: input.read, facts: input.command.facts });
        const owner = input.currentSnapshot?.members.find((member) => member.role === 'owner');
        if (computed.outcome !== 'write' || !owner || owner.status !== 'active') {
            throw new Error('Expected an update with an owner');
        }
        const noActiveMembers = { ...computed, members: [{ ...owner, status: 'left' as const, left: owner.updated }] };
        const multipleOwners = {
            ...computed,
            members: [{ ...owner, principalId: 'alice' }, { ...owner, principalId: 'bob' }]
        };

        expect(validateComputedRosterFacts(input.read, noActiveMembers)).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: new TypeError('Updated group activeMemberCount has an invalid predecessor delta') })
        ]));
        expect(validateComputedRosterFacts(input.read, multipleOwners)).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: new TypeError('Updated group ownerPrincipalId has an invalid predecessor delta') })
        ]));
    });

    it('reports all missing criterion fences alongside contradictory internal authority', async () => {
        const input = await readUpdateInput();
        const command = {
            ...input.command.command,
            operation: 'activateGroup' as const,
            input: {
                actorPrincipalId: 'owner',
                actorSessionId: 'owner-session',
                reason: null,
                traceId: null,
                expectedFormationEpoch: null,
                expectedLayout: null,
                observedRate: null,
                degraded: null
            }
        };
        const facts = { ...input.command.facts, internalAuthority: 'formation-criterion' as const };

        expect(validateGroupMutationAuthority(command, facts)).toEqual(expect.arrayContaining([
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Internal group mutation cannot use authenticated authority facts' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Internal group maintenance cannot claim semantic actor authority' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Criterion transitions must carry the expected formation epoch fence' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Criterion transitions must carry the observed rate' }) }),
            expect.objectContaining({ cause: expect.objectContaining({ message: 'Criterion transitions must carry the expected layout fence' }) })
        ]));
    });

    it('returns no issues for an exact composite without replacing its computed result', async () => {
        const input = await readUpdateInput();
        const computation = computeGroupStateInboxMutation(input);
        if (computation.right === undefined) {
            throw computation.left;
        }
        const computed = computation.right;
        const before = JSON.stringify(computed);

        expect(validateGroupStateInboxMutation({ ...input, computed })).toEqual([]);
        expect(JSON.stringify(computed)).toBe(before);
    });

    it('returns an expected missing-predecessor conflict as Either data', async () => {
        const input = await readUpdateInput();
        const computation = computeGroupStateInboxMutation({ ...input, currentSnapshot: undefined });

        expect(computation).toMatchObject({
            left: {
                name: 'GroupStateInboxResultReadConflictError',
                code: 'runtime-state-write-conflict'
            },
            right: undefined
        });
        expect(classifyAppInboxError(computation.left)).toMatchObject({ kind: 'retryable' });
    });

    it('accepts a correctly computed domain rejection without converting it into a validation error', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const groupId = 'validation-rejected-promotion';
        await createRoom(harness, groupId, 'No planned layout');
        const preparation = await harness.groupStateService.prepareTopologyPublicationMutation(
            toApplyPlannedLayoutCommand({
                groupRef: { ...SCOPE, groupId },
                formationEpoch: 0,
                expectedLayout: { groupRevision: 1, presenceRevision: 0, version: 1, state: 'active' }
            }),
            harness.nowEpochMs
        );
        const command = { ...preparation, facts: { ...preparation.facts, attemptCount: 1 } };
        const read = await harness.groupStateService.read(command);
        const mutation = computeGroupMutation({ command: command.command, read, facts: command.facts });
        expect(mutation.outcome).toBe('rejected');

        const currentSnapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId });
        const computed = { mutation, durableResult: undefined };
        const before = JSON.stringify(computed);
        expect(
            validateGroupStateInboxMutation({
                command,
                read,
                currentSnapshot,
                recordedEvent: undefined,
                computed
            })
        ).toEqual([]);
        expect(JSON.stringify(computed)).toBe(before);
        const rejectedResultIssues = validateGroupStateInboxMutation({
            command,
            read,
            currentSnapshot,
            recordedEvent: undefined,
            computed: { mutation, durableResult: mutation.outcome === 'rejected' ? mutation.receipt : undefined }
        });
        expect(rejectedResultIssues).toEqual([
            expect.objectContaining({ cause: expect.any(TypeError) })
        ]);
        expect(rejectedResultIssues[0].cause.message).toBe('Group inbox result differs from its canonical deterministic projection.');

        await harness.service.enqueueTopologyPublicationCommand(command.command, harness.nowEpochMs);
        const queued = (await harness.queueEntries()).find((entry) => entry.status === EntityStatus.NEW);
        if (queued === undefined) {
            throw new Error('Expected queued publication decision');
        }
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const persisted = await harness.results.findByKey(queued.key);
        expect(persisted?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(persisted?.resource ?? 'null')).toMatchObject({
            type: 'app-inbox-failure',
            code: 'group-mutation-rejected',
            status: 400,
            message: 'Planned layout promotion is no-planned-layout'
        });
        expect(await harness.repository.readSnapshot({ ...SCOPE, groupId })).toEqual(currentSnapshot);
        expect(await harness.repository.listEvents({ ...SCOPE, groupId })).toHaveLength(1);
    });
});

async function readUpdateInput(): Promise<ComputeGroupStateInboxMutationInput> {
    const harness = await createAuthorityHarness(['owner']);
    const groupId = 'validation-issues-room';
    await createRoom(harness, groupId, 'Before');
    const prepared = await harness.groupStateService.prepareMutation(
        mutationDescriptor({
            operation: 'updateGroup',
            scope: SCOPE,
            groupId,
            request: {
                actorPrincipalId: 'owner',
                actorSessionId: 'owner-session',
                requestId: 'validate-update',
                displayName: 'After'
            }
        }),
        harness.sessions.owner
    );
    const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
    return {
        command,
        read: await harness.groupStateService.read(command),
        currentSnapshot: await harness.repository.readSnapshot({ ...SCOPE, groupId }),
        recordedEvent: undefined
    };
}

async function readPublicationInput(): Promise<ComputeGroupStateInboxMutationInput> {
    const harness = await createAuthorityHarness(['owner']);
    const groupId = 'validation-publication-room';
    await createRoom(harness, groupId, 'Publication');
    const prepared = await harness.groupStateService.prepareTopologyPublicationMutation(
        toApplyPlannedLayoutCommand({
            groupRef: { ...SCOPE, groupId },
            formationEpoch: 0,
            expectedLayout: { groupRevision: 1, presenceRevision: 0, version: 1, state: 'active' }
        }),
        harness.nowEpochMs
    );
    const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
    return {
        command,
        read: await harness.groupStateService.read(command),
        currentSnapshot: await harness.repository.readSnapshot({ ...SCOPE, groupId }),
        recordedEvent: undefined
    };
}

async function readJoinCodeInput(): Promise<ComputeGroupStateInboxMutationInput> {
    const harness = await createAuthorityHarness(['owner']);
    const groupId = 'validation-join-code-room';
    await createRoom(harness, groupId, 'Join code');
    const prepared = await harness.groupStateService.prepareMutation(
        mutationDescriptor({
            operation: 'rotateGroupJoinCode',
            scope: SCOPE,
            groupId,
            request: {
                actorPrincipalId: 'owner',
                actorSessionId: 'owner-session',
                requestId: 'validation-join-code',
                joinCode: 'VALIDATION42',
                expiresAtEpochMs: harness.nowEpochMs + 120_000
            }
        }),
        harness.sessions.owner
    );
    const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
    return {
        command,
        read: await harness.groupStateService.read(command),
        currentSnapshot: await harness.repository.readSnapshot({ ...SCOPE, groupId }),
        recordedEvent: undefined
    };
}

async function readGovernedInput(
    operation: 'planGroupLayout' | 'pauseGroupTransport' | 'createGroupInvite'
): Promise<ComputeGroupStateInboxMutationInput> {
    const harness = await createAuthorityHarness(['owner']);
    const groupId = 'validation-governed-room';
    await createRoom(harness, groupId, 'Governed');
    const prepared = await harness.groupStateService.prepareMutation(
        mutationDescriptor({
            operation,
            scope: SCOPE,
            groupId,
            targetPrincipalId: operation === 'createGroupInvite' ? 'invitee' : null,
            request: {
                actorPrincipalId: 'owner',
                actorSessionId: 'owner-session',
                requestId: `validation-${operation}`
            }
        }),
        harness.sessions.owner
    );
    const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
    const read = await harness.groupStateService.read(command);
    if (operation === 'planGroupLayout' && read.group !== null) {
        Object.assign(read.group.value, { lifecycleState: 'forming' });
        Object.assign(read.group.entry, { value: JSON.stringify(read.group.value) });
    }
    return {
        command,
        read,
        currentSnapshot: await harness.repository.readSnapshot({ ...SCOPE, groupId }),
        recordedEvent: undefined
    };
}

async function readMembershipInput(
    operation: 'setGroupMemberRole' | 'transferGroupOwnership' | 'upsertMember' | 'joinGroup' | 'grantGroupAdmission' | 'declineGroupAdmission',
    actorPrincipalId: 'owner' | 'invitee' = 'owner'
): Promise<ComputeGroupStateInboxMutationInput> {
    const harness = await createAuthorityHarness(['owner', 'invitee']);
    const groupId = 'validation-membership-room';
    const created = await createRoom(harness, groupId, 'Membership');
    const request = { actorPrincipalId, actorSessionId: `${actorPrincipalId}-session`, requestId: `validation-${operation}` };
    const descriptor = operation === 'setGroupMemberRole'
        ? mutationDescriptor({ operation, scope: SCOPE, groupId, targetPrincipalId: 'invitee', request: { ...request, role: 'admin' } })
        : operation === 'upsertMember'
        ? mutationDescriptor({
            operation,
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'invitee',
            request: { ...request, role: actorPrincipalId === 'owner' ? 'admin' : 'member', status: actorPrincipalId === 'owner' ? 'active' : 'left' }
        })
        : operation === 'joinGroup'
        ? mutationDescriptor({ operation, scope: SCOPE, groupId, request })
        : operation === 'transferGroupOwnership'
        ? mutationDescriptor({ operation, scope: SCOPE, groupId, targetPrincipalId: 'invitee', request: { ...request, newOwnerPrincipalId: 'invitee' } })
        : mutationDescriptor({ operation, scope: SCOPE, groupId, targetPrincipalId: 'invitee', request });
    const prepared = await harness.groupStateService.prepareMutation(descriptor, harness.sessions[actorPrincipalId]);
    const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
    const read = await harness.groupStateService.read(command);
    if (operation === 'joinGroup') {
        return { command, read, currentSnapshot: undefined, recordedEvent: undefined };
    }
    const owner = created.result.snapshot.members.find((member) => member.principalId === 'owner');
    if (owner === undefined || read.group === null) {
        throw new Error('Expected owner and group');
    }
    const pending = operation === 'grantGroupAdmission' || operation === 'declineGroupAdmission';
    if (pending) {
        const policy = createDefaultGroupLifecyclePolicy();
        Object.assign(read, { lifecyclePolicy: { status: 'present', policy: { ...policy, manager: { ...policy.manager, selection: 'creator', count: 1 } } } });
    }
    const member = {
        ...owner,
        principalId: 'invitee',
        role: 'member' as const,
        ...(pending ? { status: 'pending' as const, joined: null } : {})
    };
    const targetMemberEntry = {
        entry: { ...read.group.entry, key: groupStateMemberStorageKey(member), value: JSON.stringify(member) },
        value: member
    };
    Object.assign(read, {
        targetMember: member,
        targetMemberEntry,
        ...(actorPrincipalId === 'invitee' ? { actorMember: member, actorMemberEntry: targetMemberEntry } : {})
    });
    Object.assign(read.group.value, { activeMemberCount: pending ? 1 : 2 });
    Object.assign(read.group.entry, { value: JSON.stringify(read.group.value) });
    return { command, read, currentSnapshot: undefined, recordedEvent: undefined };
}

function changeMembershipReadRole(read: GroupMutationRead, principalId: string, role: 'admin' | 'owner'): void {
    for (const entry of [read.actorMemberEntry, read.targetMemberEntry, read.authorityMemberEntry, read.directorMemberEntry]) {
        if (entry?.value.principalId === principalId) {
            Object.assign(entry.value, { role });
            Object.assign(entry.entry, { value: JSON.stringify(entry.value) });
        }
    }
    for (const member of [read.actorMember, read.targetMember, read.authorityMember, read.directorMember]) {
        if (member?.principalId === principalId) {
            Object.assign(member, { role });
        }
    }
}
async function readPresenceInput(
    operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence' | 'appointDirector'
): Promise<ComputeGroupStateInboxMutationInput> {
    const harness = await createAuthorityHarness(['owner']);
    const groupId = 'validation-presence-policy-room';
    await createRoom(harness, groupId, 'Presence policy');
    const actor = { actorPrincipalId: 'owner', actorSessionId: 'owner-session', requestId: `validation-${operation}` };
    const descriptor = operation === 'appointDirector'
        ? mutationDescriptor({ operation, scope: SCOPE, groupId, request: { ...actor, heartbeatTtlMs: 5_000 } })
        : mutationDescriptor({
            operation,
            scope: SCOPE,
            groupId,
            sessionId: 'owner-session',
            request: {
                ...actor,
                principalId: 'owner',
                generationId: operation === 'connectPresence' ? 'generation-2' : 'generation-1',
                ...(operation === 'connectPresence' ? { connectedAtEpochMs: harness.nowEpochMs } : {}),
                ...(operation === 'disconnectPresence' ? { disconnectedAtEpochMs: harness.nowEpochMs } : {}),
                lastHeartbeatAtEpochMs: harness.nowEpochMs,
                ...(operation === 'connectPresence' ? { expiresAtEpochMs: harness.nowEpochMs + 20_000 } : {})
            }
        });
    const prepared = await harness.groupStateService.prepareMutation(descriptor, harness.sessions.owner);
    const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
    const read = await harness.groupStateService.read(command);
    return {
        command,
        read: createPresencePolicyRead(read, command.command, command.facts.nowEpochMs),
        currentSnapshot: undefined,
        recordedEvent: undefined
    };
}

function createPresencePolicyRead(
    read: GroupMutationRead,
    command: GroupMutationCommand,
    nowEpochMs: number
): GroupMutationRead {
    if (read.group === null) {
        throw new Error('Expected presence policy group');
    }
    const session: GroupPresenceSession = {
        ...command.aggregateRef,
        principalId: 'owner',
        sessionId: 'owner-session',
        generationId: 'generation-1',
        generationVersion: nowEpochMs - 1_000,
        connectedAtEpochMs: nowEpochMs - 1_000,
        lastHeartbeatAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: nowEpochMs + 10_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
    const admission: GroupPresenceAdmission = {
        ...command.aggregateRef,
        principalId: 'owner',
        updatedAtEpochMs: nowEpochMs - 1_000,
        admittedSessions: [{
            sessionId: session.sessionId,
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            connectedAtEpochMs: session.connectedAtEpochMs
        }]
    };
    const targetAdmission = {
        entry: { ...read.group.entry, key: groupStatePresenceAdmissionStorageKey(admission), value: JSON.stringify(admission) },
        value: admission
    };
    Object.assign(read, {
        targetPresence: {
            entry: { ...read.group.entry, key: groupStatePresenceSessionStorageKey(session), value: JSON.stringify(session) },
            value: session
        },
        targetAdmission,
        authorityAdmission: command.operation === 'appointDirector' ? targetAdmission : null
    });
    return read;
}

function changePresencePolicyRead(read: GroupMutationRead, change: string, nowEpochMs: number): void {
    if (change === 'missing-member') {
        Object.assign(read, {
            actorMember: null,
            actorMemberEntry: null,
            targetMember: null,
            targetMemberEntry: null,
            authorityMember: null,
            authorityMemberEntry: null,
            directorMember: null,
            directorMemberEntry: null
        });
    }
    if (change === 'missing-session') {
        Object.assign(read, { targetPresence: null });
    }
    const presence = read.targetPresence;
    if (presence !== null) {
        if (change === 'reused-generation') {
            Object.assign(presence.value, { generationId: 'generation-2' });
        }
        if (change === 'future-connection' || change === 'inconsistent-connection') {
            const connectedAtEpochMs = nowEpochMs + (change === 'future-connection' ? 300_001 : 1_000);
            Object.assign(presence.value, {
                connectedAtEpochMs,
                generationVersion: connectedAtEpochMs,
                lastHeartbeatAtEpochMs: connectedAtEpochMs,
                expiresAtEpochMs: connectedAtEpochMs + 10_000
            });
        }
        if (change === 'expired-lease') {
            Object.assign(presence.value, { expiresAtEpochMs: nowEpochMs - 1 });
        }
        Object.assign(presence.entry, { value: JSON.stringify(presence.value) });
    }
    if (change === 'admission-cap') {
        if (read.group === null || read.targetAdmission === null) {
            throw new Error('Expected group/admission');
        }
        Object.assign(read.group.value, { maxSessionsPerMember: 1 });
        Object.assign(read.group.entry, { value: JSON.stringify(read.group.value) });
        Object.assign(read.targetAdmission.value, {
            admittedSessions: [{
                sessionId: 'other-session',
                generationId: 'other-generation',
                generationVersion: nowEpochMs - 1_000,
                connectedAtEpochMs: nowEpochMs - 1_000
            }, ...read.targetAdmission.value.admittedSessions]
        });
        Object.assign(read.targetAdmission.entry, { value: JSON.stringify(read.targetAdmission.value) });
    }
}
