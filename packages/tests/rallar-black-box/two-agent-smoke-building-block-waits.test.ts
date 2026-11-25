import type * as Playwright from '@playwright/test';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import type { BrowserRallarSmokeConfig } from '../../../tests/playwright/rallar-black-box/browser-rallar-smoke-config.ts';
import {
    BrowserRallarTwoAgentSmoke,
    TWO_AGENT_DISCONNECT_SETTLE_MS,
    TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS,
    TWO_AGENT_RESULT_POLL_TIMEOUT_MS,
    TWO_AGENT_SIDES
} from '../../../tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.ts';
import {
    computeTwoAgentDeliveryBoundedWaitsMs,
    TWO_AGENT_CONNECT_STAGE_WAIT_MS,
    TWO_AGENT_OPERATION_BOUNDED_WAITS_MS,
    TWO_AGENT_PEER_READINESS,
    TWO_AGENT_SEND_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/two-agent-smoke-test-timeouts.ts';
import { createCountedPage, measureBoundedWaitsMs, settleUnderFakeTimers } from './bounded-wait-clock-fixture.ts';

vi.mock('@playwright/test', async (importOriginal) => {
    const { toCountedPlaywrightModule } = await import('./bounded-wait-clock-fixture.ts');
    return toCountedPlaywrightModule(await importOriginal(), RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS);
});

interface PostedCommand {
    readonly agentId: string;
    readonly commandId: string;
    readonly command: RallarBlackBoxTestCommand;
}

const config: BrowserRallarSmokeConfig = {
    apiBaseUrl: 'http://localhost:18080',
    roomId: 'room',
    agentAAuth: { kind: 'login', username: 'a', password: 'a' },
    agentBAuth: { kind: 'login', username: 'b', password: 'b' },
    agentAActor: undefined,
    agentBActor: undefined,
    messagesRtcTypeId: 'type',
    messagesRtcTopicId: 'topic',
    register: undefined,
    logoutOnClose: false,
    leaveRoomOnClose: undefined
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
    vi.useRealTimers();
});

/** The session a connected agent is given, which a send names to reach it. */
function toSessionId(agentId: string): string {
    return `session-${agentId}`;
}

/** The value each command's result carries, enough for the smoke's own checks of it. */
function toResultValue(posted: PostedCommand): ApiJsonObject {
    const { command, agentId } = posted;
    if (command.kind === 'rtc.connect') {
        return { sessionId: toSessionId(agentId) };
    }
    if (command.kind === 'close') {
        return { rallar: { status: 'closed', disconnected: true } };
    }
    return {
        rallar: { connected: true, session: { sessionId: toSessionId(agentId) }, rtcStatus: { readyPeerIds: [] } }
    };
}

/** A send's receiver records the message; a stats read and a report recipe each report for their agent. */
function toRunEvents(posted: readonly PostedCommand[], kind: 'rtc.send' | 'stats' | 'recipe.run'): readonly ApiJsonObject[] {
    return posted.filter(({ command }) => command.kind === kind).map(({ agentId, command }): ApiJsonObject => {
        if (command.kind !== 'rtc.send') {
            return { agentId };
        }
        const send = command.send as ApiJsonObject;
        const peers = (send.peerIds ?? send.nextHopPeerIds) as readonly string[];
        return {
            agentId: peers[0].replace('session-', ''),
            payload: { kind: 'message', transport: command.transport ?? null, payload: { data: send.data ?? send.payload ?? null } }
        };
    });
}

/** A control run that has answered every command posted to it. */
function toRunSnapshot(posted: readonly PostedCommand[]): ApiJsonObject {
    return {
        agents: [...new Set(posted.map(({ agentId }) => agentId))].map((agentId) => ({ agentId })),
        results: posted.map((entry) => ({ commandId: entry.commandId, ok: true, result: { value: toResultValue(entry) } })),
        events: toRunEvents(posted, 'rtc.send'),
        stats: toRunEvents(posted, 'stats'),
        reports: toRunEvents(posted, 'recipe.run')
    } as ApiJsonObject;
}

/** A smoke whose browser opens counted pages and whose control run answers every command it is sent. */
function createCountedSmoke(): BrowserRallarTwoAgentSmoke {
    const posted: PostedCommand[] = [];
    const request = {
        post: async (url: string, options: { data: { commandId: string; command: RallarBlackBoxTestCommand; }; }) => {
            posted.push({ agentId: decodeURIComponent(url.split('/').at(-2)!), ...options.data });
            return { status: () => 202 };
        },
        get: async () => ({ ok: () => true, json: async () => toRunSnapshot(posted) })
    };
    const browser = {
        newContext: async () => ({ newPage: async () => createCountedPage(), close: async () => {} })
    };
    return new BrowserRallarTwoAgentSmoke({
        browser: browser as unknown as Playwright.Browser,
        request: request as unknown as Playwright.APIRequestContext,
        config,
        transport: 'realtime',
        suffix: 'counted',
        runId: 'run'
    });
}

async function openConnectedPair(smoke: BrowserRallarTwoAgentSmoke) {
    return await settleUnderFakeTimers(async () => {
        const [agentA, agentB] = [await smoke.openAgent('a'), await smoke.openAgent('b')];
        const connection = { rallar: {}, readiness: TWO_AGENT_PEER_READINESS };
        return {
            agentA,
            agentB,
            connectedA: await smoke.connect(agentA, 'connect-a', connection),
            connectedB: await smoke.connect(agentB, 'connect-b', connection)
        };
    });
}

describe('the two-agent smoke\'s operations wait what their derivations count', () => {
    it('opens an agent through its login gate within the opening\'s bounded waits', async () => {
        const smoke = createCountedSmoke();

        expect(await measureBoundedWaitsMs(() => smoke.openAgent('a'))).toBe(
            TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.signInOpen
        );
    });

    it('creates the group and joins every agent within the membership\'s bounded waits', async () => {
        const smoke = createCountedSmoke();
        const [owner] = await settleUnderFakeTimers(async () => await Promise.all(TWO_AGENT_SIDES.map((side) => smoke.openAgent(side))));

        expect(await measureBoundedWaitsMs(() => smoke.joinRoom(owner))).toBe(
            TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.membership
        );
    });

    it('connects the two agents side by side within one connect stage', async () => {
        const smoke = createCountedSmoke();
        const agents = await settleUnderFakeTimers(async () => await Promise.all(TWO_AGENT_SIDES.map((side) => smoke.openAgent(side))));

        expect(
            await measureBoundedWaitsMs(() =>
                Promise.all(agents.map((agent) => smoke.connect(agent, `connect-${agent.agentId}`, { rallar: {}, readiness: TWO_AGENT_PEER_READINESS })))
            )
        ).toBe(TWO_AGENT_CONNECT_STAGE_WAIT_MS);
    });

    it.each([true, false])('delivers with a visible inbox %s within the delivery\'s bounded waits', async (visibleInbox) => {
        const smoke = createCountedSmoke();
        const { connectedA, connectedB } = await openConnectedPair(smoke);

        expect(
            await measureBoundedWaitsMs(() =>
                smoke.deliver({
                    sender: connectedA,
                    receiver: connectedB,
                    commandId: 'send-a-to-b',
                    smokeId: 'a-to-b',
                    direction: 'a-to-b',
                    topic: 'topic',
                    timeoutMs: TWO_AGENT_SEND_TIMEOUT_MS,
                    visibleInbox
                })
            )
        ).toBe(computeTwoAgentDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, visibleInbox));
    });

    it('reads a health, reloads, disconnects and finalizes within their bounded waits', async () => {
        const smoke = createCountedSmoke();
        const { agentA, agentB, connectedA, connectedB } = await openConnectedPair(smoke);
        await settleUnderFakeTimers(async () => {
            for (const [sender, receiver] of [[connectedA, connectedB], [connectedB, connectedA]] as const) {
                await smoke.deliver({
                    sender,
                    receiver,
                    commandId: `send-${sender.agent.agentId}`,
                    smokeId: sender.agent.agentId,
                    direction: sender.agent.agentId,
                    topic: 'topic',
                    timeoutMs: TWO_AGENT_SEND_TIMEOUT_MS,
                    visibleInbox: false
                });
            }
        });
        const health = { phase: 'counted', connected: true, readyPeerId: undefined, reconnectSuppressed: false };

        expect(await measureBoundedWaitsMs(() => smoke.expectHealth(connectedB, health))).toBe(
            TWO_AGENT_RESULT_POLL_TIMEOUT_MS
        );
        expect(await measureBoundedWaitsMs(() => smoke.reloadAgent(agentB))).toBe(
            TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.reload
        );
        expect(await measureBoundedWaitsMs(() => smoke.disconnectAgent(agentB))).toBe(
            TWO_AGENT_RESULT_POLL_TIMEOUT_MS + TWO_AGENT_DISCONNECT_SETTLE_MS
        );
        expect(
            await measureBoundedWaitsMs(async () => {
                await Promise.all([smoke.finalizeAgent(agentA), smoke.finalizeAgent(agentB)]);
                await smoke.expectEvidence('delivery');
            })
        ).toBe(TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.finalization + TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS);
    });
});
