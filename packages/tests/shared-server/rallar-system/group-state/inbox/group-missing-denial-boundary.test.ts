import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import { toGroupMutationErrorResponse } from '../../../../../../apps/api-v1/src/group-state/group-state-route-errors.ts';
import { toApiMutationRouteFailure } from '../../../../../../apps/api-v1/src/routes/api-mutation-route-failure.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { createAuthorityHarness, createRoom, processAuthenticated, SCOPE } from './group-state-inbox-test-runtime.ts';

describe('missing group denial boundary', () => {
    it('preserves the domain error in the service test adapter before snapshot loading', async () => {
        const service = createTestGroupStateService({
            runtimeRepository: new FakeRuntimeStateRepository(),
            serviceId: 'missing-group-service',
            now: () => 1_000,
            randomId: () => 'missing-group-id'
        });
        await expect(service.updateGroup(SCOPE, 'absent', {
            displayName: 'Updated',
            actorPrincipalId: 'owner',
            actorSessionId: 'owner-session',
            requestId: 'absent-update'
        })).rejects.toMatchObject({
            code: 'group-mutation-rejected',
            status: 400,
            message: 'Group not found: absent'
        });
    });

    it('replays the exact durable denial after creation while a fresh update succeeds', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const groupId = 'missing-denial';
        const ref = { ...SCOPE, groupId };
        const input = {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'missing-update',
            contextId: groupId,
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                request: {
                    requestId: 'missing-update',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    displayName: 'Updated after creation'
                }
            }
        } satisfies AuthenticatedGroupMutationEnqueue;
        const first = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input
        });
        expect(first.left).toEqual({
            type: 'app-inbox-failure',
            code: 'group-mutation-rejected',
            status: 400,
            message: 'Group not found: missing-denial',
            denial: null,
            issues: null,
            retry: null
        });
        expect(await harness.repository.readSnapshot(ref)).toBeUndefined();
        expect(await harness.repository.listEvents(ref)).toEqual([]);
        if (!first.left) {
            throw new Error('Expected durable missing-group failure');
        }
        const response = toGroupMutationErrorResponse(
            { json: (value, status) => Response.json(value, { status }) },
            toApiMutationRouteFailure(first.left)
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code: 'group-mutation-rejected',
            status: 400,
            message: 'Group not found: missing-denial',
            issues: null,
            denial: null,
            retry: null
        });

        await createRoom(harness, groupId, 'Created later');
        const replay = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input
        });
        expect(replay.left).toEqual(first.left);
        expect((await harness.repository.readSnapshot(ref))?.group.displayName).toBe('Created later');
        expect(await harness.repository.listEvents(ref)).toHaveLength(1);

        const fresh = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                ...input,
                resourceId: 'fresh-update',
                data: { ...input.data, request: { ...input.data.request, requestId: 'fresh-update' } }
            }
        });
        expect(fresh.right).toMatchObject({ status: 'ok' });
        expect((await harness.repository.readSnapshot(ref))?.group.displayName).toBe('Updated after creation');
        expect(await harness.repository.listEvents(ref)).toHaveLength(2);
    });
});
