import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { FakeRuntimeStateRepository } from '../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createClientStateTestDriver as createClientStateService } from './client-state-test-runtime.ts';

export const CLIENT_MUTATION_SERVICE_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

export interface SeedConnectedSessionInput {
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly sessionId: string;
    readonly overrides?: Partial<{
        lastHeartbeatAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;
}

export async function seedConnectedSession(input: SeedConnectedSessionInput): Promise<void> {
    const { runtimeRepository, principalId, clientInstanceId, sessionId, overrides = {} } = input;
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
