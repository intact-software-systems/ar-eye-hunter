import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService as createGroupStateService } from '../group-state-test-runtime.ts';

export const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

export async function seedGroup(
    runtimeRepository: FakeRuntimeStateRepository,
    groupId: string
): Promise<void> {
    await createGroupStateService({
        runtimeRepository,
        now: () => 1_000,
        serviceId: 'group-service'
    }).createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
}

export async function seedPresenceSession(
    runtimeRepository: FakeRuntimeStateRepository,
    groupId: string,
    overrides: Partial<{
        lastHeartbeatAtEpochMs: number;
        expiresAtEpochMs: number;
    }> = {}
): Promise<void> {
    const lastHeartbeatAtEpochMs = overrides.lastHeartbeatAtEpochMs ?? 2_000;
    const expiresAtEpochMs = overrides.expiresAtEpochMs ?? Date.now() + 60_000;
    await createGroupStateService({
        runtimeRepository,
        now: () => Math.max(2_000, lastHeartbeatAtEpochMs),
        serviceId: 'group-service'
    }).connectPresenceSession(SCOPE, groupId, 'session-1', {
        principalId: 'alice',
        generationId: 'generation-session-1',
        actorPrincipalId: 'alice',
        connectedAtEpochMs: 2_000,
        lastHeartbeatAtEpochMs,
        expiresAtEpochMs,
        requestId: `seed-session-${groupId}`
    });
}

export function toGroupRef(groupId: string): GroupRef {
    return {
        ...SCOPE,
        groupId
    };
}
