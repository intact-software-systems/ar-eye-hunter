import { beforeEach, describe, expect, it, vi } from 'vitest';

const stateMocks = vi.hoisted(() => ({
    session: {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000
    },
    clientRepositoryMissing: vi.fn((_value?: unknown): unknown => {
        throw new Error('Repository not found: shared.repository.client-state-snapshots');
    }),
    groupRepositoryMissing: vi.fn((_value?: unknown): unknown => {
        throw new Error('Repository not found: shared.repository.group-state-snapshots');
    })
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: vi.fn(() => stateMocks.session),
    writeSession: vi.fn()
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
    findClientStateSnapshotByPrincipalId: stateMocks.clientRepositoryMissing,
    getAllClientStateSnapshots: stateMocks.clientRepositoryMissing
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: stateMocks.groupRepositoryMissing,
    findGroupStateSnapshotByRef: stateMocks.groupRepositoryMissing,
    getAllGroupStateSnapshots: stateMocks.groupRepositoryMissing
}));

describe('people state compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stateMocks.clientRepositoryMissing.mockImplementation(() => {
            throw new Error('Repository not found: shared.repository.client-state-snapshots');
        });
        stateMocks.groupRepositoryMissing.mockImplementation(() => {
            throw new Error('Repository not found: shared.repository.group-state-snapshots');
        });
    });

    it('returns empty people state before cache repositories are configured', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const listener = vi.fn();

        expect(facade.people.state().people).toEqual([]);
        expect(facade.people.state().clients).toEqual([]);
        expect(facade.people.get('principal-1')).toBeUndefined();

        facade.people.onChange(listener);

        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ people: [], clients: [] }));
    });
});
