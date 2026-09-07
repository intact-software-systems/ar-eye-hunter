import { describe, expect, it } from 'vitest';

import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

interface WireFrame {
    readonly payload: { readonly resource: string; };
}

import { waitForWsMessage } from '../../shared-test/black-box-runner/ws/ws-wait-expectations.ts';

const connection = 'wsAlice';

function toContext(payloads: readonly ApiJsonValue[]): ApiJsonObject {
    return { wsMessages: { [connection]: payloads.map((data) => ({ data })) } };
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

async function runWait(expectFields: ApiJsonObject, payloads: readonly ApiJsonValue[]) {
    const interaction = {
        request: { action: 'wait', connection, scenarioExecutionNumber: 1, interactionExecutionNumber: 1 },
        response: { connection, withinMs: 40, ...expectFields }
    };
    const status = await waitForWsMessage(
        interaction,
        { interactionName: 'waitForEvent', interaction },
        toContext(payloads)
    );
    return { status: status.status, matched: status.actual?.matchedMessage?.data };
}

const membersChanged = toFrame('group-members-changed');
const activation = toFrame('group-activation-status-changed');

describe('ws wait with expect.decodeJsonPaths', () => {
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
        expect(JSON.parse((result.matched as never as WireFrame).payload.resource))
            .toMatchObject({ event: { eventType: 'group-activation-status-changed' } });
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

        expect(typeof (result.matched as never as WireFrame).payload.resource).toBe('string');
    });
});
