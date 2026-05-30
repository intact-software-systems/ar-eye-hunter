import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const facade = vi.hoisted(() => {
    const session = {
        clientId: 'client-1',
        accessToken: 'access-token-1',
        username: 'alice',
        sessionId: 'session-1',
        expiresAtEpochMs: Date.now() + 60_000,
    };
    return {
        session,
        unsubscribeRealtime: vi.fn(),
        unsubscribeMessagesRtc: vi.fn(),
        unsubscribeMessagesWs: vi.fn(),
        rallar: {
            configure: vi.fn(),
            setDefaults: vi.fn(),
            auth: {
                restore: vi.fn(),
                login: vi.fn(),
                registerAndLogin: vi.fn(),
                logout: vi.fn(),
            },
            connect: vi.fn(),
            rooms: {
                join: vi.fn(),
                leave: vi.fn(),
            },
            realtime: {
                onJson: vi.fn(),
                health: vi.fn(),
                sendJson: vi.fn(),
            },
            messages: {
                rtc: {
                    onMessage: vi.fn(),
                    send: vi.fn(),
                },
                ws: {
                    onMessage: vi.fn(),
                    send: vi.fn(),
                },
            },
            disconnect: vi.fn(),
            status: vi.fn(),
            isConnected: vi.fn(),
            session: vi.fn(),
        },
    };
});

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: facade.rallar,
}));

type Runtime = Readonly<{
    connect(config: {
        connection: string;
        actor?: string;
        roomId?: string;
        roomRef?: {
            applicationId: string;
            workspaceId?: string;
            groupId: string;
        };
        rallar: Record<string, unknown>;
    }): Promise<unknown>;
    send(input: unknown): Promise<unknown>;
    sendWs(input: unknown): Promise<unknown>;
    close(): Promise<unknown>;
}>;

type TestWindow = Readonly<{
    __blackBoxRallar?: Runtime;
}> & {
    __blackBoxRallarEmit?: (event: unknown) => void;
};

const events: unknown[] = [];

function resetFacade(): void {
    vi.clearAllMocks();
    events.length = 0;
    facade.rallar.auth.restore.mockReturnValue(undefined);
    facade.rallar.setDefaults.mockReturnValue(undefined);
    facade.rallar.auth.login.mockResolvedValue(facade.session);
    facade.rallar.auth.registerAndLogin.mockResolvedValue(facade.session);
    facade.rallar.auth.logout.mockResolvedValue(undefined);
    facade.rallar.connect.mockResolvedValue(undefined);
    facade.rallar.rooms.join.mockResolvedValue({});
    facade.rallar.rooms.leave.mockResolvedValue({});
    facade.rallar.realtime.onJson.mockReturnValue(facade.unsubscribeRealtime);
    facade.rallar.messages.rtc.onMessage.mockReturnValue(facade.unsubscribeMessagesRtc);
    facade.rallar.messages.ws.onMessage.mockReturnValue(facade.unsubscribeMessagesWs);
    facade.rallar.realtime.health.mockReturnValue([]);
    facade.rallar.realtime.sendJson.mockResolvedValue([]);
    facade.rallar.messages.rtc.send.mockResolvedValue({});
    facade.rallar.messages.ws.send.mockResolvedValue({});
    facade.rallar.disconnect.mockResolvedValue(undefined);
    facade.rallar.status.mockReturnValue({ connected: true });
    facade.rallar.isConnected.mockReturnValue(true);
    facade.rallar.session.mockReturnValue(facade.session);
}

async function loadRuntime(): Promise<Runtime> {
    vi.resetModules();
    const target = globalThis as typeof globalThis & { window?: TestWindow };
    target.window = {
        __blackBoxRallarEmit: event => {
            events.push(event);
        },
    };
    await import('../../shared-test/black-box-runner/browser/rallar-browser-runtime.ts');
    const runtime = target.window.__blackBoxRallar;
    if (!runtime) {
        throw new Error('Browser Rallar runtime did not install.');
    }
    return runtime;
}

function topics(): readonly string[] {
    return events.map(event =>
        String((event as { topic?: unknown }).topic ?? '')
    );
}

describe('browser Rallar black-box runtime', () => {
    beforeEach(() => {
        resetFacade();
    });

    afterEach(() => {
        delete (globalThis as typeof globalThis & { window?: TestWindow }).window;
    });

    it('emits auth restore failure diagnostics when no session or credentials exist', async () => {
        const runtime = await loadRuntime();

        await expect(runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
            },
        })).rejects.toThrow('Rallar credentials are required');

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.auth.restore_started',
            'rallar.browser.auth.restore_failed',
            'rallar.browser.connect.phase_failed',
            'rallar.browser.connect_failed',
        ]));
    });

    it('emits login failure diagnostics for bad credentials', async () => {
        facade.rallar.auth.login.mockRejectedValue(new Error('bad credentials'));
        const runtime = await loadRuntime();

        await expect(runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'wrong',
            },
        })).rejects.toThrow('bad credentials');

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.auth.login_started',
            'rallar.browser.auth.login_failed',
            'rallar.browser.connect.phase_failed',
        ]));
    });

    it('leaves rooms, logs out, and emits cleanup diagnostics on close', async () => {
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                leaveRoomOnClose: true,
                logoutOnClose: true,
            },
        });
        const closeResult = await runtime.close();

        expect(facade.unsubscribeRealtime).toHaveBeenCalledTimes(1);
        expect(facade.rallar.rooms.leave).toHaveBeenCalledWith({
            roomId: 'room-1',
            clearCurrent: true,
            timeoutMs: undefined,
        });
        expect(facade.rallar.auth.logout).toHaveBeenCalledWith({ timeoutMs: undefined });
        expect(facade.rallar.disconnect).not.toHaveBeenCalled();
        expect(closeResult).toMatchObject({
            status: 'closed',
            roomId: 'room-1',
            unsubscribed: 1,
            leftRoom: true,
            logout: true,
            disconnected: false,
            cleanupErrors: [],
        });
        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.cleanup.started',
            'rallar.browser.cleanup.unsubscribe_completed',
            'rallar.browser.cleanup.room_leave_completed',
            'rallar.browser.cleanup.logout_completed',
            'rallar.browser.closed',
        ]));
    });

    it('applies scoped Rallar defaults and passes room references through sends', async () => {
        const runtime = await loadRuntime();
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: 'room-1',
        };

        const connectResult = await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            roomRef,
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                roomRef,
                transport: 'messages.rtc',
                typeId: 'chat.message',
                topicId: 'chat',
            },
        });

        expect(facade.rallar.setDefaults).toHaveBeenCalledWith({
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            room: {
                roomId: 'room-1',
                roomRef,
            },
            realtime: {
                laneId: 'realtime',
            },
            rtc: {},
        });
        expect(facade.rallar.rooms.join).toHaveBeenCalledWith('room-1', {
            timeoutMs: undefined,
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
            },
        });
        expect(connectResult).toMatchObject({
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
            },
            roomRef,
        });

        await runtime.send({
            payload: {
                text: 'hello scoped room',
            },
            minSnapshotVersion: 42,
        });

        expect(facade.rallar.messages.rtc.send).toHaveBeenCalledWith(expect.objectContaining({
            roomId: 'room-1',
            roomRef,
            minSnapshotVersion: 42,
            payload: {
                text: 'hello scoped room',
            },
        }));
    });

    it('subscribes to app WebSocket messages before sending and emits received payloads', async () => {
        const runtime = await loadRuntime();
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: 'bb-group',
        };
        let wsHandler: ((message: Record<string, unknown>) => void) | undefined;
        facade.rallar.messages.ws.onMessage.mockImplementation((
            _selector: unknown,
            handler: (message: Record<string, unknown>) => void,
        ) => {
            wsHandler = handler;
            return facade.unsubscribeMessagesWs;
        });
        facade.rallar.messages.ws.send.mockResolvedValue({
            status: 'sent',
            messageId: 'ws-message-1',
        });

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'bb-group',
            roomRef,
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                roomRef,
            },
        });
        const sendResult = await runtime.sendWs({
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            scope: 'room',
            roomId: 'bb-group',
            groupId: 'bb-group',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            payload: {
                text: 'hello over ws',
            },
        });

        expect(sendResult).toMatchObject({
            status: 'sent',
            transport: 'ws',
            roomId: 'bb-group',
            scope: 'room',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            message: {
                text: 'hello over ws',
            },
        });
        expect(facade.rallar.messages.ws.onMessage).toHaveBeenCalledWith({
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
        }, expect.any(Function));
        expect(facade.rallar.messages.ws.send).toHaveBeenCalledWith(expect.objectContaining({
            roomId: 'bb-group',
            roomRef,
            scope: 'room',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            payload: {
                text: 'hello over ws',
            },
        }));

        wsHandler?.({
            roomId: 'bb-group',
            senderId: 'bob-session',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            payload: {
                text: 'received over ws',
            },
        });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.subscribed',
                connection: 'aliceRtc',
                roomId: 'bb-group',
                typeId: 'room.manual.message',
                topicId: 'room.manual.message',
            }),
            expect.objectContaining({
                kind: 'message',
                topic: 'rallar.browser.ws.message',
                connection: 'aliceRtc',
                roomId: 'bb-group',
                senderId: 'bob-session',
                typeId: 'room.manual.message',
                topicId: 'room.manual.message',
                contextId: 'bb-group',
                data: {
                    text: 'received over ws',
                },
            }),
        ]));

        await runtime.close();
        expect(facade.unsubscribeMessagesWs).toHaveBeenCalledTimes(1);
    });

    it('emits room join failure diagnostics for permission-style failures', async () => {
        facade.rallar.rooms.join.mockRejectedValue(new Error('forbidden room'));
        const runtime = await loadRuntime();

        await expect(runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'forbidden-room',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
            },
        })).rejects.toThrow('forbidden room');

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.connect.phase_started',
            'rallar.browser.connect.phase_failed',
            'rallar.browser.connect_failed',
        ]));
    });

    it('emits send failure diagnostics for forbidden targets', async () => {
        facade.rallar.realtime.sendJson.mockRejectedValue(new Error('forbidden target'));
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
            },
        });
        await expect(runtime.send({
            roomId: 'room-1',
            peerIds: ['forbidden-session'],
            data: {
                text: 'hello',
            },
        })).rejects.toThrow('forbidden target');

        expect(topics()).toContain('rallar.browser.realtime.send_failed');
    });

    it('emits expected-session and duplicate-session diagnostics', async () => {
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                expectedSessionId: 'expected-session',
            },
        });
        await runtime.connect({
            connection: 'aliceRtc2',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                expectedSessionId: 'session-1',
            },
        });

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.session.expected_mismatch',
            'rallar.browser.session.duplicate_detected',
            'rallar.browser.cleanup.unsubscribe_completed',
        ]));
    });
});
