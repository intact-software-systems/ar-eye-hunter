import {
    installRallarServerAiHttpRoute,
    type RallarServerAiHttpHandler,
    type RallarServerAiHttpRouter
} from '@shared-server/rallar-ai/install-rallar-server-ai-http-route.ts';
import { createRallarAiMockProvider } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';
import { createRallarServerAiTestRequest, createRallarServerAiTestService } from './rallar-server-ai-test-fixtures.ts';

describe('Rallar server AI HTTP route', () => {
    it('registers a typed route and passes explicit request identity to generation', async () => {
        const authorize = vi.fn(() => true);
        const serverAi = createRallarServerAiTestService({
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } }),
            authorize
        });
        const registration = createHttpRegistration();

        installRallarServerAiHttpRoute({
            router: registration.router,
            serverAi,
            path: '/ai/json'
        });
        const response = await registration.invoke({
            body: createRallarServerAiTestRequest(),
            actorId: 'host-1',
            roomId: 'room-1'
        });

        expect(registration.path).toBe('/ai/json');
        expect(response).toMatchObject({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { ok: true }
        });
        expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
            actorId: 'host-1',
            roomId: 'room-1'
        }));
    });

    it('rejects malformed request JSON at the HTTP boundary', async () => {
        const registration = createHttpRegistration();
        installRallarServerAiHttpRoute({
            router: registration.router,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            path: '/ai/json'
        });

        const response = await registration.invoke({ body: { prompt: 'missing schema' } });

        expect(response).toEqual({
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: {
                ok: false,
                error: {
                    code: 'invalid-json',
                    message: 'RallarAI generation request is malformed.'
                }
            }
        });
    });
});

interface HttpRegistration {
    readonly router: RallarServerAiHttpRouter;
    readonly path: string | undefined;
    invoke(request: Parameters<RallarServerAiHttpHandler>[0]): ReturnType<RallarServerAiHttpHandler>;
}

function createHttpRegistration(): HttpRegistration {
    let path: string | undefined;
    let handler: RallarServerAiHttpHandler | undefined;
    return {
        router: {
            post: (registeredPath, registeredHandler) => {
                path = registeredPath;
                handler = registeredHandler;
            }
        },
        get path() {
            return path;
        },
        invoke: async (request) => {
            if (handler === undefined) {
                throw new Error('RallarAI HTTP handler is not installed.');
            }
            return await handler(request);
        }
    };
}
