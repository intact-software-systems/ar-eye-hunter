import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type BrowserRuntimeCompositionModule = typeof import('@shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts');
type RallarDataModule = typeof import('@shared-web/browser/rallar-data.ts');
type RallarSessionModule = typeof import('@shared-web/browser/rallar-runtime/session.ts');
type RoomEventsModule = typeof import('@shared-web/browser/rooms/room-events.ts');
type RoomStateStoreModule = typeof import('@shared-web/browser/rooms/room-state-store.ts');

const construction = vi.hoisted(() => ({
    enabled: false,
    failures: [] as string[],
    pending: [] as Promise<void>[],
    middleware: undefined as ReturnType<typeof createApiMiddlewareTestDouble> | undefined,
    initMiddleware: vi.fn<AppContextModule['initMiddleware']>(),
    readSession: vi.fn<AuthModule['readSession']>()
}));

vi.mock(
    import('@shared-web/browser/app-context.ts'),
    async (importOriginal): Promise<Partial<AppContextModule>> => ({
        ...await importOriginal(),
        clearMiddleware: vi.fn(),
        getMiddleware: () => construction.middleware!,
        initMiddleware: construction.initMiddleware,
        isMiddlewareReady: () => false
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: () => true,
    readSession: construction.readSession,
    writeSession: vi.fn()
}));

vi.mock(
    import('@shared-web/browser/rooms/room-state-store.ts'),
    async (importOriginal): Promise<Partial<RoomStateStoreModule>> => {
        const actual = await importOriginal();
        return {
            ...actual,
            createRoomStateStore: (input) => {
                captureConstructionFailure('state-store cache reads', () => {
                    input.readCachedGroupSnapshots();
                });
                return actual.createRoomStateStore(input);
            }
        };
    }
);

vi.mock(
    import('@shared-web/browser/rooms/room-events.ts'),
    async (importOriginal): Promise<Partial<RoomEventsModule>> => {
        const actual = await importOriginal();
        return {
            ...actual,
            createRoomEvents: (input) => {
                captureConstructionFailure('state-events room subscription', () => {
                    input.retainWsInboxSubscription();
                });
                return actual.createRoomEvents(input);
            }
        };
    }
);

vi.mock(
    import('@shared-web/browser/rallar-data.ts'),
    async (importOriginal): Promise<Partial<RallarDataModule>> => {
        const actual = await importOriginal();
        return {
            ...actual,
            createRallarDataFacade: (input) => {
                captureConstructionFailure('session data scope', () => {
                    input.resolveScopeKey('session');
                });
                return actual.createRallarDataFacade(input);
            }
        };
    }
);

vi.mock(
    import('@shared-web/browser/rallar-runtime/session.ts'),
    async (importOriginal): Promise<Partial<RallarSessionModule>> => {
        const actual = await importOriginal();
        return {
            ...actual,
            createRallarSessionController: (input) => {
                const controller = actual.createRallarSessionController(input);
                if (construction.enabled) {
                    construction.pending.push(
                        input.start().then(
                            () => undefined,
                            (error) => {
                                construction.failures.push(
                                    `startup controller: ${error instanceof Error ? error.message : String(error)}`
                                );
                            }
                        )
                    );
                }
                return controller;
            }
        };
    }
);

vi.mock(
    import('@shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts'),
    async (importOriginal): Promise<Partial<BrowserRuntimeCompositionModule>> => {
        const actual = await importOriginal();
        return {
            ...actual,
            createBrowserStateEventComposition: (input) => {
                captureConstructionFailure('facade session controller', () => {
                    requireCompletedDependency(
                        'facade session controller',
                        input.readSessionController()
                    );
                });
                return actual.createBrowserStateEventComposition(input);
            }
        };
    }
);

describe('browser runtime construction', () => {
    beforeEach(() => {
        construction.enabled = true;
        construction.failures = [];
        construction.pending = [];
        construction.middleware = createApiMiddlewareTestDouble();
        construction.initMiddleware.mockResolvedValue(construction.middleware);
        construction.readSession.mockReturnValue(construction.middleware.session);
    });

    it('supplies each consumer a completed dependency through facade creation and later setup/connect', async () => {
        construction.enabled = false;
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        construction.enabled = true;
        const facade = createRallarFacade();

        await facade.setup({
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'construction-test',
            start: {
                refreshRooms: false
            }
        });
        await facade.connect();
        await Promise.all(construction.pending);

        expect(construction.failures).toEqual([]);
    });
});

function captureConstructionFailure(label: string, read: () => void): void {
    if (!construction.enabled) {
        return;
    }
    try {
        read();
    }
    catch (error) {
        construction.failures.push(
            `${label}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function requireCompletedDependency<T>(label: string, value: T | undefined): T {
    if (value === undefined) {
        throw new Error(`${label} was invoked before construction completed.`);
    }
    return value;
}
