import { expect, test } from '@playwright/test';

import { readBrowserRallarSmokeConfig, type SmokeTransport } from './browser-rallar-smoke-config.ts';
import { BrowserRallarTwoAgentSmoke } from './browser-rallar-two-agent-smoke.ts';

const config = readBrowserRallarSmokeConfig();
const hasTwoAgentConfig = Boolean(config.apiBaseUrl && config.roomId && config.agentAAuth && config.agentBAuth);
const peerReadiness = { minReadyPeers: 1, timeoutMs: 30_000, intervalMs: 250 };
const transports: readonly SmokeTransport[] = ['realtime', 'messages.rtc'];

for (const transport of transports) {
    test(
        `browser-rallar provider delivers ${transport} payloads between two real agents`,
        async ({ browser, request }, testInfo) => {
            test.setTimeout(120_000);
            test.skip(
                !hasTwoAgentConfig,
                `Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and two-agent Rallar login or restore config to run the live two-agent ${transport} smoke.`
            );
            const suffix = `${transport.replace('.', '-')}-${Date.now()}-${crypto.randomUUID()}`;
            const smoke = new BrowserRallarTwoAgentSmoke({
                browser,
                request,
                config,
                transport,
                suffix,
                runId: `real-rallar-two-agent-${suffix}`
            });
            try {
                const agentA = await smoke.openAgent('a');
                const agentB = await smoke.openAgent('b');
                await smoke.joinRoom(agentA);
                const connectConfig = { ...smoke.toConnectConfig(), logoutOnClose: false };
                const [connectedA, connectedB] = await Promise.all([
                    smoke.connect(agentA, `connect-a-${suffix}`, { rallar: connectConfig, readiness: peerReadiness }),
                    smoke.connect(agentB, `connect-b-${suffix}`, { rallar: connectConfig, readiness: peerReadiness })
                ]);
                expect(connectedA.sessionId).not.toBe(connectedB.sessionId);

                await smoke.deliver({
                    sender: connectedA,
                    receiver: connectedB,
                    commandId: `send-a-to-b-${suffix}`,
                    smokeId: `a-to-b-${suffix}`,
                    direction: 'a-to-b',
                    topic: 'rallar.black-box.two-agent',
                    timeoutMs: 30_000,
                    visibleInbox: true
                });
                await smoke.deliver({
                    sender: connectedB,
                    receiver: connectedA,
                    commandId: `send-b-to-a-${suffix}`,
                    smokeId: `b-to-a-${suffix}`,
                    direction: 'b-to-a',
                    topic: 'rallar.black-box.two-agent',
                    timeoutMs: 30_000,
                    visibleInbox: true
                });
                await Promise.all([smoke.finalizeAgent(agentA), smoke.finalizeAgent(agentB)]);
                await smoke.expectEvidence('delivery');
            }
            finally {
                await smoke.close(testInfo, undefined);
            }
        }
    );
}

for (const transport of transports) {
    test(
        `browser-rallar provider delivers ${transport} after reloading one real agent`,
        async ({ browser, request }, testInfo) => {
            test.setTimeout(180_000);
            test.skip(
                !hasTwoAgentConfig,
                `Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and two-agent Rallar login or restore config to run the live reload ${transport} smoke.`
            );
            const suffix = `${transport.replace('.', '-')}-reload-${Date.now()}-${crypto.randomUUID()}`;
            const smoke = new BrowserRallarTwoAgentSmoke({
                browser,
                request,
                config,
                transport,
                suffix,
                runId: `real-rallar-two-agent-reload-${suffix}`
            });
            try {
                const agentA = await smoke.openAgent('a');
                const agentB = await smoke.openAgent('b');
                await smoke.joinRoom(agentA);
                const connectConfig = { ...smoke.toConnectConfig(), logoutOnClose: false };
                const [connectedA, connectedB] = await Promise.all([
                    smoke.connect(agentA, `connect-a-${suffix}`, { rallar: connectConfig, readiness: peerReadiness }),
                    smoke.connect(agentB, `connect-b-${suffix}`, { rallar: connectConfig, readiness: peerReadiness })
                ]);
                expect(connectedA.sessionId).not.toBe(connectedB.sessionId);

                await smoke.deliver({
                    sender: connectedA,
                    receiver: connectedB,
                    commandId: `send-before-reload-${suffix}`,
                    smokeId: `before-reload-${suffix}`,
                    direction: 'a-to-b-before-reload',
                    topic: 'rallar.black-box.reload',
                    timeoutMs: 30_000,
                    visibleInbox: false
                });
                await smoke.expectHealth(connectedA, {
                    phase: 'before-reload-ready',
                    connected: true,
                    readyPeerId: connectedB.sessionId,
                    reconnectSuppressed: false
                });
                await smoke.expectHealth(connectedB, {
                    phase: 'before-reload-ready',
                    connected: true,
                    readyPeerId: connectedA.sessionId,
                    reconnectSuppressed: false
                });
                await smoke.reloadAgent(agentB);
                await smoke.expectHealth(connectedB, {
                    phase: 'after-page-reload-before-reconnect',
                    connected: false,
                    readyPeerId: undefined,
                    reconnectSuppressed: false
                });
                const reconnectedB = await smoke.connect(agentB, `connect-b-after-reload-${suffix}`, {
                    readiness: peerReadiness,
                    rallar: {
                        ...connectConfig,
                        password: '',
                        restoreSession: true,
                        expectedSessionId: connectedB.sessionId
                    }
                });
                expect(reconnectedB.sessionId).toBe(connectedB.sessionId);
                await smoke.expectHealth(connectedB, {
                    phase: 'after-reconnect',
                    connected: true,
                    readyPeerId: undefined,
                    reconnectSuppressed: false
                });

                await smoke.deliver({
                    sender: connectedA,
                    receiver: connectedB,
                    commandId: `send-after-reload-a-to-b-${suffix}`,
                    smokeId: `after-reload-a-to-b-${suffix}`,
                    direction: 'a-to-b-after-reload',
                    topic: 'rallar.black-box.reload',
                    timeoutMs: 45_000,
                    visibleInbox: true
                });
                await smoke.deliver({
                    sender: connectedB,
                    receiver: connectedA,
                    commandId: `send-after-reload-b-to-a-${suffix}`,
                    smokeId: `after-reload-b-to-a-${suffix}`,
                    direction: 'b-to-a-after-reload',
                    topic: 'rallar.black-box.reload',
                    timeoutMs: 45_000,
                    visibleInbox: true
                });
                await smoke.expectHealth(connectedA, {
                    phase: 'after-reload-delivery-ready',
                    connected: true,
                    readyPeerId: connectedB.sessionId,
                    reconnectSuppressed: false
                });
                await smoke.expectHealth(connectedB, {
                    phase: 'after-reload-delivery-ready',
                    connected: true,
                    readyPeerId: connectedA.sessionId,
                    reconnectSuppressed: false
                });
                await Promise.all([smoke.finalizeAgent(agentA), smoke.finalizeAgent(agentB)]);
                await smoke.expectEvidence('reload');
            }
            finally {
                await smoke.close(testInfo, `rallar-rtc-reload-snapshots-${transport}.json`);
            }
        }
    );
}

test('browser-rallar provider suppresses WS reconnect after intentional disconnect and reconnects explicitly', async ({
    browser,
    request
}, testInfo) => {
    test.skip(
        !hasTwoAgentConfig,
        'Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and two-agent Rallar login or restore config to run the live disconnect/reconnect smoke.'
    );
    const transport: SmokeTransport = 'realtime';
    const suffix = `disconnect-reconnect-${Date.now()}-${crypto.randomUUID()}`;
    const smoke = new BrowserRallarTwoAgentSmoke({
        browser,
        request,
        config,
        transport,
        suffix,
        runId: `real-rallar-two-agent-disconnect-${suffix}`
    });
    try {
        const agentA = await smoke.openAgent('a');
        const agentB = await smoke.openAgent('b');
        await smoke.joinRoom(agentA);
        const connectConfig = smoke.toConnectConfig();
        const [connectedA, connectedB] = await Promise.all([
            smoke.connect(agentA, `connect-a-${suffix}`, { rallar: connectConfig, readiness: peerReadiness }),
            smoke.connect(agentB, `connect-b-${suffix}`, { rallar: connectConfig, readiness: peerReadiness })
        ]);
        expect(connectedA.sessionId).not.toBe(connectedB.sessionId);

        await smoke.deliver({
            sender: connectedA,
            receiver: connectedB,
            commandId: `send-before-close-${suffix}`,
            smokeId: `before-close-${suffix}`,
            direction: 'a-to-b-before-close',
            topic: 'rallar.black-box.disconnect',
            timeoutMs: 30_000,
            visibleInbox: false
        });
        await smoke.expectHealth(connectedB, {
            phase: 'before-close',
            connected: true,
            readyPeerId: connectedA.sessionId,
            reconnectSuppressed: false
        });
        await smoke.disconnectAgent(agentB);
        await smoke.expectHealth(connectedB, {
            phase: 'after-close',
            connected: false,
            readyPeerId: undefined,
            reconnectSuppressed: true
        });
        const reconnectedB = await smoke.connect(agentB, `reconnect-b-${suffix}`, {
            readiness: peerReadiness,
            rallar: {
                ...connectConfig,
                password: '',
                restoreSession: true,
                expectedSessionId: connectedB.sessionId,
                logoutOnClose: false
            }
        });
        expect(reconnectedB.sessionId).toBe(connectedB.sessionId);
        await smoke.deliver({
            sender: connectedA,
            receiver: connectedB,
            commandId: `send-after-reconnect-${suffix}`,
            smokeId: `after-reconnect-${suffix}`,
            direction: 'a-to-b-after-reconnect',
            topic: 'rallar.black-box.disconnect',
            timeoutMs: 30_000,
            visibleInbox: false
        });
        await smoke.expectHealth(connectedB, {
            phase: 'after-reconnect',
            connected: true,
            readyPeerId: connectedA.sessionId,
            reconnectSuppressed: false
        });
        await Promise.all([smoke.finalizeAgent(agentA), smoke.finalizeAgent(agentB)]);
        await smoke.expectEvidence('disconnect');
    }
    finally {
        await smoke.close(testInfo, 'rallar-ws-disconnect-reconnect-snapshots.json');
    }
});
