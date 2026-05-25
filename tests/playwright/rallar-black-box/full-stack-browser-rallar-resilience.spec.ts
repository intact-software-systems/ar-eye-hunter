import {
    expect,
    test,
    type APIRequestContext,
    type Page,
    type Route,
} from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    expectFullStackApiReady,
    type FullStackUser,
    loginThroughUi,
    readFullStackConfig,
    uniqueSuffix,
} from './full-stack-helpers.ts';

const config = readFullStackConfig();
const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
);
const rallarModuleUrl =
    `/@fs${path.join(repoRoot, 'packages/shared-web/browser/rallar.ts')}`;

type BrowserAuthSession = Readonly<{
    clientId: string;
    accessToken: string;
    username: string;
    sessionId: string;
    expiresAtEpochMs: number;
}>;

type ClientSessionSnapshot = Readonly<{
    sessionId?: string;
    status?: string;
}>;

type ClientSnapshot = Readonly<{
    activeSessions?: readonly ClientSessionSnapshot[];
}>;

type ClientEvent = Readonly<{
    eventId: string;
    eventType: string;
    principalId: string;
    snapshotVersion: number;
    occurredAtEpochMs: number;
    sessionId?: string;
}>;

type StateEventCursor = Readonly<{
    snapshotVersion: number;
    occurredAtEpochMs: number;
    eventId: string;
}>;

type GroupEvent = Readonly<{
    eventId: string;
    eventType: string;
    groupId: string;
    snapshotVersion: number;
    occurredAtEpochMs: number;
}>;

type GroupSnapshot = Readonly<{
    group: {
        groupId: string;
        snapshotVersion: number;
    };
    members: readonly {
        principalId: string;
        status: string;
    }[];
}>;

type BrowserReplayProbeResult = Readonly<{
    groupId: string;
    createdCursor: StateEventCursor;
    liveEvents: readonly GroupEvent[];
    replayEvents: readonly GroupEvent[];
    replayResult: {
        events: readonly GroupEvent[];
        duplicateCount: number;
        replayedCount: number;
        pageCount: number;
        hasMore: boolean;
    };
    refreshedMemberStatus?: string;
}>;

type WsLifecycleRecord = Readonly<{
    kind: string;
    readyState: string;
    isOpen: boolean;
    intentional?: boolean;
    code?: number;
    reason?: string;
}>;

type RtcLifecycleRecord = Readonly<{
    kind: string;
    peerId?: string;
    laneId?: string;
    readyPeerIds: readonly string[];
}>;

type RealtimeProbeMessage = Readonly<{
    peerId: string;
    laneId: string;
    data: {
        payloadId?: string;
        direction?: string;
    };
}>;

type BrowserPeopleReplayProbeResult = Readonly<{
    clientId: string;
    sessionId: string;
    wsOpenStatus: string;
    wsStatusOpen: boolean;
    liveEvents: readonly ClientEvent[];
    replayEvents: readonly ClientEvent[];
    replayResult: {
        events: readonly ClientEvent[];
        replayedCount: number;
        duplicateCount: number;
        pageCount: number;
        hasMore: boolean;
    };
    peopleStateIncludesSelf: boolean;
    wsLifecycle: readonly WsLifecycleRecord[];
}>;

type BrowserRealtimeProbeResult = Readonly<{
    roomId: string;
    senderSessionId: string;
    receiverSessionId: string;
    waitResult: {
        status: string;
        readyCount: number;
        notReadyCount: number;
    };
    sendResults: readonly {
        peerId: string;
        laneId: string;
        result: {
            status: string;
        };
    }[];
    received: readonly RealtimeProbeMessage[];
    senderReadyPeerIds: readonly string[];
    receiverReadyPeerIds: readonly string[];
    senderLifecycle: readonly RtcLifecycleRecord[];
    receiverLifecycle: readonly RtcLifecycleRecord[];
}>;

type CapturedMutationRequest = Readonly<{
    requestId?: string;
    groupId?: string;
}>;

test.describe('full-stack Browser Rallar resilience', () => {
    test.skip(!config.enabled, config.skipReason);

    test('retries transient room create and presence connect failures with stable request IDs', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const createRequests: CapturedMutationRequest[] = [];
        const presenceRequests: CapturedMutationRequest[] = [];
        let createFailedOnce = false;
        let presenceFailedOnce = false;

        await loginThroughUi(page, config, config.userA, {
            suffix: `retry-${suffix}`,
            tab: 'manual-rallar',
        });

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
            },
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
            },
        );

        const result = await page.evaluate(
            async ({ apiBaseUrl, moduleUrl, roomName }) => {
                const { rallar } = await import(moduleUrl);
                rallar.configure({ apiBaseUrl });
                rallar.setDefaults({
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                });

                const session = rallar.session();
                if (!session) {
                    throw new Error('Expected a browser Rallar session after UI login.');
                }

                const snapshot = await rallar.rooms.create({
                    displayName: roomName,
                    maxAttempts: 3,
                    timeoutMs: 20_000,
                });

                return {
                    groupId: snapshot.group.groupId,
                    sessionId: session.sessionId,
                    activeSessionIds: snapshot.activeSessions.map((entry: { sessionId: string }) =>
                        entry.sessionId
                    ),
                };
            },
            {
                apiBaseUrl: config.apiBaseUrl,
                moduleUrl: rallarModuleUrl,
                roomName: `Retry Room ${suffix}`,
            },
        );

        expect(createRequests).toHaveLength(2);
        expect(createRequests[0].requestId).toBeTruthy();
        expect(createRequests[1].requestId).toBe(createRequests[0].requestId);
        expect(createRequests[1].groupId).toBe(createRequests[0].groupId);
        expect(presenceRequests).toHaveLength(2);
        expect(presenceRequests[0].requestId).toBeTruthy();
        expect(presenceRequests[1].requestId).toBe(presenceRequests[0].requestId);
        expect(result.activeSessionIds).toContain(result.sessionId);

        const session = await readBrowserSession(page);
        const persisted = await getGroupSnapshot(
            request,
            result.groupId,
            session,
        );
        expect(persisted.group.groupId).toBe(result.groupId);
    });

    test('disconnects WS client state when API logout deletes auth before socket close', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        await loginThroughUi(page, config, config.userA, {
            suffix: `logout-race-${suffix}`,
            tab: 'manual-rallar',
        });

        const connected = await page.evaluate(
            async ({ apiBaseUrl, moduleUrl }) => {
                const { rallar } = await import(moduleUrl);
                rallar.configure({ apiBaseUrl });
                const session = rallar.session();
                if (!session) {
                    throw new Error('Expected a browser Rallar session after UI login.');
                }

                await rallar.connect({ timeoutMs: 20_000 });

                return {
                    clientId: session.clientId,
                    sessionId: session.sessionId,
                    accessToken: session.accessToken,
                };
            },
            {
                apiBaseUrl: config.apiBaseUrl,
                moduleUrl: rallarModuleUrl,
            },
        );

        await expect.poll(async () => {
            const snapshot = await getClientSnapshot(
                request,
                connected.clientId,
                {
                    clientId: connected.clientId,
                    accessToken: connected.accessToken,
                    username: config.userA.username,
                    sessionId: connected.sessionId,
                    expiresAtEpochMs: Date.now() + 60_000,
                },
            );
            return hasActiveSession(snapshot, connected.sessionId);
        }, {
            timeout: 30_000,
        }).toBe(true);

        const logoutStatus = await page.evaluate(
            async ({ apiBaseUrl }) => {
                const raw = localStorage.getItem('auth.session');
                if (!raw) {
                    throw new Error('Expected auth.session in browser localStorage.');
                }
                const session = JSON.parse(raw) as BrowserAuthSession;
                const response = await fetch(`${apiBaseUrl}/api/auth/logout`, {
                    method: 'POST',
                    headers: {
                        'authorization': `Bearer ${session.accessToken}`,
                        'content-type': 'application/json',
                        'x-client-id': session.clientId,
                    },
                    body: JSON.stringify({}),
                });
                return response.status;
            },
            { apiBaseUrl: config.apiBaseUrl },
        );
        expect(logoutStatus).toBe(200);

        const closeResult = await page.evaluate(
            async ({ moduleUrl }) => {
                const { rallar } = await import(moduleUrl);
                const before = rallar.ws.status();
                rallar.advanced.middleware().middleware.webSocketQueueBox.close(
                    1000,
                    'auth-deleted-before-close-test',
                );
                localStorage.removeItem('auth.session');
                return {
                    readyStateBeforeClose: before.readyState,
                    reconnectEnabledBeforeClose: before.reconnectEnabled,
                };
            },
            { moduleUrl: rallarModuleUrl },
        );
        expect(closeResult.readyStateBeforeClose).toBe('open');

        const freshSession = await loginViaApi(request);
        await expect.poll(async () => {
            const [snapshot, events] = await Promise.all([
                getClientSnapshot(request, connected.clientId, freshSession),
                getClientEvents(request, connected.clientId, freshSession),
            ]);

            return {
                oldSessionStillActive: hasActiveSession(snapshot, connected.sessionId),
                disconnectedEvent: events.some((event) =>
                    event.eventType === 'session-disconnected' &&
                    event.sessionId === connected.sessionId
                ),
            };
        }, {
            timeout: 45_000,
        }).toEqual({
            oldSessionStillActive: false,
            disconnectedEvent: true,
        });
    });

    test('recovers missed room events through explicit replay after browser reconnect', async ({
        browser,
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const browserBContext = await browser.newContext();
        const browserBPage = await browserBContext.newPage();

        try {
            await loginThroughUi(page, config, config.userA, {
                suffix: `replay-a-${suffix}`,
                tab: 'manual-rallar',
            });
            await loginThroughUi(browserBPage, config, config.userB, {
                suffix: `replay-b-${suffix}`,
                tab: 'manual-rallar',
            });

            const created = await page.evaluate(
                async ({ apiBaseUrl, moduleUrl, roomName }) => {
                    const { rallar } = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default',
                    });

                    const liveEvents: GroupEvent[] = [];
                    const replayEvents: GroupEvent[] = [];
                    (window as unknown as {
                        __rallarReplayProbe?: {
                            liveEvents: GroupEvent[];
                            replayEvents: GroupEvent[];
                        };
                    }).__rallarReplayProbe = {
                        liveEvents,
                        replayEvents,
                    };

                    await rallar.connect({ timeoutMs: 20_000 });
                    const snapshot = await rallar.rooms.create({
                        displayName: roomName,
                        timeoutMs: 20_000,
                        maxAttempts: 3,
                    });
                    const groupId = snapshot.group.groupId;
                    const createdEvents = await rallar.rooms.listEvents({
                        roomId: groupId,
                        eventTypes: ['group-created'],
                        limit: 1,
                        timeoutMs: 20_000,
                    });
                    const createdEvent = createdEvents.at(-1);
                    if (!createdEvent) {
                        throw new Error('Expected group-created event.');
                    }

                    rallar.rooms.onEvent((event: GroupEvent) => {
                        liveEvents.push(event);
                    }, {
                        roomId: groupId,
                        eventTypes: ['member-joined', 'member-left'],
                    });

                    return {
                        groupId,
                        createdCursor: {
                            snapshotVersion: createdEvent.snapshotVersion,
                            occurredAtEpochMs: createdEvent.occurredAtEpochMs,
                            eventId: createdEvent.eventId,
                        },
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    roomName: `Replay Room ${suffix}`,
                },
            ) as {
                groupId: string;
                createdCursor: StateEventCursor;
            };

            const joined = await browserBPage.evaluate(
                async ({ apiBaseUrl, moduleUrl, groupId }) => {
                    const { rallar } = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default',
                    });

                    await rallar.rooms.join(groupId, {
                        timeoutMs: 20_000,
                        maxAttempts: 3,
                    });

                    const session = rallar.session();
                    if (!session) {
                        throw new Error('Expected Browser B Rallar session.');
                    }

                    return {
                        clientId: session.clientId,
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    groupId: created.groupId,
                },
            ) as { clientId: string };

            await expect.poll(async () => {
                return await page.evaluate(() =>
                    ((window as unknown as {
                        __rallarReplayProbe?: { liveEvents: GroupEvent[] };
                    }).__rallarReplayProbe?.liveEvents ?? [])
                        .some((event) => event.eventType === 'member-joined')
                );
            }, {
                timeout: 30_000,
            }).toBe(true);

            await page.evaluate(async ({ moduleUrl }) => {
                const { rallar } = await import(moduleUrl);
                await rallar.disconnect();
            }, { moduleUrl: rallarModuleUrl });

            await browserBPage.evaluate(
                async ({ moduleUrl, groupId }) => {
                    const { rallar } = await import(moduleUrl);
                    await rallar.rooms.leave({
                        roomId: groupId,
                        clearCurrent: false,
                        timeoutMs: 20_000,
                        maxAttempts: 3,
                    });
                },
                {
                    moduleUrl: rallarModuleUrl,
                    groupId: created.groupId,
                },
            );

            const result = await page.evaluate(
                async ({ apiBaseUrl, moduleUrl, groupId, createdCursor, principalId }) => {
                    const { rallar } = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    await rallar.connect({ timeoutMs: 20_000 });

                    const roomState = await rallar.rooms.refresh({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default',
                    });
                    const refreshedRoom = roomState.rooms.find(
                        (room: { roomId: string }) => room.roomId === groupId,
                    )?.snapshot as GroupSnapshot | undefined;

                    const probe = (window as unknown as {
                        __rallarReplayProbe?: {
                            liveEvents: GroupEvent[];
                            replayEvents: GroupEvent[];
                        };
                    }).__rallarReplayProbe;
                    if (!probe) {
                        throw new Error('Expected replay probe state.');
                    }

                    const replayResult = await rallar.rooms.replayEvents(
                        {
                            roomId: groupId,
                            eventTypes: ['member-joined', 'member-left'],
                            after: createdCursor,
                            limit: 10,
                            timeoutMs: 20_000,
                        },
                        (event: GroupEvent) => {
                            probe.replayEvents.push(event);
                        },
                    );

                    return {
                        groupId,
                        createdCursor,
                        liveEvents: probe.liveEvents,
                        replayEvents: probe.replayEvents,
                        replayResult,
                        refreshedMemberStatus: refreshedRoom?.members.find(
                            (member) => member.principalId === principalId,
                        )?.status,
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    groupId: created.groupId,
                    createdCursor: created.createdCursor,
                    principalId: joined.clientId,
                },
            ) as BrowserReplayProbeResult;

            expect(result.liveEvents.map((event) => event.eventType)).toContain(
                'member-joined',
            );
            expect(result.replayEvents.map((event) => event.eventType)).toEqual([
                'member-left',
            ]);
            expect(result.replayResult.duplicateCount).toBeGreaterThanOrEqual(1);
            expect(result.replayResult.replayedCount).toBe(1);
            expect(result.replayResult.pageCount).toBe(1);
            expect(result.replayResult.hasMore).toBe(false);
            expect(result.refreshedMemberStatus).toBe('left');
            expect(
                result.liveEvents.filter((event) => event.eventType === 'member-left'),
            ).toHaveLength(0);
        } finally {
            await browserBContext.close();
        }
    });

    test('replays missed people events and reports WS lifecycle around reconnect', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const user = uniqueRegisteredUser(config.userA, 'people', suffix);
        await loginThroughUi(page, config, user, {
            suffix: `people-replay-${suffix}`,
            tab: 'manual-rallar',
            registerBeforeLogin: true,
        });

        const connected = await page.evaluate(
            async ({ apiBaseUrl, moduleUrl }) => {
                const { rallar } = await import(moduleUrl);
                rallar.configure({ apiBaseUrl });
                rallar.setDefaults({
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                });

                const liveEvents: ClientEvent[] = [];
                const replayEvents: ClientEvent[] = [];
                const wsLifecycle: WsLifecycleRecord[] = [];
                (window as unknown as {
                    __rallarPeopleReplayProbe?: {
                        liveEvents: ClientEvent[];
                        replayEvents: ClientEvent[];
                        wsLifecycle: WsLifecycleRecord[];
                    };
                }).__rallarPeopleReplayProbe = {
                    liveEvents,
                    replayEvents,
                    wsLifecycle,
                };

                rallar.ws.onLifecycle((event: {
                    kind: string;
                    status: { readyState: string; isOpen: boolean };
                    intentional?: boolean;
                    code?: number;
                    reason?: string;
                }) => {
                    wsLifecycle.push({
                        kind: event.kind,
                        readyState: event.status.readyState,
                        isOpen: event.status.isOpen,
                        intentional: event.intentional,
                        code: event.code,
                        reason: event.reason,
                    });
                });

                const session = rallar.session();
                if (!session) {
                    throw new Error('Expected a browser Rallar session after UI login.');
                }

                rallar.people.onEvent((event: ClientEvent) => {
                    liveEvents.push(event);
                }, {
                    principalId: session.clientId,
                    eventTypes: ['session-connected', 'session-disconnected'],
                });

                await rallar.connect({ timeoutMs: 20_000 });
                const wsOpen = await rallar.ws.waitForOpen({ timeoutMs: 20_000 });

                return {
                    clientId: session.clientId,
                    sessionId: session.sessionId,
                    wsOpenStatus: wsOpen.status,
                    wsStatusOpen: wsOpen.wsStatus.isOpen,
                };
            },
            {
                apiBaseUrl: config.apiBaseUrl,
                moduleUrl: rallarModuleUrl,
            },
        ) as {
            clientId: string;
            sessionId: string;
            wsOpenStatus: string;
            wsStatusOpen: boolean;
        };

        expect(connected.wsOpenStatus).toBe('open');
        expect(connected.wsStatusOpen).toBe(true);

        let connectedCursor: StateEventCursor | undefined;
        await expect.poll(async () => {
            connectedCursor = await page.evaluate(
                async ({ moduleUrl, clientId, sessionId }) => {
                    const { rallar } = await import(moduleUrl);
                    const events = await rallar.people.listEvents(clientId, {
                        eventTypes: ['session-connected'],
                        limit: 5,
                        timeoutMs: 20_000,
                    });
                    const event = [...events].reverse().find(
                        (candidate: ClientEvent) =>
                            candidate.sessionId === sessionId &&
                            candidate.eventType === 'session-connected',
                    );
                    return event
                        ? {
                            snapshotVersion: event.snapshotVersion,
                            occurredAtEpochMs: event.occurredAtEpochMs,
                            eventId: event.eventId,
                        }
                        : undefined;
                },
                {
                    moduleUrl: rallarModuleUrl,
                    clientId: connected.clientId,
                    sessionId: connected.sessionId,
                },
            ) as StateEventCursor | undefined;
            return connectedCursor !== undefined;
        }, {
            timeout: 30_000,
        }).toBe(true);
        expect(connectedCursor).toBeDefined();

        await page.evaluate(async ({ moduleUrl }) => {
            const { rallar } = await import(moduleUrl);
            await rallar.disconnect();
        }, { moduleUrl: rallarModuleUrl });

        await expect.poll(async () => {
            return await page.evaluate(
                async ({ moduleUrl, clientId, sessionId }) => {
                    const { rallar } = await import(moduleUrl);
                    const events = await rallar.people.listEvents(clientId, {
                        eventTypes: ['session-disconnected'],
                        limit: 10,
                        timeoutMs: 20_000,
                    });
                    return events.some((event: ClientEvent) =>
                        event.sessionId === sessionId &&
                        event.eventType === 'session-disconnected'
                    );
                },
                {
                    moduleUrl: rallarModuleUrl,
                    clientId: connected.clientId,
                    sessionId: connected.sessionId,
                },
            ) as boolean;
        }, {
            timeout: 45_000,
        }).toBe(true);

        const result = await page.evaluate(
            async ({ apiBaseUrl, moduleUrl, clientId, after }) => {
                const { rallar } = await import(moduleUrl);
                rallar.configure({ apiBaseUrl });

                await rallar.connect({ timeoutMs: 20_000 });
                const wsOpen = await rallar.ws.waitForOpen({ timeoutMs: 20_000 });
                const peopleState = await rallar.people.refresh({
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                    timeoutMs: 20_000,
                });

                const probe = (window as unknown as {
                    __rallarPeopleReplayProbe?: {
                        liveEvents: ClientEvent[];
                        replayEvents: ClientEvent[];
                        wsLifecycle: WsLifecycleRecord[];
                    };
                }).__rallarPeopleReplayProbe;
                if (!probe) {
                    throw new Error('Expected people replay probe state.');
                }

                const replayResult = await rallar.people.replayEvents(
                    clientId,
                    {
                        eventTypes: ['session-connected', 'session-disconnected'],
                        after,
                        limit: 10,
                        timeoutMs: 20_000,
                    },
                    (event: ClientEvent) => {
                        probe.replayEvents.push(event);
                    },
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
                        (person: { principalId: string; isOnline: boolean }) =>
                            person.principalId === clientId && person.isOnline,
                    ),
                    wsLifecycle: probe.wsLifecycle,
                };
            },
            {
                apiBaseUrl: config.apiBaseUrl,
                moduleUrl: rallarModuleUrl,
                clientId: connected.clientId,
                after: connectedCursor as StateEventCursor,
            },
        ) as BrowserPeopleReplayProbeResult;

        expect(result.wsOpenStatus).toBe('open');
        expect(result.wsStatusOpen).toBe(true);
        expect(result.peopleStateIncludesSelf).toBe(true);
        expect(result.replayEvents.map((event) => event.eventType)).toContain(
            'session-disconnected',
        );
        expect(result.replayResult.replayedCount).toBeGreaterThanOrEqual(1);
        expect(result.replayResult.pageCount).toBe(1);
        expect(result.replayResult.hasMore).toBe(false);
        expect(result.wsLifecycle.map((event) => event.kind)).toEqual(
            expect.arrayContaining(['snapshot', 'connected', 'disconnected']),
        );
        expect(result.wsLifecycle.some((event) =>
            event.kind === 'disconnected' &&
            event.intentional === true &&
            event.reason === 'rallar-disconnect'
        )).toBe(true);
    });

    test('waits for RTC room lane and delivers realtime JSON through direct Rallar facade', async ({
        browser,
        page,
        request,
    }) => {
        test.setTimeout(150_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const userA = uniqueRegisteredUser(config.userA, 'direct-rtc-a', suffix);
        const userB = uniqueRegisteredUser(config.userB, 'direct-rtc-b', suffix);
        const browserBContext = await browser.newContext();
        const browserBPage = await browserBContext.newPage();

        try {
            await loginThroughUi(page, config, userA, {
                suffix: `direct-rtc-a-${suffix}`,
                tab: 'manual-rallar',
                registerBeforeLogin: true,
            });
            await loginThroughUi(browserBPage, config, userB, {
                suffix: `direct-rtc-b-${suffix}`,
                tab: 'manual-rallar',
                registerBeforeLogin: true,
            });

            const created = await page.evaluate(
                async ({ apiBaseUrl, moduleUrl, roomName }) => {
                    const { rallar } = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default',
                    });

                    const rtcLifecycle: RtcLifecycleRecord[] = [];
                    rallar.rtc.onLifecycle((event: {
                        kind: string;
                        peerId?: string;
                        laneId?: string;
                        status: { readyPeerIds: readonly string[] };
                    }) => {
                        rtcLifecycle.push({
                            kind: event.kind,
                            peerId: event.peerId,
                            laneId: event.laneId,
                            readyPeerIds: event.status.readyPeerIds,
                        });
                    }, {
                        laneId: 'realtime',
                    });

                    await rallar.connect({ timeoutMs: 20_000 });
                    await rallar.ws.waitForOpen({ timeoutMs: 20_000 });
                    const snapshot = await rallar.rooms.create({
                        displayName: roomName,
                        timeoutMs: 20_000,
                        maxAttempts: 3,
                    });
                    const session = rallar.session();
                    if (!session) {
                        throw new Error('Expected sender Rallar session.');
                    }

                    (window as unknown as {
                        __rallarRealtimeProbe?: {
                            rtcLifecycle: RtcLifecycleRecord[];
                        };
                    }).__rallarRealtimeProbe = {
                        rtcLifecycle,
                    };

                    return {
                        roomId: snapshot.group.groupId,
                        senderSessionId: session.sessionId,
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    roomName: `Direct RTC Room ${suffix}`,
                },
            ) as {
                roomId: string;
                senderSessionId: string;
            };

            const joined = await browserBPage.evaluate(
                async ({ apiBaseUrl, moduleUrl, groupId }) => {
                    const { rallar } = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default',
                    });

                    const received: RealtimeProbeMessage[] = [];
                    const rtcLifecycle: RtcLifecycleRecord[] = [];
                    rallar.rtc.onLifecycle((event: {
                        kind: string;
                        peerId?: string;
                        laneId?: string;
                        status: { readyPeerIds: readonly string[] };
                    }) => {
                        rtcLifecycle.push({
                            kind: event.kind,
                            peerId: event.peerId,
                            laneId: event.laneId,
                            readyPeerIds: event.status.readyPeerIds,
                        });
                    }, {
                        laneId: 'realtime',
                    });
                    rallar.realtime.onJson(
                        'realtime',
                        (message: {
                            peerId: string;
                            laneId: string;
                            data: RealtimeProbeMessage['data'];
                        }) => {
                            received.push({
                                peerId: message.peerId,
                                laneId: message.laneId,
                                data: message.data,
                            });
                        },
                    );

                    await rallar.connect({ timeoutMs: 20_000 });
                    await rallar.ws.waitForOpen({ timeoutMs: 20_000 });
                    const snapshot = await rallar.rooms.join(groupId, {
                        timeoutMs: 20_000,
                        maxAttempts: 3,
                    });
                    const session = rallar.session();
                    if (!session) {
                        throw new Error('Expected receiver Rallar session.');
                    }

                    (window as unknown as {
                        __rallarRealtimeProbe?: {
                            received: RealtimeProbeMessage[];
                            rtcLifecycle: RtcLifecycleRecord[];
                        };
                    }).__rallarRealtimeProbe = {
                        received,
                        rtcLifecycle,
                    };

                    return {
                        receiverSessionId: session.sessionId,
                        activeSessionIds: snapshot.activeSessions.map(
                            (entry: { sessionId: string }) => entry.sessionId,
                        ),
                    };
                },
                {
                    apiBaseUrl: config.apiBaseUrl,
                    moduleUrl: rallarModuleUrl,
                    groupId: created.roomId,
                },
            ) as {
                receiverSessionId: string;
                activeSessionIds: readonly string[];
            };

            expect(joined.activeSessionIds).toContain(created.senderSessionId);
            expect(joined.activeSessionIds).toContain(joined.receiverSessionId);

            const payloadId = `direct-realtime-${suffix}`;
            const sent = await page.evaluate(
                async ({ moduleUrl, groupId, payloadId }) => {
                    const { rallar } = await import(moduleUrl);
                    await rallar.rooms.refresh({
                        applicationId: 'ar-eye-hunter',
                        workspaceId: 'default',
                        timeoutMs: 20_000,
                    });
                    const waitResult = await rallar.rtc.waitForRoomLane(
                        groupId,
                        'realtime',
                        {
                            connect: true,
                            timeoutMs: 20_000,
                        },
                    );
                    const sendResults = await rallar.realtime.sendJson({
                        roomId: groupId,
                        laneId: 'realtime',
                        openTimeoutMs: 20_000,
                        data: {
                            payloadId,
                            direction: 'a-to-b',
                        },
                    });

                    return {
                        waitResult: {
                            status: waitResult.status,
                            readyCount: waitResult.ready.length,
                            notReadyCount: waitResult.notReady.length,
                        },
                        sendResults,
                        senderReadyPeerIds: rallar.rtc.readyPeerIds('realtime'),
                    };
                },
                {
                    moduleUrl: rallarModuleUrl,
                    groupId: created.roomId,
                    payloadId,
                },
            ) as Pick<
                BrowserRealtimeProbeResult,
                'waitResult' | 'sendResults' | 'senderReadyPeerIds'
            >;

            expect(sent.waitResult).toEqual({
                status: 'open',
                readyCount: 1,
                notReadyCount: 0,
            });
            expect(sent.sendResults).toHaveLength(1);
            expect(sent.sendResults[0]).toMatchObject({
                peerId: joined.receiverSessionId,
                laneId: 'realtime',
                result: {
                    status: 'sent',
                },
            });

            await expect.poll(async () => {
                return await browserBPage.evaluate(
                    (expectedPayloadId) =>
                        ((window as unknown as {
                            __rallarRealtimeProbe?: {
                                received: RealtimeProbeMessage[];
                            };
                        }).__rallarRealtimeProbe?.received ?? [])
                            .some((message) =>
                                message.laneId === 'realtime' &&
                                message.data.payloadId === expectedPayloadId
                            ),
                    payloadId,
                );
            }, {
                timeout: 45_000,
            }).toBe(true);

            const result = await browserBPage.evaluate(
                async ({ moduleUrl }) => {
                    const { rallar } = await import(moduleUrl);
                    const probe = (window as unknown as {
                        __rallarRealtimeProbe?: {
                            received: RealtimeProbeMessage[];
                            rtcLifecycle: RtcLifecycleRecord[];
                        };
                    }).__rallarRealtimeProbe;
                    if (!probe) {
                        throw new Error('Expected receiver realtime probe state.');
                    }

                    return {
                        received: probe.received,
                        receiverReadyPeerIds: rallar.rtc.readyPeerIds('realtime'),
                        receiverLifecycle: probe.rtcLifecycle,
                    };
                },
                {
                    moduleUrl: rallarModuleUrl,
                },
            ) as Pick<
                BrowserRealtimeProbeResult,
                'received' | 'receiverReadyPeerIds' | 'receiverLifecycle'
            >;

            const senderProbe = await page.evaluate(() => {
                const probe = (window as unknown as {
                    __rallarRealtimeProbe?: {
                        rtcLifecycle: RtcLifecycleRecord[];
                    };
                }).__rallarRealtimeProbe;
                return {
                    senderLifecycle: probe?.rtcLifecycle ?? [],
                };
            }) as Pick<BrowserRealtimeProbeResult, 'senderLifecycle'>;

            expect(result.received).toContainEqual(
                expect.objectContaining({
                    peerId: created.senderSessionId,
                    laneId: 'realtime',
                    data: expect.objectContaining({
                        payloadId,
                        direction: 'a-to-b',
                    }),
                }),
            );
            expect(sent.senderReadyPeerIds).toContain(joined.receiverSessionId);
            expect(result.receiverReadyPeerIds).toContain(created.senderSessionId);
            expect(senderProbe.senderLifecycle.map((event) => event.kind))
                .toEqual(expect.arrayContaining(['connected', 'peer-created', 'lane-open']));
            expect(result.receiverLifecycle.map((event) => event.kind))
                .toEqual(expect.arrayContaining(['connected', 'peer-created', 'lane-open']));
        } finally {
            await browserBContext.close();
        }
    });
});

function readJsonBody(raw: string | null): CapturedMutationRequest {
    if (!raw) {
        return {};
    }

    return JSON.parse(raw) as CapturedMutationRequest;
}

async function fulfillTransient(
    route: Route,
    status: number,
    body: string,
): Promise<void> {
    const origin = route.request().headers().origin ?? 'http://localhost:5176';
    await route.fulfill({
        status,
        contentType: 'text/plain',
        headers: {
            'access-control-allow-credentials': 'true',
            'access-control-allow-origin': origin,
        },
        body,
    });
}

async function readBrowserSession(page: Page): Promise<BrowserAuthSession> {
    return await page.evaluate(() => {
        const raw = localStorage.getItem('auth.session');
        if (!raw) {
            throw new Error('Expected auth.session in browser localStorage.');
        }
        return JSON.parse(raw);
    }) as BrowserAuthSession;
}

async function loginViaApi(
    request: APIRequestContext,
): Promise<BrowserAuthSession> {
    const response = await request.post(`${config.apiBaseUrl}/api/auth/login`, {
        data: {
            username: config.userA.username,
            password: config.userA.password,
        },
    });
    expect(response.ok()).toBe(true);
    return await response.json() as BrowserAuthSession;
}

async function getGroupSnapshot(
    request: APIRequestContext,
    groupId: string,
    session: BrowserAuthSession,
): Promise<{ group: { groupId: string } }> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/groups/${
            encodeURIComponent(groupId)
        }`,
        { headers: authHeaders(session) },
    );
    expect(response.ok()).toBe(true);
    return await response.json() as { group: { groupId: string } };
}

async function getClientSnapshot(
    request: APIRequestContext,
    clientId: string,
    session: BrowserAuthSession,
): Promise<ClientSnapshot> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/clients/${
            encodeURIComponent(clientId)
        }`,
        { headers: authHeaders(session) },
    );
    expect(response.ok()).toBe(true);
    return await response.json() as ClientSnapshot;
}

async function getClientEvents(
    request: APIRequestContext,
    clientId: string,
    session: BrowserAuthSession,
): Promise<readonly ClientEvent[]> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/clients/${
            encodeURIComponent(clientId)
        }/events`,
        { headers: authHeaders(session) },
    );
    expect(response.ok()).toBe(true);
    return await response.json() as readonly ClientEvent[];
}

function authHeaders(
    session: Pick<BrowserAuthSession, 'accessToken' | 'clientId'>,
): Record<string, string> {
    return {
        authorization: `Bearer ${session.accessToken}`,
        'x-client-id': session.clientId,
    };
}

function hasActiveSession(
    snapshot: ClientSnapshot,
    sessionId: string,
): boolean {
    return snapshot.activeSessions?.some((session) =>
        session.sessionId === sessionId &&
        session.status === 'active'
    ) ?? false;
}

function uniqueRegisteredUser(
    base: FullStackUser,
    label: string,
    suffix: string,
): FullStackUser {
    const id = `${base.actor}-${label}-${suffix}`.replace(
        /[^a-zA-Z0-9_.-]/g,
        '-',
    );
    return {
        username: id,
        password: base.password,
        clientId: id,
        actor: id,
    };
}
