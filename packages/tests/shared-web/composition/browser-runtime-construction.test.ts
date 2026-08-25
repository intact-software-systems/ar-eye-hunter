import { createBrowserRuntimeFoundation } from '@shared-web/browser/composition/browser-runtime-composition.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { configureTestCacheRepositories } from '../../cache-repository-config.ts';

type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const runtime = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const middleware = createApiMiddlewareTestDouble();

    return {
        middleware,
        initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(),
        readSession: vi.fn<AuthModule['readSession']>()
    };
});

vi.mock(
    import('@shared-web/browser/middleware.ts'),
    async (importOriginal): Promise<Partial<MiddlewareModule>> => ({
        ...await importOriginal(),
        initialiseMiddleware: runtime.initialiseMiddleware
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: () => true,
    readSession: runtime.readSession,
    writeSession: vi.fn()
}));

describe('browser runtime construction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configureTestCacheRepositories();
        runtime.initialiseMiddleware.mockResolvedValue(runtime.middleware.middleware);
        runtime.readSession.mockReturnValue(runtime.middleware.session);
    });

    it('keeps browser runtime state isolated per completed facade foundation', () => {
        const foundation = createBrowserRuntimeFoundation();

        expect(foundation.connectionRuntime.readMiddleware()).toBeUndefined();
    });

    it('completes facade creation before later setup and connect use the composed ports', async () => {
        let facadeConstructionCompleted = false;
        runtime.readSession.mockImplementation(() => {
            if (!facadeConstructionCompleted) {
                throw new Error('Session dependency was used before facade construction completed.');
            }
            return runtime.middleware.session;
        });
        runtime.initialiseMiddleware.mockImplementation(async () => {
            if (!facadeConstructionCompleted) {
                throw new Error('Transport dependency was used before facade construction completed.');
            }
            return runtime.middleware.middleware;
        });
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        facadeConstructionCompleted = true;

        await facade.setup({
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'construction-test',
            start: {
                restoreSession: false,
                connect: false,
                refreshRooms: false,
                refreshPeople: false
            }
        });
        await facade.connect();

        expect(facade.status()).toBe('connected');
        expect(facade.isConnected()).toBe(true);
    });
});
