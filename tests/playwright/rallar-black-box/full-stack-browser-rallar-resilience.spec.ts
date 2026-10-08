import {
    expect,
    test,
    type APIRequestContext,
    type JSHandle,
    type Page,
    type Route
} from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    validateAuthoritativeClientEventList,
    validateAuthoritativeClientSnapshot,
    validateAuthoritativeGroupSnapshot
} from '@shared/api/authoritative-state-validation.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventCursor } from '@shared/api/state-event-types.ts';

import {
    decodeFullStackAuthSession,
    expectFullStackApiReady,
    loginThroughUi,
    readBrowserAuthSession,
    readFullStackConfig,
    uniqueSuffix,
    type FullStackUser
} from './full-stack-helpers.ts';

interface WsLifecycleRecord {
    kind: string;
    readyState: string;
    isOpen: boolean;
    intentional?: boolean;
    code?: number;
    reason?: string;
}

interface RtcLifecycleRecord {
    kind: string;
    peerId?: string;
    laneId?: string;
    readyPeerIds: readonly string[];
}

interface RealtimeProbeMessage {
    peerId: string;
    laneId: string;
    readonly data: RealtimeProbePayload;
}

interface CapturedMutationRequest {
    requestId?: string;
    groupId?: string;
}

interface RoomReplayProbe {
    readonly groupId: string;
    readonly createdCursor: StateEventCursor;
    readonly liveEvents: GroupEvent[];
    readonly replayEvents: GroupEvent[];
    cleanup(): Promise<void>;
}

interface RealtimeSenderProbe {
    readonly roomId: string;
    readonly senderSessionId: string;
    readonly rtcLifecycle: RtcLifecycleRecord[];
    cleanup(): Promise<void>;
}

interface RealtimeReceiverProbe {
    readonly receiverSessionId: string;
    readonly activeSessionIds: readonly string[];
    readonly received: RealtimeProbeMessage[];
    readonly rtcLifecycle: RtcLifecycleRecord[];
    cleanup(): Promise<void>;
}

interface RealtimeProbePayload {
    readonly payloadId?: string;
    readonly direction?: string;
}

const config = readFullStackConfig();
const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..'
);
const rallarModuleUrl = `/@fs${path.join(repoRoot, 'packages/shared-web/browser/rallar.ts')}`;

test.describe('full-stack Browser Rallar resilience', () => {
    test.skip(!config.enabled, config.skipReason);

    test('retries transient room create and presence connect failures with stable request IDs', async ({ page, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const createRequests: CapturedMutationRequest[] = [];
        const presenceRequests: CapturedMutationRequest[] = [];
        let createFailedOnce = false;
        let presenceFailedOnce = false;

        try {
            await loginThroughUi({ page, config, user: config.userA, suffix: `retry-${suffix}`, tab: 'manual-rallar' });

            await page.route(
                '**/api/state/apps/ar-eye-hunter/workspaces/default/groups',
                async (route) => {
                    if (route.request().method() === 'POST') {
                        createRequests.push(readJsonBody(route.request().postData()));
                        if (!createFailedOnce) {
                            createFailedOnce = true;
                            await fulfillTransient(route, 503, 'transient group create failure');
                            return;
                        }
                    }

                    await route.continue();
                }
            );

            await page.route(
                /\/api\/state\/apps\/ar-eye-hunter\/workspaces\/default\/groups\/[^/]+\/sessions\/[^/]+$/,
                async (route) => {
                    if (route.request().method() === 'PUT') {
                        presenceRequests.push(readJsonBody(route.request().postData()));
                        if (!presenceFailedOnce) {
                            presenceFailedOnce = true;
                            await fulfillTransient(route, 429, 'transient presence rate limit');
                            return;
                        }
                    }

                    await route.continue();
                }
            );

            const result = await page.evaluate(
                async ({ apiBaseUrl, moduleUrl, roomName }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default'
                    });

                    const session = rallar.session();
                    if (!session) {
                        throw new Error('Expected a browser Rallar session after UI login.');
                    }

                    const snapshot = await rallar.rooms.create({
                        displayName: roomName,
                        maxAttempts: 3,
                        timeoutMs: 20_000
                    });

                    return {
                        groupId: snapshot.group.groupId,
                        sessionId: session.sessionId,
                        activeSessionIds: snapshot.activeSessions.map((entry) => entry.sessionId)
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    roomName: `Retry Room ${suffix}`
                }
            );

            expect(createRequests).toHaveLength(2);
            expect(createRequests[0].requestId).toBeTruthy();
            expect(createRequests[1].requestId).toBe(createRequests[0].requestId);
            expect(createRequests[1].groupId).toBe(createRequests[0].groupId);
            expect(presenceRequests).toHaveLength(2);
            expect(presenceRequests[0].requestId).toBeTruthy();
            expect(presenceRequests[1].requestId).toBe(presenceRequests[0].requestId);
            expect(result.activeSessionIds).toContain(result.sessionId);

            const session = await readBrowserAuthSession(page);
            const persisted = await getGroupSnapshot(
                request,
                result.groupId,
                session
            );
            expect(persisted.group.groupId).toBe(result.groupId);
        }
        finally {
            await disconnectBrowserRallar(page);
        }
    });

    test('disconnects WS client state when API logout deletes auth before socket close', async ({ page, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        try {
            await loginThroughUi({
                page,
                config,
                user: config.userA,
                suffix: `logout-race-${suffix}`,
                tab: 'manual-rallar'
            });

            const connected = await page.evaluate(
                async ({ apiBaseUrl, moduleUrl }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    const session = rallar.session();
                    if (!session) {
                        throw new Error('Expected a browser Rallar session after UI login.');
                    }

                    await rallar.connect({ timeoutMs: 20_000 });

                    return {
                        clientId: session.clientId,
                        sessionId: session.sessionId,
                        accessToken: session.accessToken
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl
                }
            );

            await expect.poll(async () => {
                const snapshot = await getClientSnapshot(
                    request,
                    connected.clientId,
                    connected
                );
                return hasActiveSession(snapshot, connected.sessionId);
            }, {
                timeout: 30_000
            }).toBe(true);

            const logoutStatus = await page.evaluate(
                async ({ apiBaseUrl, session }) => {
                    const requestId = crypto.randomUUID();
                    const response = await fetch(
                        `${apiBaseUrl}/api/auth/logout/requests/${requestId}`,
                        {
                            method: 'POST',
                            headers: {
                                authorization: `Bearer ${session.accessToken}`,
                                'content-type': 'application/json',
                                'x-client-id': session.clientId
                            },
                            body: JSON.stringify({})
                        }
                    );
                    return response.status;
                },
                { apiBaseUrl: config.apiBaseUrl, session: await readBrowserAuthSession(page) }
            );
            expect(logoutStatus).toBe(200);

            const closeResult = await page.evaluate(
                async ({ moduleUrl }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    const before = rallar.ws.status();
                    rallar.advanced.middleware().middleware.webSocketQueueBox.close(
                        1000,
                        'auth-deleted-before-close-test'
                    );
                    localStorage.removeItem('auth.session');
                    return {
                        readyStateBeforeClose: before.readyState,
                        reconnectEnabledBeforeClose: before.reconnectEnabled
                    };
                },
                { moduleUrl: rallarModuleUrl }
            );
            expect(closeResult.readyStateBeforeClose).toBe('open');

            const freshSession = await loginViaApi(request);
            await expect.poll(async () => {
                const [snapshot, events] = await Promise.all([
                    getClientSnapshot(request, connected.clientId, freshSession),
                    getClientEvents(request, connected.clientId, freshSession)
                ]);

                return {
                    oldSessionStillActive: hasActiveSession(snapshot, connected.sessionId),
                    disconnectedEvent: events.some((event) =>
                        event.eventType === 'session-disconnected' &&
                        event.sessionId === connected.sessionId
                    )
                };
            }, {
                timeout: 45_000
            }).toEqual({
                oldSessionStillActive: false,
                disconnectedEvent: true
            });
        }
        finally {
            await disconnectBrowserRallar(page);
        }
    });

    test('recovers missed room events through explicit replay after browser reconnect', async ({ browser, page, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const browserBContext = await browser.newContext();
        let roomProbe: JSHandle<RoomReplayProbe> | undefined;
        try {
            const browserBPage = await browserBContext.newPage();
            await loginThroughUi({
                page,
                config,
                user: config.userA,
                suffix: `replay-a-${suffix}`,
                tab: 'manual-rallar'
            });
            await loginThroughUi({
                page: browserBPage,
                config,
                user: config.userB,
                suffix: `replay-b-${suffix}`,
                tab: 'manual-rallar'
            });

            const acquiredRoomProbe = await page.evaluateHandle(
                async ({ apiBaseUrl, moduleUrl, roomName }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default'
                    });

                    const liveEvents: GroupEvent[] = [];
                    const replayEvents: GroupEvent[] = [];
                    await rallar.connect({ timeoutMs: 20_000 });
                    const snapshot = await rallar.rooms.create({
                        displayName: roomName,
                        timeoutMs: 20_000,
                        maxAttempts: 3
                    });
                    const groupId = snapshot.group.groupId;
                    const createdEvents = await rallar.rooms.listEvents({
                        roomId: groupId,
                        eventTypes: ['group-created'],
                        limit: 1,
                        timeoutMs: 20_000
                    });
                    const createdEvent = createdEvents.at(-1);
                    if (!createdEvent) {
                        throw new Error('Expected group-created event.');
                    }

                    const unsubscribe = rallar.rooms.onEvent((event) => {
                        liveEvents.push(event);
                    }, {
                        roomId: groupId,
                        eventTypes: ['member-joined', 'member-left']
                    });

                    return {
                        groupId,
                        liveEvents,
                        replayEvents,
                        cleanup: async () => {
                            unsubscribe();
                            await rallar.disconnect();
                        },
                        createdCursor: {
                            snapshotVersion: createdEvent.snapshotVersion,
                            occurredAtEpochMs: createdEvent.occurredAtEpochMs,
                            eventId: createdEvent.eventId
                        }
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    roomName: `Replay Room ${suffix}`
                }
            );

            roomProbe = acquiredRoomProbe;
            const created = await roomProbe.evaluate((probe) => ({
                groupId: probe.groupId,
                createdCursor: probe.createdCursor
            }));

            const joined = await browserBPage.evaluate(
                async ({ apiBaseUrl, moduleUrl, groupId }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default'
                    });

                    await rallar.rooms.join(groupId, {
                        timeoutMs: 20_000,
                        maxAttempts: 3
                    });

                    const session = rallar.session();
                    if (!session) {
                        throw new Error('Expected Browser B Rallar session.');
                    }

                    return {
                        clientId: session.clientId
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    groupId: created.groupId
                }
            );

            await expect.poll(async () => {
                return await acquiredRoomProbe.evaluate((probe) =>
                    probe.liveEvents.some((event) => event.eventType === 'member-joined')
                );
            }, {
                timeout: 30_000
            }).toBe(true);

            await page.evaluate(async ({ moduleUrl }) => {
                const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                await rallar.disconnect();
            }, { moduleUrl: rallarModuleUrl });

            await browserBPage.evaluate(
                async ({ moduleUrl, groupId }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    await rallar.rooms.leave({
                        roomId: groupId,
                        clearCurrent: false,
                        timeoutMs: 20_000,
                        maxAttempts: 3
                    });
                },
                {
                    moduleUrl: rallarModuleUrl,
                    groupId: created.groupId
                }
            );

            const result = await page.evaluate(
                async ({ apiBaseUrl, moduleUrl, groupId, createdCursor, principalId, probe }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    await rallar.connect({ timeoutMs: 20_000 });

                    const roomState = await rallar.rooms.refresh({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default'
                    });
                    const refreshedRoom = roomState.rooms.find(
                        (room) => room.roomId === groupId
                    )?.snapshot;

                    const replayResult = await rallar.rooms.replayEvents(
                        {
                            roomId: groupId,
                            eventTypes: ['member-joined', 'member-left'],
                            after: createdCursor,
                            limit: 10,
                            timeoutMs: 20_000
                        },
                        (event) => {
                            probe.replayEvents.push(event);
                        }
                    );

                    return {
                        groupId,
                        createdCursor,
                        liveEvents: probe.liveEvents,
                        replayEvents: probe.replayEvents,
                        replayResult,
                        refreshedMemberStatus: refreshedRoom?.members.find(
                            (member) => member.principalId === principalId
                        )?.status
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    groupId: created.groupId,
                    createdCursor: created.createdCursor,
                    principalId: joined.clientId,
                    probe: roomProbe
                }
            );

            expect(result.liveEvents.map((event) => event.eventType)).toContain(
                'member-joined'
            );
            expect(result.replayEvents.map((event) => event.eventType)).toEqual([
                'member-left'
            ]);
            expect(result.replayResult.duplicateCount).toBeGreaterThanOrEqual(1);
            expect(result.replayResult.replayedCount).toBe(1);
            expect(result.replayResult.pageCount).toBe(1);
            expect(result.replayResult.hasMore).toBe(false);
            expect(result.refreshedMemberStatus).toBe('left');
            expect(
                result.liveEvents.filter((event) => event.eventType === 'member-left')
            ).toHaveLength(0);
        }
        finally {
            try {
                if (roomProbe !== undefined) {
                    await roomProbe.evaluate((probe) => probe.cleanup());
                    await roomProbe.dispose();
                }
            }
            finally {
                await browserBContext.close();
            }
        }
    });

    test('replays missed people events and reports WS lifecycle around reconnect', async ({ page, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const user = uniqueRegisteredUser(config.userA, 'people', suffix);
        await loginThroughUi({
            page,
            config,
            user,
            suffix: `people-replay-${suffix}`,
            tab: 'manual-rallar',
            registerBeforeLogin: true
        });

        const peopleProbe = await page.evaluateHandle(
            async ({ apiBaseUrl, moduleUrl }) => {
                const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                rallar.configure({ apiBaseUrl });
                rallar.setDefaults({
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default'
                });

                const liveEvents: ClientEvent[] = [];
                const replayEvents: ClientEvent[] = [];
                const wsLifecycle: WsLifecycleRecord[] = [];
                const session = rallar.session();
                if (!session) {
                    throw new Error('Expected a browser Rallar session after UI login.');
                }

                const unsubscribeWs = rallar.ws.onLifecycle((event) => {
                    wsLifecycle.push({
                        kind: event.kind,
                        readyState: event.status.readyState,
                        isOpen: event.status.isOpen,
                        intentional: event.intentional,
                        code: event.code,
                        reason: event.reason
                    });
                });

                const unsubscribePeople = rallar.people.onEvent((event) => {
                    liveEvents.push(event);
                }, {
                    principalId: session.clientId,
                    eventTypes: ['session-connected', 'session-disconnected']
                });

                const cleanup = async (): Promise<void> => {
                    unsubscribePeople();
                    unsubscribeWs();
                    await rallar.disconnect();
                };
                try {
                    await rallar.connect({ timeoutMs: 20_000 });
                    const wsOpen = await rallar.ws.waitForOpen({ timeoutMs: 20_000 });

                    return {
                        liveEvents,
                        replayEvents,
                        wsLifecycle,
                        cleanup,
                        clientId: session.clientId,
                        sessionId: session.sessionId,
                        wsOpenStatus: wsOpen.status,
                        wsStatusOpen: wsOpen.wsStatus.isOpen
                    };
                }
                catch (error) {
                    try {
                        await cleanup();
                    }
                    catch (cleanupError) {
                        throw new AggregateError([error, cleanupError], 'Probe acquisition and cleanup failed.', {
                            cause: error
                        });
                    }
                    throw error;
                }
            },
            {
                apiBaseUrl: config.apiBaseUrl,
                moduleUrl: rallarModuleUrl
            }
        );

        try {
            const connected = await peopleProbe.evaluate((probe) => ({
                clientId: probe.clientId,
                sessionId: probe.sessionId,
                wsOpenStatus: probe.wsOpenStatus,
                wsStatusOpen: probe.wsStatusOpen
            }));

            expect(connected.wsOpenStatus).toBe('open');
            expect(connected.wsStatusOpen).toBe(true);

            let connectedCursor: StateEventCursor | undefined;
            await expect.poll(async () => {
                connectedCursor = await page.evaluate(
                    async ({ moduleUrl, clientId, sessionId }) => {
                        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                        const events = await rallar.people.listEvents(clientId, {
                            eventTypes: ['session-connected'],
                            limit: 5,
                            timeoutMs: 20_000
                        });
                        const event = [...events].reverse().find(
                            (candidate) =>
                                candidate.sessionId === sessionId &&
                                candidate.eventType === 'session-connected'
                        );
                        return event
                            ? {
                                snapshotVersion: event.snapshotVersion,
                                occurredAtEpochMs: event.occurredAtEpochMs,
                                eventId: event.eventId
                            }
                            : undefined;
                    },
                    {
                        moduleUrl: rallarModuleUrl,
                        clientId: connected.clientId,
                        sessionId: connected.sessionId
                    }
                );
                return connectedCursor !== undefined;
            }, {
                timeout: 30_000
            }).toBe(true);
            expect(connectedCursor).toBeDefined();
            if (connectedCursor === undefined) {
                throw new Error('Expected an observed connected-event cursor.');
            }

            await page.evaluate(async ({ moduleUrl }) => {
                const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                await rallar.disconnect();
            }, { moduleUrl: rallarModuleUrl });

            await expect.poll(async () => {
                return await page.evaluate(
                    async ({ moduleUrl, clientId, sessionId }) => {
                        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                        const events = await rallar.people.listEvents(clientId, {
                            eventTypes: ['session-disconnected'],
                            limit: 10,
                            timeoutMs: 20_000
                        });
                        return events.some((event) =>
                            event.sessionId === sessionId &&
                            event.eventType === 'session-disconnected'
                        );
                    },
                    {
                        moduleUrl: rallarModuleUrl,
                        clientId: connected.clientId,
                        sessionId: connected.sessionId
                    }
                );
            }, {
                timeout: 45_000
            }).toBe(true);

            const result = await page.evaluate(
                async ({ apiBaseUrl, moduleUrl, clientId, after, probe }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });

                    await rallar.connect({ timeoutMs: 20_000 });
                    const wsOpen = await rallar.ws.waitForOpen({ timeoutMs: 20_000 });
                    const peopleState = await rallar.people.refresh({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default',
                        timeoutMs: 20_000
                    });

                    const replayResult = await rallar.people.replayEvents(
                        clientId,
                        {
                            eventTypes: ['session-connected', 'session-disconnected'],
                            after,
                            limit: 10,
                            timeoutMs: 20_000
                        },
                        (event) => {
                            probe.replayEvents.push(event);
                        }
                    );

                    const session = rallar.session();
                    if (!session) {
                        throw new Error('Expected Rallar session after reconnect.');
                    }

                    return {
                        clientId,
                        sessionId: session.sessionId,
                        wsOpenStatus: wsOpen.status,
                        wsStatusOpen: wsOpen.wsStatus.isOpen,
                        liveEvents: probe.liveEvents,
                        replayEvents: probe.replayEvents,
                        replayResult,
                        peopleStateIncludesSelf: peopleState.people.some(
                            (person) => person.principalId === clientId && person.isOnline
                        ),
                        wsLifecycle: probe.wsLifecycle
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    clientId: connected.clientId,
                    after: connectedCursor,
                    probe: peopleProbe
                }
            );

            expect(result.wsOpenStatus).toBe('open');
            expect(result.wsStatusOpen).toBe(true);
            expect(result.peopleStateIncludesSelf).toBe(true);
            expect(result.replayEvents.map((event) => event.eventType)).toContain(
                'session-disconnected'
            );
            expect(result.replayResult.replayedCount).toBeGreaterThanOrEqual(1);
            expect(result.replayResult.pageCount).toBe(1);
            expect(result.replayResult.hasMore).toBe(false);
            expect(result.wsLifecycle.map((event) => event.kind)).toEqual(
                expect.arrayContaining(['snapshot', 'connected', 'disconnected'])
            );
            expect(result.wsLifecycle.some((event) =>
                event.kind === 'disconnected' &&
                event.intentional === true &&
                event.reason === 'rallar-disconnect'
            )).toBe(true);
        }
        finally {
            await peopleProbe.evaluate((probe) => probe.cleanup());
            await peopleProbe.dispose();
        }
    });

    test('waits for RTC room lane and delivers realtime JSON through direct Rallar facade', async ({ browser, page, request }) => {
        test.setTimeout(150_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const userA = uniqueRegisteredUser(config.userA, 'direct-rtc-a', suffix);
        const userB = uniqueRegisteredUser(config.userB, 'direct-rtc-b', suffix);
        const browserBContext = await browser.newContext();
        let senderProbe: JSHandle<RealtimeSenderProbe> | undefined;
        let receiverProbe: JSHandle<RealtimeReceiverProbe> | undefined;
        try {
            const browserBPage = await browserBContext.newPage();
            await loginThroughUi({
                page,
                config,
                user: userA,
                suffix: `direct-rtc-a-${suffix}`,
                tab: 'manual-rallar',
                registerBeforeLogin: true
            });
            await loginThroughUi({
                page: browserBPage,
                config,
                user: userB,
                suffix: `direct-rtc-b-${suffix}`,
                tab: 'manual-rallar',
                registerBeforeLogin: true
            });

            senderProbe = await page.evaluateHandle(
                async ({ apiBaseUrl, moduleUrl, roomName }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default'
                    });

                    const rtcLifecycle: RtcLifecycleRecord[] = [];
                    const unsubscribeLifecycle = rallar.rtc.onLifecycle((event) => {
                        rtcLifecycle.push({
                            kind: event.kind,
                            peerId: event.peerId,
                            laneId: event.laneId,
                            readyPeerIds: event.status.readyPeerIds
                        });
                    }, {
                        laneId: 'realtime'
                    });

                    const cleanup = async (): Promise<void> => {
                        unsubscribeLifecycle();
                        await rallar.disconnect();
                    };
                    try {
                        await rallar.connect({ timeoutMs: 20_000 });
                        await rallar.ws.waitForOpen({ timeoutMs: 20_000 });
                        const snapshot = await rallar.rooms.create({
                            displayName: roomName,
                            timeoutMs: 20_000,
                            maxAttempts: 3
                        });
                        const session = rallar.session();
                        if (!session) {
                            throw new Error('Expected sender Rallar session.');
                        }

                        return {
                            rtcLifecycle,
                            cleanup,
                            roomId: snapshot.group.groupId,
                            senderSessionId: session.sessionId
                        };
                    }
                    catch (error) {
                        try {
                            await cleanup();
                        }
                        catch (cleanupError) {
                            throw new AggregateError([error, cleanupError], 'Probe acquisition and cleanup failed.', {
                                cause: error
                            });
                        }
                        throw error;
                    }
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    roomName: `Direct RTC Room ${suffix}`
                }
            );

            const created = await senderProbe.evaluate((probe) => ({
                roomId: probe.roomId,
                senderSessionId: probe.senderSessionId
            }));
            const acquiredReceiverProbe = await browserBPage.evaluateHandle(
                async ({ apiBaseUrl, moduleUrl, groupId }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default'
                    });

                    const received: RealtimeProbeMessage[] = [];
                    const rtcLifecycle: RtcLifecycleRecord[] = [];
                    const unsubscribeLifecycle = rallar.rtc.onLifecycle((event) => {
                        rtcLifecycle.push({
                            kind: event.kind,
                            peerId: event.peerId,
                            laneId: event.laneId,
                            readyPeerIds: event.status.readyPeerIds
                        });
                    }, {
                        laneId: 'realtime'
                    });
                    const unsubscribeMessages = rallar.realtime.onJson<RealtimeProbePayload>(
                        'realtime',
                        (message) => {
                            received.push({
                                peerId: message.peerId,
                                laneId: message.laneId,
                                data: message.data
                            });
                        }
                    );

                    const cleanup = async (): Promise<void> => {
                        unsubscribeMessages();
                        unsubscribeLifecycle();
                        await rallar.disconnect();
                    };
                    try {
                        await rallar.connect({ timeoutMs: 20_000 });
                        await rallar.ws.waitForOpen({ timeoutMs: 20_000 });
                        const snapshot = await rallar.rooms.join(groupId, {
                            timeoutMs: 20_000,
                            maxAttempts: 3
                        });
                        const session = rallar.session();
                        if (!session) {
                            throw new Error('Expected receiver Rallar session.');
                        }

                        return {
                            received,
                            rtcLifecycle,
                            cleanup,
                            receiverSessionId: session.sessionId,
                            activeSessionIds: snapshot.activeSessions.map(
                                (entry) => entry.sessionId
                            )
                        };
                    }
                    catch (error) {
                        try {
                            await cleanup();
                        }
                        catch (cleanupError) {
                            throw new AggregateError([error, cleanupError], 'Probe acquisition and cleanup failed.', {
                                cause: error
                            });
                        }
                        throw error;
                    }
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    groupId: created.roomId
                }
            );

            receiverProbe = acquiredReceiverProbe;
            const joined = await receiverProbe.evaluate((probe) => ({
                receiverSessionId: probe.receiverSessionId,
                activeSessionIds: probe.activeSessionIds
            }));
            expect(joined.activeSessionIds).toContain(created.senderSessionId);
            expect(joined.activeSessionIds).toContain(joined.receiverSessionId);

            const payloadId = `direct-realtime-${suffix}`;
            const sent = await page.evaluate(
                async ({ moduleUrl, groupId, payloadId }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    await rallar.rooms.refresh({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default',
                        timeoutMs: 20_000
                    });
                    const waitResult = await rallar.rtc.waitForRoomLane(
                        groupId,
                        'realtime',
                        {
                            connect: true,
                            timeoutMs: 20_000
                        }
                    );
                    const sendResults = await rallar.realtime.sendJson({
                        roomId: groupId,
                        laneId: 'realtime',
                        openTimeoutMs: 20_000,
                        data: {
                            payloadId,
                            direction: 'a-to-b'
                        }
                    });

                    return {
                        waitResult: {
                            status: waitResult.status,
                            readyCount: waitResult.ready.length,
                            notReadyCount: waitResult.notReady.length
                        },
                        sendResults,
                        senderReadyPeerIds: rallar.rtc.readyPeerIds('realtime')
                    };
                },
                {
                    moduleUrl: rallarModuleUrl,
                    groupId: created.roomId,
                    payloadId
                }
            );

            expect(sent.waitResult).toEqual({
                status: 'open',
                readyCount: 1,
                notReadyCount: 0
            });
            expect(sent.sendResults).toHaveLength(1);
            expect(sent.sendResults[0]).toMatchObject({
                peerId: joined.receiverSessionId,
                laneId: 'realtime',
                result: {
                    status: 'sent'
                }
            });

            await expect.poll(async () => {
                return await acquiredReceiverProbe.evaluate(
                    (probe, expectedPayloadId) =>
                        probe.received.some((message) =>
                            message.laneId === 'realtime' && message.data.payloadId === expectedPayloadId
                        ),
                    payloadId
                );
            }, {
                timeout: 45_000
            }).toBe(true);

            const result = await browserBPage.evaluate(
                async ({ moduleUrl, probe }) => {
                    const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
                    return {
                        received: probe.received,
                        receiverReadyPeerIds: rallar.rtc.readyPeerIds('realtime'),
                        receiverLifecycle: probe.rtcLifecycle
                    };
                },
                {
                    moduleUrl: rallarModuleUrl,
                    probe: receiverProbe
                }
            );

            const senderCapture = await senderProbe.evaluate((probe) => ({ senderLifecycle: probe.rtcLifecycle }));

            expect(result.received).toContainEqual(
                expect.objectContaining({
                    peerId: created.senderSessionId,
                    laneId: 'realtime',
                    data: expect.objectContaining({
                        payloadId,
                        direction: 'a-to-b'
                    })
                })
            );
            expect(sent.senderReadyPeerIds).toContain(joined.receiverSessionId);
            expect(result.receiverReadyPeerIds).toContain(created.senderSessionId);
            expect(senderCapture.senderLifecycle.map((event) => event.kind))
                .toEqual(expect.arrayContaining(['connected', 'peer-created', 'lane-open']));
            expect(result.receiverLifecycle.map((event) => event.kind))
                .toEqual(expect.arrayContaining(['connected', 'peer-created', 'lane-open']));
        }
        finally {
            try {
                const cleanup = await Promise.allSettled([
                    senderProbe?.evaluate((probe) => probe.cleanup()),
                    receiverProbe?.evaluate((probe) => probe.cleanup())
                ]);
                const failures = cleanup.filter((result) => result.status === 'rejected').map((result) =>
                    result.reason
                );
                if (failures.length > 0) {
                    throw new AggregateError(failures, 'RTC probe cleanup failed.');
                }
            }
            finally {
                await Promise.all([senderProbe?.dispose(), receiverProbe?.dispose(), browserBContext.close()]);
            }
        }
    });
});

function readJsonBody(raw: string | null): CapturedMutationRequest {
    if (!raw) {
        return {};
    }

    const body: unknown = JSON.parse(raw);
    if (
        !isJsonRecordValue(body) || (body.requestId !== undefined && typeof body.requestId !== 'string') ||
        (body.groupId !== undefined && typeof body.groupId !== 'string')
    ) {
        throw new Error('Invalid captured mutation request.');
    }
    return {
        ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
        ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {})
    };
}

function authHeaders(
    session: Pick<AuthSession, 'accessToken' | 'clientId'>
): Record<string, string> {
    return {
        authorization: `Bearer ${session.accessToken}`,
        'x-client-id': session.clientId
    };
}

function hasActiveSession(
    snapshot: ClientSnapshot,
    sessionId: string
): boolean {
    return snapshot.activeSessions.some((session) =>
        session.sessionId === sessionId &&
        session.status === 'active'
    );
}

function uniqueRegisteredUser(
    base: FullStackUser,
    label: string,
    suffix: string
): FullStackUser {
    const id = `${base.actor}-${label}-${suffix}`.replace(
        /[^a-zA-Z0-9_.-]/g,
        '-'
    );
    return {
        username: id,
        password: base.password,
        clientId: id,
        actor: id
    };
}

async function fulfillTransient(
    route: Route,
    status: number,
    body: string
): Promise<void> {
    const origin = route.request().headers().origin ?? 'http://localhost:5176';
    await route.fulfill({
        status,
        contentType: 'text/plain',
        headers: {
            'access-control-allow-credentials': 'true',
            'access-control-allow-origin': origin
        },
        body
    });
}

async function loginViaApi(
    request: APIRequestContext
): Promise<AuthSession> {
    const response = await request.post(
        `${config.apiBaseUrl}/api/auth/login/requests/${crypto.randomUUID()}`,
        {
            data: {
                username: config.userA.username,
                password: config.userA.password
            }
        }
    );
    expect(response.ok()).toBe(true);
    return decodeFullStackAuthSession(await response.json());
}

async function getGroupSnapshot(
    request: APIRequestContext,
    groupId: string,
    session: AuthSession
): Promise<GroupSnapshot> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/groups/${encodeURIComponent(groupId)}`,
        { headers: authHeaders(session) }
    );
    expect(response.ok()).toBe(true);
    const snapshot: unknown = await response.json();
    validateAuthoritativeGroupSnapshot(snapshot, { applicationId: 'ar-eye-hunter', workspaceId: 'default' });
    expect(snapshot.group.groupId).toBe(groupId);
    return snapshot;
}

async function getClientSnapshot(
    request: APIRequestContext,
    clientId: string,
    session: Pick<AuthSession, 'accessToken' | 'clientId'>
): Promise<ClientSnapshot> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/clients/${encodeURIComponent(clientId)}`,
        { headers: authHeaders(session) }
    );
    expect(response.ok()).toBe(true);
    const snapshot: unknown = await response.json();
    validateAuthoritativeClientSnapshot(snapshot, { applicationId: 'ar-eye-hunter', workspaceId: 'default' });
    expect(snapshot.principal.principalId).toBe(clientId);
    return snapshot;
}

async function getClientEvents(
    request: APIRequestContext,
    clientId: string,
    session: AuthSession
): Promise<readonly ClientEvent[]> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/clients/${
            encodeURIComponent(clientId)
        }/events`,
        { headers: authHeaders(session) }
    );
    expect(response.ok()).toBe(true);
    const events: unknown = await response.json();
    validateAuthoritativeClientEventList(events, {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId: clientId
    });
    return events;
}

async function disconnectBrowserRallar(page: Page): Promise<void> {
    await page.evaluate(async ({ moduleUrl }) => {
        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(moduleUrl);
        await rallar.disconnect();
    }, { moduleUrl: rallarModuleUrl });
}
