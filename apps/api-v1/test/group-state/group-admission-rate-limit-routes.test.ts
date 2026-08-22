import assert from 'node:assert/strict';

import type { GroupRef } from '@shared/api/group-types.ts';
import { createGroupAdmissionQuota, type GroupAdmissionQuota } from '../../src/services/group-admission-rate-limit.ts';
import {
    captureGroupStateRouteWrite,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestRuntime,
    postGroupStateMutation,
    putGroupStateMutation
} from './group-state-route-test-runtime.ts';

Deno.test('join route answers 429 with Retry-After once the join-admission window is spent', async () => {
    const groupRef = uniqueGroupRef('route-join');
    const groupAdmissionQuota = createDefaultQuota();
    exhaustQuota(groupAdmissionQuota, 'join-admission', groupRef, 'alice', 60);
    const runtime = createGroupStateRouteTestRuntime({
        groupAdmissionQuota,
        processGroupAppInbox: captureGroupStateRouteWrite([], createGroupStateRouteSnapshot('room-1'))
    });

    const response = await postGroupStateMutation(
        runtime.app,
        toGroupPath(groupRef, '/join'),
        { requestId: 'join-over-limit', status: 'active' }
    );

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), {
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code: 'rate-limited',
        status: 429,
        message: 'Too many group join-admission requests',
        issues: null,
        denial: null,
        retry: {
            kind: 'rate-limited',
            retryAfterMs: 60_000,
            attempts: null,
            lane: null,
            queueAgeMs: null,
            dueAgeMs: null
        }
    });
});

Deno.test('upsert-self member route shares the join-admission window', async () => {
    const groupRef = uniqueGroupRef('route-upsert-self');
    const groupAdmissionQuota = createDefaultQuota();
    exhaustQuota(groupAdmissionQuota, 'join-admission', groupRef, 'alice', 60);
    const runtime = createGroupStateRouteTestRuntime({
        groupAdmissionQuota,
        processGroupAppInbox: captureGroupStateRouteWrite([], createGroupStateRouteSnapshot('room-1'))
    });

    const response = await putGroupStateMutation(
        runtime.app,
        toGroupPath(groupRef, '/members/alice'),
        { requestId: 'upsert-over-limit', status: 'active' }
    );

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
});

Deno.test('presence connect route answers 429 from the presence-connect window', async () => {
    const groupRef = uniqueGroupRef('route-presence');
    const groupAdmissionQuota = createDefaultQuota();
    exhaustQuota(groupAdmissionQuota, 'presence-connect', groupRef, 'alice', 120);
    const runtime = createGroupStateRouteTestRuntime({ groupAdmissionQuota });

    const response = await putGroupStateMutation(
        runtime.app,
        toGroupPath(groupRef, '/sessions/alice-session'),
        { requestId: 'presence-over-limit', generationId: 'generation-1', principalId: 'alice' }
    );

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), {
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code: 'rate-limited',
        status: 429,
        message: 'Too many group presence-connect requests',
        issues: null,
        denial: null,
        retry: {
            kind: 'rate-limited',
            retryAfterMs: 60_000,
            attempts: null,
            lane: null,
            queueAgeMs: null,
            dueAgeMs: null
        }
    });
});

Deno.test('a group whose window is untouched still admits joins through the guard', async () => {
    const groupRef = uniqueGroupRef('route-join-allowed');
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const runtime = createGroupStateRouteTestRuntime({
        processGroupAppInbox: captureGroupStateRouteWrite([], snapshot)
    });

    const response = await postGroupStateMutation(
        runtime.app,
        toGroupPath(groupRef, '/join'),
        { requestId: 'join-allowed-request-001' }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
});

function exhaustQuota(
    quota: GroupAdmissionQuota,
    family: 'join-admission' | 'presence-connect',
    groupRef: GroupRef,
    principalId: string,
    windowSize: number
): void {
    for (let attempt = 1; attempt <= windowSize; attempt++) {
        quota.require({ family, groupRef, principalId });
    }
}

function createDefaultQuota(): GroupAdmissionQuota {
    return createGroupAdmissionQuota({
        windowMs: 60_000,
        joinPrincipal: 60,
        joinGroup: 600,
        presencePrincipal: 120,
        presenceGroup: 1_200
    });
}

function toGroupPath(groupRef: GroupRef, suffix: string): string {
    return `/api/state/apps/${groupRef.applicationId}/workspaces/${groupRef.workspaceId}` +
        `/groups/${groupRef.groupId}${suffix}`;
}

function uniqueGroupRef(label: string): GroupRef {
    return {
        applicationId: `adm-rl-${label}`,
        workspaceId: 'workspace-1',
        groupId: `group-${label}-${crypto.randomUUID()}`
    };
}
