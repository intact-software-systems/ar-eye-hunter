import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { computeCommandWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { FULL_STACK_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';
import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import {
    resolveDirectorCommandResultPollTimeoutMs,
    runDirectorOrchestration,
    type DirectorOrchestration
} from '../../../tests/playwright/rallar-black-box/director-orchestration-operations.ts';
import { DIRECTOR_SCENARIO_BOUNDED_WAITS_MS } from '../../../tests/playwright/rallar-black-box/director-orchestration-test-timeouts.ts';
import {
    DIRECTOR_AGENT_PREFIXES,
    DIRECTOR_EVENT_POLL_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/director-orchestration-waits.ts';
import { createCountedPage, measureBoundedWaitsMs, spendBoundedWait } from './bounded-wait-clock-fixture.ts';

vi.mock('@playwright/test', async (importOriginal) => {
    const { toCountedPlaywrightModule } = await import('./bounded-wait-clock-fixture.ts');
    return toCountedPlaywrightModule(await importOriginal(), FULL_STACK_EXPECT_TIMEOUT_MS);
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
    vi.useRealTimers();
});

/** The session each agent connects with, named after its agent. */
function toSessionId(agentId: string): string {
    return `session-${agentId}`;
}

/** A's appointment, as every agent's status reports it; a client's turns stale once A's relay stops. */
function toDirectorStatus(input: DirectorOrchestration.CommandInput): ApiJsonObject {
    const appointment = { sessionId: toSessionId('A'), epoch: 1 };
    if (input.command.kind === 'director.appoint' || input.agentId === 'A') {
        return { role: 'director', state: 'fresh', isDirector: true, appointment };
    }
    return {
        role: 'client',
        state: input.commandId.endsWith('-stale') ? 'stale' : 'fresh',
        isDirector: false,
        appointment
    };
}

/** The value each command's result carries, enough for the scenario's own checks of it. */
function toResultValue(input: DirectorOrchestration.CommandInput): ApiJsonObject {
    switch (input.command.kind) {
        case 'rtc.connect':
            return { sessionId: toSessionId(input.agentId) };
        case 'health':
            return { rallar: { rtcStatus: { readyPeerIds: DIRECTOR_AGENT_PREFIXES.map(toSessionId) } } };
        case 'director.appoint':
        case 'director.status':
            return { directorStatus: toDirectorStatus(input) };
        case 'director.intent':
        case 'director.sync.request':
            return { sendResult: { status: 'sent', receipt: { msgId: input.commandId } } };
        default:
            return {};
    }
}

/** A control run that answers every command after its result wait and reports every awaited event. */
const recordingControl: DirectorOrchestration.Control = {
    executeResult: async (input) => {
        await spendBoundedWait(computeCommandWaitMs(resolveDirectorCommandResultPollTimeoutMs(input)));
        return {
            agentId: input.agentId,
            commandId: input.commandId,
            ok: true,
            result: { value: toResultValue(input) }
        } as ControlResultEnvelope;
    },
    waitForEvent: async () => await spendBoundedWait(DIRECTOR_EVENT_POLL_TIMEOUT_MS)
};

describe('the director scenario waits what its derivation counts', () => {
    it('runs the membership, connects, appointment, relays, intents, syncs and staleness within their bounded waits', async () => {
        const [a, b, c] = DIRECTOR_AGENT_PREFIXES.map((prefix) => ({
            page: createCountedPage(),
            prefix,
            agentId: prefix,
            actor: `actor-${prefix}`,
            connection: `connection-${prefix}`
        }));

        expect(
            await measureBoundedWaitsMs(() =>
                runDirectorOrchestration({
                    control: recordingControl,
                    room: { apiBaseUrl: 'http://localhost:18080', applicationId: 'app', workspaceId: 'work', groupId: 'room' },
                    agents: [a, b, c],
                    topicId: 'topic',
                    intentIds: { B: 'intent-b', C: 'intent-c' }
                })
            )
        ).toBe(DIRECTOR_SCENARIO_BOUNDED_WAITS_MS);
    });
});
