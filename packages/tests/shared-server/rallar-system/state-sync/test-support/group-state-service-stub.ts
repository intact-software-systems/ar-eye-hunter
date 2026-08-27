import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { vi } from 'vitest';

export function createGroupStateServiceStub(): GroupStateService {
    return {
        sessionGenerationLifecycle: {
            read: vi.fn(),
            isGenerationClosed: vi.fn(),
            isObservedAtClosed: vi.fn(),
            computeClosed: vi.fn(),
            computeConnectGuard: vi.fn(),
            write: vi.fn()
        },
        authorizeMutation: vi.fn(),
        prepareMutation: vi.fn(),
        prepareAppInboxMutation: vi.fn(),
        prepareExpiredPresenceMutations: vi.fn(),
        prepareSessionCleanupMutations: vi.fn(),
        prepareFormationCriterionMutation: vi.fn(),
        prepareFormationAutomationMutation: vi.fn(),
        prepareTopologyPublicationMutation: vi.fn(),
        prepareActivationStatusMutation: vi.fn(),
        read: vi.fn(),
        compute: vi.fn(),
        validate: vi.fn(),
        write: vi.fn(),
        listSnapshots: vi.fn(),
        listSnapshotsPage: vi.fn(),
        readSnapshot: vi.fn(),
        readCausalRevision: vi.fn(),
        readIssuedAuthSession: vi.fn(),
        listEvents: vi.fn(),
        listRecentEvents: vi.fn(),
        listEventPage: vi.fn(),
        observeSnapshot: vi.fn()
    };
}
