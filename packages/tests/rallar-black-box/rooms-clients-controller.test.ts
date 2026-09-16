// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ROOMS_CLIENTS_ACTIONS,
    type RoomsClientsAction,
    type RoomsClientsActionId
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/rooms-clients-contracts.ts';
import {
    useRoomsClientsController,
    type RoomsClientsControllerModel,
    type UseRoomsClientsControllerInput
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/use-rooms-clients-controller.ts';
import type { CommandCenterGlobalValues } from '../../../apps/rallar-black-box/src/legacy/shell/global-context-model.ts';

interface RecordedRequest {
    readonly method: string;
    readonly url: string;
    readonly authorization: string | undefined;
    readonly body: string | undefined;
}
interface StubResponse {
    readonly status: number;
    readonly body: RallarBlackBoxTestJsonValue;
}

const loadFacade = vi.hoisted(() => vi.fn());
const runtimeEvents = vi.hoisted(() => [] as RallarBlackBoxTestRuntimeEventInput[]);
vi.mock('../../../apps/rallar-black-box/src/legacy/rallar/load-browser-rallar-facade.ts', () => ({ loadBrowserRallarFacade: loadFacade }));
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: { recordRuntimeEvent: (event: RallarBlackBoxTestRuntimeEventInput) => runtimeEvents.push(event) },
    rallarBlackBoxProviderModeFromConfig: () => 'browser-rallar'
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = { clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'test-token', expiresAtEpochMs: 100_000 };
const globalValues: CommandCenterGlobalValues = {
    apiBaseUrl: 'http://localhost',
    applicationId: 'app',
    workspaceId: 'workspace',
    clientId: 'client',
    sessionId: 'session',
    roomId: 'room-a'
};
const stateBase = 'http://localhost/api/state/apps/app/workspaces/workspace';
const roomA = {
    group: { groupId: 'room-a', displayName: 'Room A', status: 'active', snapshotVersion: 3, created: { atEpochMs: 10 } },
    memberCount: 2,
    onlineMemberCount: 1,
    members: [],
    activeSessions: [{ sessionId: 'session', connectedAtEpochMs: 30 }]
};
const emptyRoom = { group: { groupId: 'room-empty', status: 'active', created: { atEpochMs: 40 } }, memberCount: 0, onlineMemberCount: 0, activeSessions: [] };
const selfClient = { principal: { principalId: 'client', username: 'user', status: 'active' }, isOnline: true, activeSessions: [{ sessionId: 'session' }] };
const bobClient = { principal: { principalId: 'bob', username: 'bob', status: 'active' }, isOnline: false, activeSessions: [] };

function RoomsClientsHarness(props: { input: UseRoomsClientsControllerInput; capture(view: RoomsClientsControllerModel): void; }) {
    const view = useRoomsClientsController(props.input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}

function action(actionId: RoomsClientsActionId): RoomsClientsAction {
    const found = ROOMS_CLIENTS_ACTIONS.find((entry) => entry.actionId === actionId);
    if (!found) {
        throw new Error(`Missing ${actionId}`);
    }
    return found;
}

describe('rooms and clients controller preservation', () => {
    let root: Root;
    let container: HTMLDivElement;
    let view: RoomsClientsControllerModel;
    const requests: RecordedRequest[] = [];
    const globalChanges: string[] = [];
    const facadeCalls: RallarBlackBoxTestRecord[] = [];
    let respond: (method: string, url: string) => StubResponse;

    async function render(next: Partial<UseRoomsClientsControllerInput> = {}): Promise<void> {
        const input: UseRoomsClientsControllerInput = {
            state,
            bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar', {}, ''),
            authSession,
            globalValues,
            onGlobalValueChange: (key, value) => globalChanges.push(`${key}=${String(value)}`),
            ...next
        };
        await act(async () =>
            root.render(createElement(
                StrictMode,
                null,
                createElement(RoomsClientsHarness, {
                    input,
                    capture: (captured) => {
                        view = captured;
                    }
                })
            ))
        );
    }

    function feedback(): RallarBlackBoxTestRecord {
        const { atEpochMs: _at, durationMs: _duration, ...rest } = view.actionFeedback;
        return rest;
    }

    beforeEach(() => {
        requests.length = 0;
        globalChanges.length = 0;
        facadeCalls.length = 0;
        runtimeEvents.length = 0;
        respond = () => ({ status: 200, body: {} });
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            const headers = (init.headers ?? {}) as Record<string, string>;
            requests.push({
                method: String(init.method),
                url,
                authorization: headers.authorization,
                body: init.body === undefined ? undefined : String(init.body)
            });
            const stub = respond(String(init.method), url);
            return new Response(JSON.stringify(stub.body), {
                status: stub.status,
                statusText: stub.status === 200 ? 'OK' : 'Service Unavailable',
                headers: { 'content-type': 'application/json' }
            });
        });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('derives the request variables from the global values and resets edits when the global values change', async () => {
        await render();
        const initial = { ...view.variables };
        await act(async () => view.updateVariable('groupId', 'edited-room'));
        const edited = view.variables.groupId;
        await render({ globalValues: { ...globalValues, roomId: 'room-b' } });

        expect({
            initial,
            edited,
            followed: view.variables.groupId,
            apiBaseUrl: view.apiBaseUrl,
            timeoutMs: view.timeoutMs,
            sorts: [view.groupSort, view.clientSort],
            expectedOtherClient: view.expectedOtherClient
        }).toEqual({
            initial: {
                applicationId: 'app',
                workspaceId: 'workspace',
                principalId: 'client',
                sessionId: 'session',
                generationId: expect.any(String),
                requestId: expect.any(String),
                clientInstanceId: 'session-browser',
                groupId: 'room-a',
                username: 'user'
            },
            edited: 'edited-room',
            followed: 'room-b',
            apiBaseUrl: 'http://localhost',
            timeoutMs: 5_000,
            sorts: ['active-desc', 'online-active-desc'],
            expectedOtherClient: 'bob'
        });
    });

    it('keeps edited variables without global values', async () => {
        await render({ globalValues: undefined });
        await act(async () => view.updateVariable('groupId', 'edited-room'));
        await render({ globalValues: undefined });

        expect(view.variables.groupId).toBe('edited-room');
    });

    it('runs a preset action as an authenticated state request and promotes a created group to the global room', async () => {
        respond = () => ({ status: 200, body: { ...roomA, group: { ...roomA.group, groupId: 'room-created' } } });
        await render();
        await act(async () => view.runPresetAction(action('create-group')));

        expect({
            requests: requests.map(({ method, url, authorization }) => ({ method, url, authorization })),
            log: view.actions.map(({ label, ok, status, statusText }) => ({ label, ok, status, statusText })),
            feedback: feedback(),
            groups: view.groupRows.map((row) => row.groupId),
            globalChanges,
            busyAction: view.busyAction,
            localError: view.localError
        }).toEqual({
            requests: [{ method: 'POST', url: expect.stringMatching(new RegExp(`^${stateBase}/groups/requests/[^/]+$`)), authorization: 'Bearer test-token' }],
            log: [{ label: 'Create group', ok: true, status: 200, statusText: 'OK' }],
            feedback: {
                state: 'success',
                label: 'Create group',
                target: requests[0]?.url,
                status: 200,
                statusText: 'OK',
                message: 'Request completed.'
            },
            groups: ['room-created'],
            globalChanges: ['roomId=room-created'],
            busyAction: undefined,
            localError: undefined
        });
    });

    it('reports a failed preset response without promoting the group, keeps its body as group state, and ignores an action without a preset', async () => {
        respond = () => ({ status: 503, body: { error: 'down' } });
        await render();
        await act(async () => view.runPresetAction({ actionId: 'refresh-state', label: 'Refresh state' }));
        const requestsWithoutPreset = requests.length;
        await act(async () => view.runPresetAction(action('join-group')));

        expect({ requestsWithoutPreset, feedback: feedback(), globalChanges, groups: view.groupRows.length }).toEqual({
            requestsWithoutPreset: 0,
            feedback: {
                state: 'error',
                label: 'Join group',
                target: `${stateBase}/groups/room-a/members/client/requests/${view.variables.requestId}`,
                status: 503,
                statusText: 'Service Unavailable',
                message: 'HTTP 503 Service Unavailable'
            },
            globalChanges: [],
            groups: 1
        });
    });

    it('reports a request that cannot be built for a signed-out browser as a local error', async () => {
        await render({ authSession: undefined });
        await act(async () => view.runPresetAction(action('list-groups')));

        expect({ requests: requests.length, localError: view.localError, feedback: feedback() }).toEqual({
            requests: 0,
            localError: 'Rallar Server request requires a browser auth session.',
            feedback: {
                state: 'error',
                label: 'List groups',
                target: 'groups-list',
                statusText: 'error',
                message: 'Rallar Server request requires a browser auth session.'
            }
        });
    });

    it('refreshes groups, clients, the group and both event pages, and reports the first failed step', async () => {
        respond = (_method, url) => {
            if (url.startsWith(`${stateBase}/groups/room-a/events/page`)) {
                return {
                    status: 200,
                    body: { events: [{ eventId: 'g-1', eventType: 'group.created', groupId: 'room-a', snapshotVersion: 1, occurredAtEpochMs: 1 }] }
                };
            }
            if (url.startsWith(`${stateBase}/clients/client/events/page`)) {
                return { status: 200, body: { events: [{ eventId: 'c-1', eventType: 'client.connected', principalId: 'client', snapshotVersion: 2 }] } };
            }
            if (url === `${stateBase}/clients`) {
                return { status: 503, body: [] };
            }
            return url === `${stateBase}/groups` ? { status: 200, body: [roomA, emptyRoom] } : { status: 200, body: roomA };
        };
        await render();
        await act(async () => view.refreshState());

        expect({
            requests: requests.map(({ method, url }) => `${method} ${url.replace(stateBase, '')}`),
            log: view.actions.map(({ label, ok }) => `${label}:${ok}`),
            feedback: feedback(),
            events: view.stateEvents.map(({ rowId, eventType, subject, snapshotVersion, atEpochMs }) => ({
                rowId,
                eventType,
                subject,
                snapshotVersion,
                atEpochMs
            }))
        }).toEqual({
            requests: [
                'GET /groups',
                'GET /clients',
                'GET /groups/room-a',
                'GET /clients/client/events/page?limit=20',
                'GET /groups/room-a/events/page?limit=20'
            ],
            log: ['List groups:true', 'List clients:false', 'Read group:true', 'List client events page:true', 'List group events page:true'],
            feedback: {
                state: 'error',
                label: 'Refresh state',
                target: 'http://localhost/api/state',
                status: 503,
                statusText: 'Service Unavailable',
                message: 'Refresh completed with a failed step: HTTP 503 Service Unavailable.'
            },
            events: [
                { rowId: 'c-1', eventType: 'client.connected', subject: 'client', snapshotVersion: '2', atEpochMs: undefined },
                { rowId: 'g-1', eventType: 'group.created', subject: 'room-a', snapshotVersion: '1', atEpochMs: 1 }
            ]
        });
    });

    it('filters, sorts and matches the current client and room from the listed state', async () => {
        respond = (_method, url) => url.endsWith('/clients') ? { status: 200, body: [bobClient, selfClient] } : { status: 200, body: [roomA, emptyRoom] };
        await render();
        await act(async () => view.runPresetAction(action('list-groups')));
        await act(async () => view.runPresetAction(action('list-clients')));
        const unfiltered = {
            groups: view.sortedGroupRows.map((row) => row.groupId),
            clients: view.sortedClientRows.map((row) => row.principalId),
            currentSessionInGroup: view.currentSessionInGroup,
            currentClientOnline: view.currentClientOnline,
            bobVisible: view.expectedOtherClientVisible
        };
        await act(async () => {
            view.setOnlyGroupsWithMembers(true);
            view.setOnlyOnlineClients(true);
            view.setGroupSort('name-asc');
            view.setExpectedOtherClient('USER');
        });

        expect({
            unfiltered,
            groups: view.visibleGroupRows.map((row) => row.groupId),
            clients: view.visibleClientRows.map((row) => row.principalId),
            sortedGroups: view.sortedGroupRows.map((row) => row.groupId),
            userVisible: view.expectedOtherClientVisible,
            missingClients: view.missingClients
        }).toEqual({
            unfiltered: {
                groups: ['room-a', 'room-empty'],
                clients: ['client', 'bob'],
                currentSessionInGroup: true,
                currentClientOnline: true,
                bobVisible: false
            },
            groups: ['room-a'],
            clients: ['client'],
            sortedGroups: ['room-a'],
            userVisible: true,
            missingClients: []
        });
    });

    it.each(
        [
            { roomAction: 'refresh', expectedCall: { refresh: { scope: { applicationId: 'app', workspaceId: 'workspace' }, timeoutMs: 5_000 } }, promoted: [] },
            {
                roomAction: 'create',
                expectedCall: { create: { displayName: 'room-a', scope: { applicationId: 'app', workspaceId: 'workspace' }, timeoutMs: 5_000 } },
                promoted: ['roomId=room-joined']
            },
            {
                roomAction: 'join',
                expectedCall: { join: ['room-a', { scope: { applicationId: 'app', workspaceId: 'workspace' }, timeoutMs: 5_000 }] },
                promoted: ['roomId=room-joined']
            },
            {
                roomAction: 'leave',
                expectedCall: { leave: { roomId: 'room-a', scope: { applicationId: 'app', workspaceId: 'workspace' }, timeoutMs: 5_000 } },
                promoted: []
            }
        ] as const
    )('runs the direct room $roomAction through the started browser facade', async ({ roomAction, expectedCall, promoted }) => {
        const joined = { ...roomA, group: { ...roomA.group, groupId: 'room-joined' } };
        loadFacade.mockResolvedValue({
            configure: (options: RallarBlackBoxTestRecord) => facadeCalls.push({ configure: options }),
            setDefaults: () => {},
            start: async (options: RallarBlackBoxTestRecord) => {
                facadeCalls.push({ start: options });
                return { session: authSession, connected: true };
            },
            rooms: {
                refresh: async (options: RallarBlackBoxTestRecord) => {
                    facadeCalls.push({ refresh: options });
                    return { rooms: [{ snapshot: roomA }], members: [{ client: selfClient }] };
                },
                create: async (options: RallarBlackBoxTestRecord) => {
                    facadeCalls.push({ create: options });
                    return joined;
                },
                join: async (roomId: string, options: RallarBlackBoxTestRecord) => {
                    facadeCalls.push({ join: [roomId, options] });
                    return joined;
                },
                leave: async (options: RallarBlackBoxTestRecord) => {
                    facadeCalls.push({ leave: options });
                    return undefined;
                }
            }
        });
        await render();
        await act(async () => view.runDirectRoomsAction(roomAction));

        expect({
            facadeCalls,
            log: view.actions.map(({ label, ok, status, statusText }) => ({ label, ok, status, statusText })),
            feedback: feedback(),
            promoted: globalChanges,
            groups: view.groupRows.map((row) => row.groupId),
            clients: view.clientRows.map((row) => row.principalId),
            events: runtimeEvents.map((event) => [event.topic, (event.payload as RallarBlackBoxTestRecord).action])
        }).toEqual({
            facadeCalls: [
                { configure: { apiBaseUrl: 'http://localhost' } },
                { start: { connect: true, refreshRooms: false, refreshPeople: false, timeoutMs: 5_000 } },
                expectedCall
            ],
            log: [{ label: `Direct room ${roomAction}`, ok: true, status: 200, statusText: 'OK' }],
            feedback: { state: 'success', label: `Direct room ${roomAction}`, target: 'room-a', status: 'ok', message: 'Rallar facade action completed.' },
            promoted,
            groups: roomAction === 'refresh' ? ['room-a'] : roomAction === 'leave' ? [] : ['room-joined'],
            clients: roomAction === 'refresh' ? ['client'] : [],
            events: [[`rallar.direct.rooms.${roomAction}.completed`, roomAction]]
        });
    });

    it('records a direct room action outside the browser provider as a failed action', async () => {
        await render({ bootstrap: { ...resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar', {}, ''), providerMode: 'simulated' } });
        await act(async () => view.runDirectRoomsAction('join'));

        expect({
            localError: view.localError,
            log: view.actions.map(({ label, ok, status, statusText, errorKind }) => ({ label, ok, status, statusText, errorKind })),
            feedback: feedback(),
            events: runtimeEvents
        }).toEqual({
            localError: 'Direct room actions require provider=browser-rallar.',
            log: [{
                label: 'Direct room join',
                ok: false,
                status: 0,
                statusText: 'Direct room actions require provider=browser-rallar.',
                errorKind: 'direct-rallar'
            }],
            feedback: {
                state: 'error',
                label: 'Direct room join',
                target: 'room-a',
                statusText: 'error',
                message: 'Direct room actions require provider=browser-rallar.'
            },
            events: []
        });
    });

    it('copies the state recipe as the six lifecycle requests in catalogue order', async () => {
        const copied: string[] = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        await render();
        await act(async () => view.copyStateRecipe());
        const recipe = JSON.parse(copied[0] ?? 'null');

        expect({
            valid: validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe }),
            header: { schemaVersion: recipe.schemaVersion, recipeId: recipe.recipeId, continueOnFailure: recipe.continueOnFailure },
            commands: recipe.commands.map((command: { commandId: string; request: { method: string; }; }) => `${command.commandId} ${command.request.method}`),
            authorization: copied[0]?.includes('test-token')
        }).toEqual({
            valid: { ok: true },
            header: { schemaVersion: 1, recipeId: 'rallar-rooms-clients-command-center', continueOnFailure: false },
            commands: [
                'rooms-clients-1-create-group POST',
                'rooms-clients-2-join-group PUT',
                'rooms-clients-3-group-presence-connect PUT',
                'rooms-clients-4-group-events-page GET',
                'rooms-clients-5-client-session-connect PUT',
                'rooms-clients-6-client-events-page GET'
            ],
            authorization: false
        });
    });
});
