import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import {
    computeGroupLifecyclePolicyWrite,
    GROUP_LIFECYCLE_POLICIES_NAMESPACE
} from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';
import { toGroupMutationErrorResponse } from '../../../../../../apps/api-v1/src/group-state/group-state-route-errors.ts';
import { toApiMutationRouteFailure } from '../../../../../../apps/api-v1/src/routes/api-mutation-route-failure.ts';
import { createAuthorityHarness, createRoom, processAuthenticated, SCOPE } from './group-state-inbox-test-runtime.ts';

describe('lifecycle policy denial boundary', () => {
    it.each(
        [
            {
                name: 'illegal stage',
                lifecycleState: 'active',
                attempts: 0,
                actor: 'owner',
                code: 'lifecycle-transition-invalid',
                message: 'Cannot plan from lifecycle state \'active\'.',
                details: { transition: 'plan', lifecycleState: 'active' }
            },
            {
                name: 'authority',
                lifecycleState: 'forming',
                attempts: 0,
                actor: 'owner',
                code: 'forbidden-role',
                message: 'Group authority commands are server-initiated under this policy.',
                details: null
            },
            {
                name: 'exhausted series',
                lifecycleState: 'dormant',
                attempts: 3,
                actor: 'owner',
                code: 'formation-attempts-exhausted',
                message: 'Formation attempts are exhausted (3 of 3); reset the group to start a new series.',
                details: { formationAttemptCount: 3, maxFormationAttempts: 3 }
            }
        ] as const
    )('durably replays the $name denial through the API envelope', async (scenario) => {
        const harness = await createAuthorityHarness(['owner']);
        const groupId = `denial-${scenario.code}`;
        const ref = { ...SCOPE, groupId };
        const created = await createRoom(harness, groupId, scenario.name);
        const original = { ...created.result.snapshot.group, lifecycleState: scenario.lifecycleState, formationAttemptCount: scenario.attempts };
        await harness.repository.putGroup(original);
        const managed = resolveGroupLifecyclePolicyPreset('managed');
        await writeTestPolicy(harness.runtimeRepository, ref, {
            ...managed,
            initiator: scenario.name === 'authority' ? 'server-auto' : 'manager',
            establishment: { ...managed.establishment, planTrigger: { kind: 'immediate' } }
        });
        const requestId = `request-${scenario.code}`;
        const input = {
            type: scenario.code === 'formation-attempts-exhausted' ? AppInboxType.GROUP_FORMATION_START : AppInboxType.GROUP_PLAN,
            resourceId: requestId,
            contextId: groupId,
            senderId: scenario.actor,
            data: {
                scope: SCOPE,
                groupId,
                request: { requestId, actorPrincipalId: scenario.actor, actorSessionId: `${scenario.actor}-session` }
            }
        } satisfies AuthenticatedGroupMutationEnqueue;
        const first = await processAuthenticated({ service: harness.service, reader: harness.reader, authority: harness.sessions[scenario.actor], input });
        expect(first.left).toEqual({
            type: 'app-inbox-failure',
            code: scenario.code,
            status: 403,
            message: scenario.message,
            denial: { code: scenario.code, message: scenario.message, details: scenario.details },
            issues: null,
            retry: null
        });
        expect((await harness.repository.readSnapshot(ref))?.group).toEqual(original);
        expect(await harness.repository.listEvents(ref)).toHaveLength(1);
        if (!first.left) {
            throw new Error('Expected durable policy failure');
        }
        const firstFailure = first.left;
        // A later legal state does not turn the identical denied request into a write.
        await harness.repository.putGroup({
            ...original,
            lifecycleState: scenario.code === 'formation-attempts-exhausted' ? 'dormant' : 'forming',
            formationAttemptCount: 0
        });
        await writeTestPolicy(harness.runtimeRepository, ref, resolveGroupLifecyclePolicyPreset('managed'));
        const replay = await processAuthenticated({ service: harness.service, reader: harness.reader, authority: harness.sessions[scenario.actor], input });
        expect(replay.left).toEqual(firstFailure);
        expect(await harness.repository.listEvents(ref)).toHaveLength(1);
        const fresh = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions[scenario.actor],
            input: { ...input, resourceId: `${requestId}-fresh`, data: { ...input.data, request: { ...input.data.request, requestId: `${requestId}-fresh` } } }
        });
        expect(fresh.right).toMatchObject({ status: 'ok' });
        expect(await harness.repository.listEvents(ref)).toHaveLength(2);
        const response = toGroupMutationErrorResponse({ json: (value, status) => Response.json(value, { status }) }, toApiMutationRouteFailure(firstFailure));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code: scenario.code,
            status: 403,
            message: scenario.message,
            issues: null,
            denial: { code: scenario.code, message: scenario.message, details: scenario.details },
            retry: null
        });
    });
});

async function writeTestPolicy(
    runtime: RuntimeStateRepositoryLike,
    ref: GroupRef,
    policy: GroupLifecyclePolicy
): Promise<void> {
    const computed = computeGroupLifecyclePolicyWrite(ref, policy);
    await runtime.upsert(
        GROUP_LIFECYCLE_POLICIES_NAMESPACE,
        computed.key,
        computed.value,
        Date.parse(computed.expireAtIsoTimestamp)
    );
}
