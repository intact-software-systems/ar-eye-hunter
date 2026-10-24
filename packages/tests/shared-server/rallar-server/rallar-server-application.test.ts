import type {
    AppDataConditionalDeleteResult,
    AppDataConditionalInsertResult,
    AppDataConditionalWriteResult,
    AppDataDeleteExpiredInput,
    AppDataDeleteIfRevisionInput,
    AppDataEntry,
    AppDataEntryPageInput,
    AppDataKey,
    AppDataRepository,
    AppDataUpsertIfRevisionInput,
    AppDataUpsertInput
} from '@shared-server/app-data/app-data-repository.ts';
import { createRallarServerApplication } from '@shared-server/mod.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { InMemoryQueueBox, JsonWebSocketServer } from '@shared/mod.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { createTestServerAppInbox } from './create-test-server-app-inbox.ts';

interface App {
    webSocketMounted: number;
    restMounted: number;
}

describe('RallarServerApplication', () => {
    it('exposes direct owners and invokes each explicit application phase once', async () => {
        const events: string[] = [];
        const service = createDefaultWsQueueBoxServerService({
            inboundVolatileStores: undefined,
            readAuthenticatedConnectionScope: () => undefined,
            outbox: new InMemoryQueueBox(),
            socket: new JsonWebSocketServer(),
            name: 'server-1'
        });
        onTestFinished(() => service.dispose());
        const runtime = {
            wsQBoxServerService: service,
            qboxEngine: {
                start: () => events.push('start'),
                wake: () => events.push('wake')
            }
        };
        const appInbox = createTestServerAppInbox();
        const operation = appInbox.register({
            type: 'app:settings:set',
            decodeEnvelope: (value) => value.data,
            encodeEnvelope: (value) => ({ data: value }),
            toBinding: () => ({ contextId: 'settings', resourceId: 'request' }),
            toLogicalCommand: (value) => value,
            materialize: (value) => value,
            encodeResult: (value) => value,
            decodeResult: (value) => value,
            handle: async () => null
        });
        const repositories = new RepositoryManager();
        const appDataRepository = new RecordingAppDataRepository();
        const app: App = {
            webSocketMounted: 0,
            restMounted: 0
        };
        const server = createRallarServerApplication<typeof runtime, App>({
            runtime,
            appInbox,
            repositories,
            appDataRepository,
            nowEpochMs: () => 1_000,
            ws: {},
            systemInstallers: {
                installSystemTopics: () => events.push('topics'),
                installWebSocketLifecycle: () => events.push('lifecycle')
            },
            routeInstallers: {
                webSocket: (target) => {
                    target.webSocketMounted += 1;
                    events.push('websocket-route');
                },
                rest: [function installTestRestRoutes (target) {
                    target.restMounted += 1;
                    events.push('rest-route');
                }]
            }
        });

        server.installSystemTopics().installSystemTopics();
        server.installWebSocketLifecycle().installWebSocketLifecycle();
        server.mountWebSocket(app).mountWebSocket(app);
        server.mountRest(app).mountRest(app);
        expect((await operation.readReplay(null))?.left).toMatchObject({ code: 'app-inbox-lifecycle-rejected' });
        server.start();
        expect(await operation.readReplay(null)).toBeUndefined();
        expect(server.appInbox).toBe(appInbox);

        const settings = await server.appData.open('settings', {
            codec: {
                schemaVersion: 1,
                encode: (value: string) => value,
                decode: (value) => {
                    if (typeof value !== 'string') {
                        throw new TypeError('Setting must be a string.');
                    }
                    return value;
                }
            }
        });
        await settings.set('theme', 'dark');

        expect(server.runtime).toBe(runtime);
        expect(server.repositories).toBe(repositories);
        expect(app).toEqual({
            webSocketMounted: 1,
            restMounted: 1
        });
        expect(events).toEqual([
            'topics',
            'lifecycle',
            'websocket-route',
            'rest-route',
            'start'
        ]);
        expect(
            await appDataRepository.findEntry({
                namespace: 'app',
                storeName: 'settings',
                key: 'theme'
            })
        ).toMatchObject({ value: 'dark' });
        runtime.qboxEngine.start = () => {
            throw new Error('Worker startup failed');
        };
        expect(() => server.start()).toThrow('Worker startup failed');
        expect((await operation.readReplay(null))?.left).toMatchObject({ code: 'app-inbox-lifecycle-rejected' });
    });
});

class RecordingAppDataRepository implements AppDataRepository {
    private readonly entries = new Map<string, AppDataEntry>();

    findEntry(input: AppDataKey): Promise<AppDataEntry | undefined> {
        return Promise.resolve(this.entries.get(this.toKey(input)));
    }

    findEntriesPage(input: AppDataEntryPageInput): Promise<readonly AppDataEntry[]> {
        return Promise.resolve(
            [...this.entries.values()]
                .filter((entry) =>
                    entry.namespace === input.namespace &&
                    entry.storeName === input.storeName
                )
                .slice(0, input.limit)
        );
    }

    upsert(input: AppDataUpsertInput): Promise<void> {
        this.entries.set(this.toKey(input), this.toEntry(input));
        return Promise.resolve();
    }

    insertIfAbsent(input: AppDataUpsertInput): Promise<AppDataConditionalInsertResult> {
        const current = this.entries.get(this.toKey(input));
        if (current) {
            return Promise.resolve({ status: 'exists', current });
        }
        const entry = this.toEntry(input);
        this.entries.set(this.toKey(input), entry);
        return Promise.resolve({ status: 'inserted', entry });
    }

    upsertIfRevision(input: AppDataUpsertIfRevisionInput): Promise<AppDataConditionalWriteResult> {
        const current = this.entries.get(this.toKey(input));
        if (!current || current.revision !== input.expectedRevision) {
            return Promise.resolve({ status: 'conflict', current });
        }
        const entry = this.toEntry(input, current.revision + 1);
        this.entries.set(this.toKey(input), entry);
        return Promise.resolve({ status: 'written', entry });
    }

    deleteByKey(input: AppDataKey): Promise<boolean> {
        return Promise.resolve(this.entries.delete(this.toKey(input)));
    }

    deleteIfRevision(input: AppDataDeleteIfRevisionInput): Promise<AppDataConditionalDeleteResult> {
        const current = this.entries.get(this.toKey(input));
        if (!current || current.revision !== input.expectedRevision) {
            return Promise.resolve({ status: 'conflict', current });
        }
        this.entries.delete(this.toKey(input));
        return Promise.resolve({ status: 'deleted', entry: current });
    }

    deleteExpired(input: AppDataDeleteExpiredInput): Promise<number> {
        let count = 0;
        for (const [key, entry] of this.entries) {
            if (entry.expireAtTimestamp <= input.expireAtOrBeforeTimestamp) {
                this.entries.delete(key);
                count += 1;
            }
        }
        return Promise.resolve(count);
    }

    private toEntry(input: AppDataUpsertInput, revision = 0): AppDataEntry {
        return {
            ...input,
            updatedTimestamp: '1970-01-01T00:00:01.000Z',
            revision
        };
    }

    private toKey(input: AppDataKey): string {
        return `${input.namespace}:${input.storeName}:${input.key}`;
    }
}
