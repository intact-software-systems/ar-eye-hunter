import { createRallarServerApplication } from '@shared-server/rallar-facade/rallar-server-application.ts';
import { InMemoryQueueBox, JsonWebSocketServer } from '@shared/mod.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { describe, expect, it } from 'vitest';

interface App {
    wsMounted: number;
    restMounted: number;
}

describe('RallarServerApplication', () => {
    it('mounts websocket and rest route installers idempotently and starts the engine', () => {
        const service = new RecordingWsQueueBoxServerService(
            new InMemoryQueueBox(),
            new InMemoryQueueBox(),
            new JsonWebSocketServer(),
            'server-1'
        );
        const runtime = {
            wsQBoxServerService: service,
            qboxEngine: {
                started: false,
                start() {
                    this.started = true;
                }
            }
        };
        const app: App = {
            wsMounted: 0,
            restMounted: 0
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
                    }
                ]
            }
        });

        server.ws.mount(app).mount(app);
        server.rest.mount(app).mount(app);
        server.start();

        expect(service.registeredAnyInboxOwnerIds()).toEqual([]);
        expect(app).toEqual({
            wsMounted: 1,
            restMounted: 1
        });
        expect(runtime.qboxEngine.started).toBe(true);
    });
});

class RecordingWsQueueBoxServerService extends WsQueueBoxServerService {
    private readonly anyInboxOwners = new Set<string>();

    override onAnyInboxMessageDo(
        id: string,
        callback: Parameters<WsQueueBoxServerService['onAnyInboxMessageDo']>[1]
    ): this {
        this.anyInboxOwners.add(id);
        super.onAnyInboxMessageDo(id, callback);
        return this;
    }

    registeredAnyInboxOwnerIds(): readonly string[] {
        return [...this.anyInboxOwners];
    }
}
