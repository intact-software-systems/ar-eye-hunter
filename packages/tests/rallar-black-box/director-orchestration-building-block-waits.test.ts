import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { FULL_STACK_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';
import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import {
    createDirectorControl,
    runDirectorOrchestration,
    type DirectorOrchestration
} from '../../../tests/playwright/rallar-black-box/director-orchestration-operations.ts';
import { DIRECTOR_SCENARIO_BOUNDED_WAITS_MS } from '../../../tests/playwright/rallar-black-box/director-orchestration-test-timeouts.ts';
import { DIRECTOR_AGENT_PREFIXES } from '../../../tests/playwright/rallar-black-box/director-orchestration-waits.ts';
import {
    createCountedControlRequest,
    createCountedPage,
    measureBoundedWaitsMs,
    settleUnderFakeTimers,
    useBoundedWaitClock,
    type PostedControlCommand
} from './bounded-wait-clock-fixture.ts';

vi.mock('@playwright/test', async (importOriginal) => {
    const { toCountedPlaywrightModule } = await import('./bounded-wait-clock-fixture.ts');
    return toCountedPlaywrightModule(await importOriginal(), FULL_STACK_EXPECT_TIMEOUT_MS);
});

useBoundedWaitClock();

const RUN_ID = 'director-run';

/** The session each agent connects with, named after its agent. */
function toSessionId(agentId: string): string {
    return `session-${agentId}`;
}

/** A's appointment as every agent's status reports it, unless a case gives the status another. */
const APPOINTMENT: ApiJsonObject = { sessionId: toSessionId('A'), epoch: 1 };

/** A's appointment, as every agent's status reports it; a client's turns stale once A's relay stops. */
function toDirectorStatus(input: PostedControlCommand, appointment: ApiJsonObject): ApiJsonObject {
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
function toResultValue(input: PostedControlCommand, appointment: ApiJsonObject): ApiJsonObject {
    switch (input.command.kind) {
        case 'rtc.connect':
            return { sessionId: toSessionId(input.agentId) };
        case 'health':
            return { rallar: { rtcStatus: { readyPeerIds: DIRECTOR_AGENT_PREFIXES.map(toSessionId) } } };
        case 'director.appoint':
        case 'director.status':
            return { directorStatus: toDirectorStatus(input, appointment) };
        case 'director.intent':
        case 'director.sync.request':
            return { sendResult: { status: 'sent', receipt: { msgId: input.commandId } } };
        default:
            return {};
    }
}

/** Every director event the scenario awaits, each naming both intents, so every event poll reads it at once. */
function toDirectorEvents(): readonly ApiJsonObject[] {
    const topics = ['intent_received', 'output_received', 'snapshot_received'];
    return DIRECTOR_AGENT_PREFIXES.flatMap((agentId) =>
        topics.map((topic) => ({
            kind: 'event',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: RUN_ID,
            agentId,
            atEpochMs: 1,
            payload: { kind: 'event', topic: `rallar.browser.director.${topic}`, intentIds: ['intent-b', 'intent-c'] }
        }))
    );
}

/**
 * The control run once every posted command has answered, each status reporting `appointment`, with every director
 * event the scenario awaits.
 */
function toDirectorRun(posted: readonly PostedControlCommand[], appointment = APPOINTMENT): ApiJsonObject {
    return {
        runId: RUN_ID,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        agents: [],
        commands: [],
        results: posted.map((command) => ({
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: RUN_ID,
            agentId: command.agentId,
            commandId: command.commandId,
            ok: true,
            result: {
                commandId: command.commandId,
                kind: command.command.kind,
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1,
                endedAtEpochMs: 1,
                durationMs: 0,
                value: toResultValue(command, appointment)
            }
        })),
        events: toDirectorEvents(),
        stats: [],
        reports: [],
        heartbeats: []
    };
}

describe('the director scenario waits what its derivation counts', () => {
    // The counted control spent the waits itself, so the real control's enqueue and result and event polls ran
    // nowhere: a changed bound there failed nothing.
    it('runs the membership, connects, appointment, relays, intents, syncs and staleness within their bounded waits', async () => {
        expect(await measureBoundedWaitsMs(() => runDirectorOrchestration(toScenarioInput(APPOINTMENT))))
            .toBe(DIRECTOR_SCENARIO_BOUNDED_WAITS_MS);
    });
});

describe('the director scenario\'s status reading', () => {
    // A reading without a numeric epoch decoded to an undefined epoch, so two such readings matched where comparing the
    // raw field had failed.
    it.each<Readonly<{ case: string; appointment: ApiJsonObject; }>>([
        { case: 'no epoch', appointment: { sessionId: toSessionId('A') } },
        { case: 'a text epoch', appointment: { sessionId: toSessionId('A'), epoch: '1' } }
    ])('refuses an appointment with $case', async ({ appointment }) => {
        const outcome = settleUnderFakeTimers(() => runDirectorOrchestration(toScenarioInput(appointment)));

        await expect(outcome).rejects.toThrow('epoch must be a number');
    });
});

/** The scenario's three agents on counted pages, driven through the real control whose statuses report `appointment`. */
function toScenarioInput(appointment: ApiJsonObject): DirectorOrchestration.Input {
    const [a, b, c] = DIRECTOR_AGENT_PREFIXES.map((prefix) => ({
        page: createCountedPage(),
        prefix,
        agentId: prefix,
        actor: `actor-${prefix}`,
        connection: `connection-${prefix}`
    }));
    return {
        control: createDirectorControl(
            createCountedControlRequest((posted) => toDirectorRun(posted, appointment)),
            RUN_ID
        ),
        room: { apiBaseUrl: 'http://localhost:18080', applicationId: 'app', workspaceId: 'work', groupId: 'room' },
        agents: [a, b, c],
        topicId: 'topic',
        intentIds: { B: 'intent-b', C: 'intent-c' }
    };
}
