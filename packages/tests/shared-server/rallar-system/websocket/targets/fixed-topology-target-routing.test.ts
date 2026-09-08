import { materializeRtcOverlayTopologyMessages } from '@shared-server/rallar-system/topology/planning/materialize-rtc-overlay-topology-messages.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { expect, it } from 'vitest';
import { createRtcTopologyReplayFixture } from '../../topology/replay/consumer/rtc-topology-replay-fixture.ts';
import { createOpenTestWebSocket } from '../test-support/open-test-websocket.ts';

it.each(['short-room', 'group-rtc-replay-33fd71196b34408d84fbf238'])(
    'routes frozen production topology pages for %s with a cold room cache',
    (groupId) => {
        const fixture = createRtcTopologyReplayFixture(1500);
        const groupRef = { ...fixture.publication.groupRef, groupId };
        const snapshot = { ...fixture.currentSnapshot, groupRef, overlayId: toScopedOverlayId(groupRef) };
        const pages = materializeRtcOverlayTopologyMessages({ ...fixture.publication, snapshot });
        const server = new JsonWebSocketServer();
        for (const id of ['session-1', 'session-999', 'not-a-recipient']) {
            server.addConnection(server.createConnectionContext({ id, socket: createOpenTestWebSocket() }));
        }
        const resolver = createWsServerTargetResolver(server);
        const recipients = pages.flatMap((message) => resolver.resolveBroadcastRecipients?.('room', message) ?? []);
        expect([...new Set(recipients.map((recipient) => recipient.connectionId))].sort()).toEqual(['session-1', 'session-999']);
        expect(pages.length).toBeGreaterThan(1);
        if (groupId.length > 35) {
            expect(pages[0]!.route.contextId).not.toBe(groupId);
        }
        const page = pages[0]!;
        expect(resolver.resolveBroadcastRecipients?.('room', { ...page, route: { ...page.route, contextId: 'another-room' } })).toEqual([]);
    }
);
