import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    waitForWsMessage,
    waitForWsMessageAbsence,
    waitForWsMessageCount,
    waitForWsMessages,
    type WsInteractionResponse,
    type WsWaitContext
} from '../../shared-test/black-box-runner/ws/ws-wait-expectations.ts';

const connection = 'wsAlice';

function toContext(payloads: readonly ApiJsonValue[]): WsWaitContext {
    return { dependencies: { now: Date.now, createUuid: () => crypto.randomUUID() }, wsMessages: { [connection]: payloads.map((data) => ({ data })) } };
}

function toFrame(eventType: string): ApiJsonValue {
    return {
        route: { topicId: 'group-state.event' },
        payload: {
            typeId: 'group-state.delta.v1',
            resource: JSON.stringify({ event: { eventType }, revision: 3 })
        }
    };
}

async function runWait(expectFields: WsInteractionResponse, payloads: readonly ApiJsonValue[]) {
    const interaction = {
        request: { action: 'wait', connection, scenarioExecutionNumber: 1, interactionExecutionNumber: 1 },
        response: { connection, withinMs: 40, ...expectFields }
    };
    return await waitForWsMessage({
        interaction,
        config: { interactionName: 'waitForEvent', interaction },
        context: toContext(payloads)
    });
}

const membersChanged = toFrame('group-members-changed');
const activation = toFrame('group-activation-status-changed');

describe('ws wait with expect.decodeJsonPaths', () => {
    it('uses the decoded shape for ordered, count and absence waits while retaining wire evidence', async () => {
        const expected = { payload: { resource: { event: { eventType: 'group-activation-status-changed' } } } };
        const interaction = {
            request: { connection },
            response: {
                messages: [expected],
                message: expected,
                absent: expected,
                count: 1,
                decodeJsonPaths: ['payload.resource'],
                ordered: true,
                withinMs: 40
            }
        };
        const input = { interaction, config: { interaction }, context: toContext([membersChanged, activation]) };
        const [ordered, count, absence] = await Promise.all([
            waitForWsMessages(input),
            waitForWsMessageCount(input),
            waitForWsMessageAbsence(input)
        ]);
        expect(ordered).toMatchObject({ status: 'SUCCESS', actual: { matchedMessages: [{ matchedMessage: { data: activation } }] } });
        expect(count).toMatchObject({ status: 'SUCCESS', actual: { matchedCount: 1 } });
        expect(absence).toMatchObject({ status: 'FAILURE', actual: { matchedMessage: { data: activation } } });
        expect(input.context.wsMessages[connection]?.[1]).toEqual({ data: activation });
    });

    // Without the decode, eventType is unreachable: it lives inside a JSON
    // string and the comparator has no decode step.
    it('cannot select on eventType without the declaration', async () => {
        const result = await runWait(
            { message: { payload: { resource: { event: { eventType: 'group-activation-status-changed' } } } } },
            [membersChanged, activation]
        );

        expect(result.status).toBe('FAILURE');
    });

    it('selects the frame carrying the named eventType', async () => {
        const result = await runWait(
            {
                decodeJsonPaths: ['payload.resource'],
                message: { payload: { resource: { event: { eventType: 'group-activation-status-changed' } } } }
            },
            [membersChanged, activation]
        );

        expect(result.status).toBe('SUCCESS');
    });

    // The earliest-match rule is what makes this worth having: the wanted frame
    // is second, behind one that matches everything the outer frame can express.
    it('skips an earlier frame on the same topic that carries a different event', async () => {
        const result = await runWait(
            {
                decodeJsonPaths: ['payload.resource'],
                message: { payload: { resource: { event: { eventType: 'group-activation-status-changed' } } } }
            },
            [membersChanged, membersChanged, activation]
        );

        expect(result.status).toBe('SUCCESS');
        expect(result.actual.matchedMessage).toEqual({ data: activation });
    });

    it('still fails when no frame carries the named eventType', async () => {
        const result = await runWait(
            {
                decodeJsonPaths: ['payload.resource'],
                message: { payload: { resource: { event: { eventType: 'group-activation-status-changed' } } } }
            },
            [membersChanged, membersChanged]
        );

        expect(result.status).toBe('FAILURE');
    });

    it('reports the matched frame in its original wire form', async () => {
        const result = await runWait(
            { decodeJsonPaths: ['payload.resource'], message: { route: { topicId: 'group-state.event' } } },
            [activation]
        );

        expect(result.actual.matchedMessage).toEqual({ data: activation });
    });
});
