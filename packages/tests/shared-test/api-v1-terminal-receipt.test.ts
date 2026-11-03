import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createDefaultExecutionDependencies } from '@shared-test/black-box-runner/execution/black-box-scenario-context.ts';
import { waitForWsMessage, type WsInteractionResponse } from '@shared-test/black-box-runner/ws/ws-wait-expectations.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const MESSAGE_ID = 'live-only-cluster-broadcast-{runId}';

it('ignores admitted and unrelated completed receipts before selecting its own completion', async () => {
    const complete = toReceipt('complete', MESSAGE_ID);
    const result = await runTerminalWait([toReceipt('admitted', MESSAGE_ID), toReceipt('complete', 'unrelated'), complete]);
    expect(result).toMatchObject({ status: 'SUCCESS', actual: { matchedMessage: { data: complete } } });
});

it.each(['admitted', 'unrelated'])('fails when only %s evidence exists and completion never arrives', async (evidence) => {
    const frames = evidence === 'admitted' ? [toReceipt('admitted', MESSAGE_ID)] : [toReceipt('complete', 'unrelated')];
    expect(await runTerminalWait(frames)).toMatchObject({ status: 'FAILURE' });
});

async function runTerminalWait(frames: readonly ApiJsonValue[]) {
    const recipe = readApiV1Recipe('tests/api-v1/api-v1-websocket-live-only-cluster.json');
    const step = recipe.steps?.find((candidate) => candidate.name === 'aliceReceivesTheTerminalReceipt');
    if (!step || step.type !== 'ws.wait' || !step.expect || typeof step.expect !== 'object') {
        throw new Error('The live-only recipe must have a terminal receipt wait.');
    }
    const response = step.expect as WsInteractionResponse;
    const interaction = { request: { connection: 'wsAlicePrimary' }, response };
    const pending = waitForWsMessage({
        interaction,
        config: { interaction },
        context: {
            dependencies: createDefaultExecutionDependencies(),
            wsMessages: { wsAlicePrimary: frames.map((data) => ({ data })) }
        }
    });
    await vi.advanceTimersByTimeAsync(Number(response.withinMs) + 25);
    return await pending;
}

function toReceipt(phase: 'admitted' | 'complete', msgId: string): ApiJsonValue {
    return {
        route: { topicId: 'al-control' },
        targets: { mode: 'unicast', toPeerId: '{aliceSessionId}' },
        payload: {
            typeId: 'al.control.receipt.v1',
            resource: JSON.stringify({ msgId, phase, expectedRecipientPeerIds: ['bob'], confirmedRecipientPeerIds: phase === 'complete' ? ['bob'] : [] })
        }
    };
}
