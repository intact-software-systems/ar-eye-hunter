import {
    createBrowserRuntimeFoundation,
    createBrowserStateEventComposition
} from '@shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const runtime = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const middleware = createApiMiddlewareTestDouble();

    return {
        middleware,
        initMiddleware: vi.fn<AppContextModule['initMiddleware']>(),
        readSession: vi.fn<AuthModule['readSession']>()
    };
});

vi.mock(
    import('@shared-web/browser/app-context.ts'),
    async (importOriginal): Promise<Partial<AppContextModule>> => ({
        ...await importOriginal(),
        clearMiddleware: vi.fn(),
        getMiddleware: () => runtime.middleware,
        initMiddleware: runtime.initMiddleware,
        isMiddlewareReady: () => false
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
        runtime.initMiddleware.mockResolvedValue(runtime.middleware);
        runtime.readSession.mockReturnValue(runtime.middleware.session);
    });

    it('does not let a room-event subscription reach an incomplete session port', () => {
        const foundation = createBrowserRuntimeFoundation();
        const stateEvents = createBrowserStateEventComposition({
            connectionRuntime: foundation.connectionRuntime,
            readSessionController: () => {
                throw new Error(
                    'state-event session port was used before construction completed'
                );
            }
        });

        expect(() => stateEvents.roomEvents.onEvent(() => undefined, {})).not.toThrow();
    });

    it('completes facade creation before later setup and connect use the composed ports', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();

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
