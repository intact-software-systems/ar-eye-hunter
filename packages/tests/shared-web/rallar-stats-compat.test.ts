import type { AuthSession } from '@shared/api/api-config.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const session: AuthSession = {
        clientId: 'alice',
        username: 'alice',
        sessionId: 'alice-session',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000
    };

    return {
        session,
        readSession: vi.fn(() => session),
        readStateWorkspaceStatsSummary: vi.fn(async () => ({
            generatedAtEpochMs: 1
        })),
        readStateGroupStats: vi.fn(async () => ({
            generatedAtEpochMs: 2
        })),
        readStateMyRealtimeStatus: vi.fn(async () => ({
            generatedAtEpochMs: 3
        })),
        initMiddleware: vi.fn(),
        isMiddlewareReady: vi.fn(() => false)
    };
});

vi.mock('@shared-web/browser/api-integration.ts', () => ({
    readStateWorkspaceStatsSummary: mocks.readStateWorkspaceStatsSummary,
    readStateGroupStats: mocks.readStateGroupStats,
    readStateMyRealtimeStatus: mocks.readStateMyRealtimeStatus
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: vi.fn(),
    getMiddleware: vi.fn(() => undefined),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady
}));

describe('Rallar stats facade compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readSession.mockReturnValue(mocks.session);
        mocks.isMiddlewareReady.mockReturnValue(false);
    });

    it('exposes rallar.stats helpers with default scope and current auth session', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        });

        await facade.stats.summary();
        await facade.stats.group('room-1', {
            scope: {
                applicationId: 'app-2',
                workspaceId: 'workspace-2'
            },
            timeoutMs: 100
        });
        await facade.stats.meRealtime();

        expect(mocks.readStateWorkspaceStatsSummary).toHaveBeenCalledWith(
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1'
            },
            {
                authSession: mocks.session,
                signal: expect.any(AbortSignal)
            }
        );
        expect(mocks.readStateGroupStats).toHaveBeenCalledWith(
            'room-1',
            {
                applicationId: 'app-2',
                workspaceId: 'workspace-2'
            },
            {
                authSession: mocks.session,
                signal: expect.any(AbortSignal)
            }
        );
        expect(mocks.readStateMyRealtimeStatus).toHaveBeenCalledWith(
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1'
            },
            {
                authSession: mocks.session,
                signal: expect.any(AbortSignal)
            }
        );
    });
});
