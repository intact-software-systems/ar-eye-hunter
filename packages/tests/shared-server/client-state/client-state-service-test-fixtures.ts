import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import { createClientStateTestDriver as createClientStateService } from './client-state-test-runtime.ts';

export const CLIENT_MUTATION_SERVICE_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

export async function seedConnectedSession(
    runtimeRepository: FakeRuntimeStateRepository,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    overrides: Partial<{
        lastHeartbeatAtEpochMs: number;
        expiresAtEpochMs: number;
    }> = {}
): Promise<void> {
    const lastHeartbeatAtEpochMs = overrides.lastHeartbeatAtEpochMs ?? 2_000;
    const expiresAtEpochMs = overrides.expiresAtEpochMs ?? Date.now() + 60_000;
    await createClientStateService({
        runtimeRepository,
        now: () => Math.max(2_000, lastHeartbeatAtEpochMs),
        serviceId: 'client-service'
    }).connectSession(CLIENT_MUTATION_SERVICE_SCOPE, principalId, clientInstanceId, sessionId, {
        generationId: `generation-${sessionId}`,
        presenceState: 'online',
        actorPrincipalId: principalId,
        actorSessionId: sessionId,
        connectedAtEpochMs: 2_000,
        lastHeartbeatAtEpochMs,
        expiresAtEpochMs,
        requestId: `seed-${sessionId}`
    });
}
export function toClientPrincipalRef(principalId: string): ClientPrincipalRef {
    return {
        ...CLIENT_MUTATION_SERVICE_SCOPE,
        principalId
    };
}
