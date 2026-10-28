import {
    expect,
    type Page,
    type Route,
    type WebSocketRoute
} from '@playwright/test';

import {
    newALBroadcastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodeALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { newALReplyMessage } from '@shared/al-contracts/reply/new-al-reply-message.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createRallarAiJsonResult,
    createRallarAiMockProvider,
    type RallarAiJsonRequest
} from '@shared/rallar-ai/mod.ts';
import {
    computeRelicPlanningAiSuggestion,
    decodeRelicPlanningAiContext,
    isRelicCommand,
    RELIC_TYPES,
    type RelicCommand,
    type RelicHunterEvent,
    type RelicPlanningAiSuggestion,
    type RelicPublicSnapshot
} from '../../../packages/relic-hunters/mod.ts';
import {
    createActiveClientInstanceFixture,
    createActiveClientSessionFixture,
    createActiveGroupMemberFixture,
    createActiveGroupPresenceSessionFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture
} from '../../../packages/tests/shared-web/authoritative-group-fixtures.ts';

import { createEmptyRelicSnapshot, createRelicSnapshotWithPlayers } from './relic-browser-snapshots.ts';

export const session = {
    clientId: 'alice-client',
    accessToken: 'alice-token',
    username: 'alice',
    sessionId: 'alice-session',
    expiresAtEpochMs: Date.now() + 3_600_000
};

export async function initBrowserTestTransport(page: Page): Promise<void> {
    await page.addInitScript(() => window.localStorage.removeItem('relic.sceneNext.cameraMode'));
}

export async function restoreAuthenticatedSession(page: Page): Promise<void> {
    await page.addInitScript((storedSession) => {
        window.localStorage.setItem(
            'auth.session',
            JSON.stringify({
                ...storedSession,
                expiresAtEpochMs: Date.now() + 3_600_000
            })
        );
    }, session);
}

export async function startRelicBrowserBackend(
    page: Page,
    options: RelicBrowserBackend.Options
): Promise<Pick<RelicBrowserBackend, 'publishSnapshot'>> {
    const backend = new RelicBrowserBackend(options);
    await page.route('http://127.0.0.1:5175/api/**', (route) => backend.respond(route));
    await page.routeWebSocket('**/api/ws/**', (socket) => backend.connect(socket));
    return backend;
}

namespace RelicBrowserBackend {
    export interface Options {
        readonly wsUrls?: string[];
        readonly receivedFrames?: ALMessage[];
        readonly httpCommands?: boolean;
        readonly commandRefusal?: string;
        readonly rooms?: readonly GroupSnapshot[];
        readonly relicSnapshot?: RelicPublicSnapshot;
        readonly commandSnapshot?: RelicPublicSnapshot;
        readonly commandSnapshots?: readonly RelicPublicSnapshot[];
        readonly commandResponse?: (command: RelicCommand) => RelicPublicSnapshot;
        readonly requests?: string[];
        readonly commandBodies?: RelicCommand[];
        /**
         * Absent, the server admits a planning request and never replies; present, it replies with the deterministic
         * companion's suggestion under this headline.
         */
        readonly planningReplyHeadline?: string;
        readonly planningReplies?: RelicPlanningAiSuggestion[];
    }
}

class RelicBrowserBackend {
    private readonly options: RelicBrowserBackend.Options;
    private rooms: readonly GroupSnapshot[];
    private snapshot: RelicPublicSnapshot;
    private commandIndex = 0;
    private readonly client = createClientSnapshot();
    private readonly sockets = new Set<WebSocketRoute>();

    constructor(options: RelicBrowserBackend.Options) {
        this.options = options;
        this.rooms = options.rooms ?? [];
        this.snapshot = options.relicSnapshot ?? createRelicSnapshotWithPlayers(1);
    }

    connect(socket: WebSocketRoute): void {
        this.sockets.add(socket);
        this.options.wsUrls?.push(socket.url());
        socket.onMessage((serialized) => this.respondWsCommand(socket, String(serialized)));
    }

    private respondWsCommand(socket: WebSocketRoute, serialized: string): void {
        const message = decodeALMessage(serialized).right;
        if (!message) {
            return;
        }
        this.options.receivedFrames?.push(message);
        if (message.payload.typeId === RELIC_TYPES.aiPlanningRequest) {
            this.respondPlanningRequest(socket, message);
            return;
        }
        if (message.payload.typeId !== 'relic.command.v1') {
            return;
        }
        const command = JSON.parse(message.payload.resource);
        if (!isRelicCommand(command)) {
            throw new Error('Browser sent an invalid expedition command');
        }
        if (this.options.commandRefusal !== undefined) {
            socket.send(toServerAckFrame(message));
            socket.send(toHunterRefusalFrame(command, this.options.commandRefusal));
            return;
        }
        this.acceptCommand(command);
        socket.send(toServerAckFrame(message));
        socket.send(toSnapshotFrame(this.snapshot));
    }

    /** As the Relic server's planning topic does: a reply to the asking session alone, under the request's correlation. */
    private respondPlanningRequest(socket: WebSocketRoute, message: ALMessage): void {
        socket.send(toServerAckFrame(message));
        if (this.options.planningReplyHeadline === undefined) {
            return;
        }
        const request: RallarAiJsonRequest = JSON.parse(message.payload.resource);
        const context = decodeRelicPlanningAiContext(request.context).right;
        if (context === undefined) {
            throw new Error('Browser sent a planning request with an undecodable context');
        }
        const suggestion = {
            ...computeRelicPlanningAiSuggestion(context),
            headline: this.options.planningReplyHeadline
        };
        this.options.planningReplies?.push(suggestion);
        const result = createRallarAiJsonResult({
            request,
            provider: createRallarAiMockProvider({ providerId: 'relic-planning-deterministic' }),
            value: suggestion
        });
        socket.send(JSON.stringify(newALReplyMessage(message, {
            senderId: 'default-qbox-server',
            typeId: RELIC_TYPES.aiPlanningReply,
            payload: result
        })));
    }

    publishSnapshot(snapshot: RelicPublicSnapshot): void {
        this.snapshot = snapshot;
        for (const socket of this.sockets) {
            socket.send(toSnapshotFrame(snapshot));
        }
    }

    private acceptCommand(command: RelicCommand): void {
        this.options.commandBodies?.push(command);
        this.snapshot = this.options.commandResponse?.(command) ??
            this.options.commandSnapshots?.[this.commandIndex] ??
            this.options.commandSnapshot ?? createRelicSnapshotWithPlayers(1);
        this.commandIndex += 1;
    }

    async respond(route: Route): Promise<void> {
        const path = new URL(route.request().url()).pathname;
        this.options.requests?.push(`${route.request().method()} ${path}`);
        if (path.startsWith('/api/relic/')) {
            await this.respondExpedition(route, path);
        }
        else if (path.startsWith('/api/state/')) {
            await this.respondPlatformState(route, path);
        }
        else {
            await this.respondAuthentication(route, path);
        }
    }

    private async respondExpedition(route: Route, path: string): Promise<void> {
        if (path === '/api/relic/games/room-1' && route.request().method() === 'GET') {
            await route.fulfill({ json: this.snapshot });
            return;
        }
        const mutation = /^\/api\/relic\/games\/room-1\/(commands|reset)\/requests\/([0-9a-f-]{36})$/.exec(path);
        if (!mutation || route.request().method() !== 'POST') {
            await route.fulfill({ status: 404, json: { error: 'Unknown expedition operation' } });
            return;
        }
        if (mutation[1] === 'reset') {
            this.snapshot = createEmptyRelicSnapshot();
        }
        else {
            const command = route.request().postDataJSON();
            if (!isRelicCommand(command)) {
                await route.fulfill({ status: 400, json: { error: 'Invalid command' } });
                return;
            }
            this.acceptCommand(command);
        }
        await route.fulfill({ json: this.snapshot });
    }

    private async respondPlatformState(route: Route, path: string): Promise<void> {
        if (path.endsWith('/topology')) {
            await route.fulfill({ json: createEmptyTopology() });
        }
        else if (path.endsWith('/clients') && route.request().method() === 'GET') {
            await route.fulfill({ json: [this.client] });
        }
        else if (/\/groups\/requests\/[^/]+$/.test(path) && route.request().method() === 'POST') {
            const created = createGroupSnapshot({ onlineMemberCount: 1 });
            this.rooms = [created];
            await route.fulfill({ status: 201, json: created });
        }
        else if (path.endsWith('/groups') && route.request().method() === 'GET') {
            await route.fulfill({ json: this.rooms });
        }
        else if (path.includes('/groups/')) {
            const room = this.rooms[0] ?? createGroupSnapshot({ onlineMemberCount: 1 });
            this.rooms = [room];
            await route.fulfill({
                headers: {
                    'rallar-state-source': 'durable',
                    'cache-control': 'no-store',
                    'rallar-group-revision': String(room.causalRevision.groupRevision),
                    'rallar-presence-revision': String(room.causalRevision.presenceRevision)
                },
                json: room
            });
        }
        else if (path.includes('/clients/')) {
            await route.fulfill({
                headers: {
                    'rallar-state-source': 'durable',
                    'cache-control': 'no-store',
                    'rallar-state-revision': String(this.client.stateRevision)
                },
                json: this.client
            });
        }
        else {
            await route.fulfill({ status: 404, json: { error: 'Unknown platform operation' } });
        }
    }

    private async respondAuthentication(route: Route, path: string): Promise<void> {
        if (path === '/api/config') {
            await route.fulfill({
                json: {
                    apiBaseUrl: 'http://127.0.0.1:5175',
                    wsBaseUrl: 'ws://127.0.0.1:5175',
                    endpoints: { createWs: '/api/ws/:id' },
                    ...(this.options.httpCommands ? {} : { serverPeerId: 'default-qbox-server' })
                }
            });
        }
        else if (path.startsWith('/api/auth/register/requests/')) {
            expect(route.request().postDataJSON()).not.toHaveProperty('requestId');
            await route.fulfill({
                status: 201,
                json: {
                    clientId: session.clientId,
                    username: session.username,
                    displayName: 'Alice',
                    registeredAtEpochMs: Date.now()
                }
            });
        }
        else if (path.startsWith('/api/auth/login/requests/')) {
            expect(route.request().postDataJSON()).not.toHaveProperty('requestId');
            await route.fulfill({ json: session });
        }
        else if (path.startsWith('/api/auth/ws-ticket/requests/')) {
            await route.fulfill({
                json: {
                    ticket: 'test-ticket',
                    sessionId: session.sessionId,
                    expiresAtEpochMs: Date.now() + 60_000
                }
            });
        }
        else if (path === '/api/webrtc/ice') {
            await route.fulfill({ json: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 } });
        }
        else {
            await route.fulfill({ status: 404, json: { error: 'Unknown API operation' } });
        }
    }
}

function createClientSnapshot(): ClientSnapshot {
    const now = Date.now();
    const instanceRef = {
        applicationId: 'rallar-server',
        workspaceId: 'default',
        principalId: session.clientId,
        clientInstanceId: session.clientId
    };
    const snapshot = createClientSnapshotFixture(instanceRef);
    return {
        ...snapshot,
        stateRevision: 1,
        principal: { ...snapshot.principal, username: session.username, displayName: 'Alice' },
        instances: [createActiveClientInstanceFixture(instanceRef)],
        activeSessions: [
            {
                ...createActiveClientSessionFixture({ ...instanceRef, sessionId: session.sessionId }),
                connectionId: `generation-${session.sessionId}`,
                lastHeartbeatAtEpochMs: now,
                expiresAtEpochMs: now + 60_000
            }
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: now
    };
}

export function createGroupSnapshot(
    options: Readonly<{ onlineMemberCount: number; }>
): GroupSnapshot {
    const now = Date.now();
    const scope = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room-1' };
    const principalIds = [
        session.clientId,
        ...Array.from({ length: Math.max(0, options.onlineMemberCount - 1) }, (_, index) => `hunter-${index + 2}`)
    ];
    const onlinePrincipalIds = principalIds.slice(0, options.onlineMemberCount);
    const snapshot = createGroupSnapshotFixture({ ...scope, sessionIds: [] });
    const groupRevision = 1;
    return {
        ...snapshot,
        causalRevision: { groupRevision, presenceRevision: onlinePrincipalIds.length },
        group: {
            ...snapshot.group,
            snapshotVersion: groupRevision,
            slug: 'relic-hunters-expedition',
            displayName: 'Relic Hunters Expedition',
            joinMode: 'invite-only',
            activeMemberCount: principalIds.length,
            ownerPrincipalId: session.clientId,
            presenceVersion: onlinePrincipalIds.length,
            formationElectorate: principalIds
        },
        members: principalIds.map((principalId) =>
            createActiveGroupMemberFixture({
                ...scope,
                principalId,
                role: principalId === session.clientId ? 'owner' : 'member',
                actorPrincipalId: session.clientId
            })
        ),
        activeSessions: onlinePrincipalIds.map((principalId) => ({
            ...createActiveGroupPresenceSessionFixture({
                ...scope,
                principalId,
                sessionId: principalId === session.clientId ? session.sessionId : `${principalId}-session`
            }),
            connectedAtEpochMs: now,
            lastHeartbeatAtEpochMs: now,
            expiresAtEpochMs: now + 60_000
        })),
        memberCount: principalIds.length,
        onlineMemberCount: onlinePrincipalIds.length
    };
}

function toServerAckFrame(command: ALMessage): string {
    return JSON.stringify(newALAckControlMessage(
        {
            v: 4,
            msgId: `ack-${command.id.msgId}`,
            ts: Date.now(),
            senderId: 'default-qbox-server',
            traceId: 'trace-relic-browser-backend'
        },
        {
            ackedMsgId: command.id.msgId,
            fromPeerId: 'default-qbox-server',
            toPeerId: command.id.senderId,
            originPeerId: command.id.senderId,
            logicalRecipientPeerId: 'default-qbox-server',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    ));
}

/** The applied snapshot as the Relic server publishes it (`toRelicPublicSnapshotMessage`): `receiver`, at-least-once. */
function toSnapshotFrame(snapshot: RelicPublicSnapshot): string {
    const roomId = String(snapshot.roomId);
    return JSON.stringify(newALBroadcastMessage(
        'default-qbox-server',
        newALRoute('room.relic.snapshot', roomId, `${String(snapshot.gameId)}:${String(snapshot.round)}`),
        'room',
        'relic.snapshot.v1',
        { protocolVersion: snapshot.protocolVersion, gameId: snapshot.gameId, snapshot },
        {
            groupRef: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: roomId
            },
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: 15_000
        }
    ));
}

function createEmptyTopology(): GroupTopologyManagementView {
    const groupRef = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room-1' };
    const defaults: GroupTopologyManagementView['config']['effective'] = {
        topologyKind: 'auto',
        degreeLimit: 5,
        treeMinSize: 3,
        meshMinSize: 8,
        meshParamK: 2
    };
    return {
        groupRef,
        overlayId: toScopedOverlayId(groupRef),
        snapshot: null,
        acceptedSnapshot: null,
        config: { serverDefaults: defaults, durable: null, temporary: null, requestOptions: null, effective: defaults },
        pending: null
    };
}

function toHunterRefusalFrame(command: RelicCommand, text: string): string {
    const event: RelicHunterEvent = {
        protocolVersion: command.protocolVersion,
        gameId: command.gameId,
        principalId: session.clientId,
        playerId: session.sessionId,
        kind: 'command-refused',
        command: command.kind,
        text
    };
    return JSON.stringify(newALPrincipalBroadcastMessage(
        'default-qbox-server',
        newALRoute('room.relic.hunter', command.gameId, `refusal:${command.gameId}`),
        {
            groupRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: command.gameId },
            principalRef: { applicationId: 'rallar-server', workspaceId: 'default', principalId: session.clientId }
        },
        'relic.hunter.v1',
        event,
        { reliability: 'at-least-once', ack: 'receiver', ttlMs: 15_000 }
    ));
}
