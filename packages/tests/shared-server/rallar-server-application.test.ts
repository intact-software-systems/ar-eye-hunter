import { describe, expect, it, vi } from 'vitest';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { createRallarServerApplication } from '@shared-server/rallar-facade/RallarServerApplication.ts';

type App = {
    wsMounted: number;
    restMounted: number;
};

describe('RallarServerApplication', () => {
    it('mounts websocket and rest route installers idempotently and starts the engine', () => {
        const onAnyInboxMessageDo = vi.fn().mockReturnThis();
        const runtime = {
            wsQBoxServerService: {
                name: 'server-1',
                onAnyInboxMessageDo,
                removeAnyInboxMessageCallback: vi.fn(),
            } as unknown as WsQueueBoxServerService,
            qboxEngine: {
                start: vi.fn(),
            },
        };
        const app: App = {
            wsMounted: 0,
            restMounted: 0,
        };
        const server = createRallarServerApplication<typeof runtime, App>({
            runtime,
            routes: {
                ws: (target) => {
                    target.wsMounted += 1;
                },
                rest: [
                    (target) => {
                        target.restMounted += 1;
                    },
                ],
            },
        });

        server.ws.mount(app).mount(app);
        server.rest.mount(app).mount(app);
        server.start();

        expect(onAnyInboxMessageDo).toHaveBeenCalledTimes(1);
        expect(app).toEqual({
            wsMounted: 1,
            restMounted: 1,
        });
        expect(runtime.qboxEngine.start).toHaveBeenCalledTimes(1);
    });
});
