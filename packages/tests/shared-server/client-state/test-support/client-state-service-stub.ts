import { vi } from 'vitest';

import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createWsSessionGenerationLifecycleService } from '@shared-server/rallar-system/websocket/ws-session-generation-lifecycle.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

export function createDefaultClientStateServiceStub(): ClientStateService {
    return createClientStateServiceStub({});
}

export function createClientStateServiceStub(
    overrides: Partial<ClientStateService>
): ClientStateService {
    return {
        sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(
            new FakeRuntimeStateRepository()
        ),
        listSnapshots: vi.fn(),
        readSnapshot: vi.fn(),
        readPresenceSnapshot: vi.fn(),
        listEvents: vi.fn(),
        listRecentEvents: vi.fn(),
        listEventPage: vi.fn(),
        read: vi.fn(),
        compute: vi.fn(),
        validate: vi.fn(),
        write: vi.fn(),
        listExpiredSessionCandidates: vi.fn(async () => []),
        findSessionBySessionId: vi.fn(),
        readIssuedAuthSession: vi.fn(),
        observeSnapshot: vi.fn(async (snapshot) => snapshot),
        ...overrides
    };
}
