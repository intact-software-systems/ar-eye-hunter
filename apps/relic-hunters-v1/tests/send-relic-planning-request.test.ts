import {
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicPlanningAiSuggestion
} from '@ar-eye-hunter/relic-hunters/mod.ts';
import type {
    RallarMessage,
    RallarMessageHandle,
    RallarMessageReplyOutcome,
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel
} from '@ar-eye-hunter/shared-web/browser/rallar.ts';
import { createInitialALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { createRallarAiJsonResult, createRallarAiMockProvider } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';
import { RELIC_PLANNING_AI_CONTEXT_FIXTURE } from '../../../packages/tests/relic-hunters/relic-planning-ai-context-fixture.ts';
import { createRelicPlanningAiRequest } from '../src/game/ai/relic-planning-ai.ts';
import {
    RELIC_PLANNING_REPLY_TIMEOUT_MS,
    sendRelicPlanningRequest
} from '../src/game/ai/send-relic-planning-request.ts';

const REVISION = 'relic-planning-ai-v1|room-1|r1';
const REQUEST = createRelicPlanningAiRequest({
    context: RELIC_PLANNING_AI_CONTEXT_FIXTURE,
    baseStateRevision: REVISION,
    dedupeKey: 'relic-planning-ai:room-1:1:alice'
});
const SERVER_SUGGESTION: RelicPlanningAiSuggestion = {
    headline: 'Scout the Hallway first',
    action: { kind: 'move', targetRoomId: 'hallway' },
    rationale: 'Hallway keeps a legal route open.',
    risks: [],
    confidence: 'medium'
};
const LIFECYCLE = createInitialALDeliveryLifecycle({
    msgId: 'planning-request-1',
    typeId: RELIC_TYPES.aiPlanningRequest,
    ackMode: 'receiver',
    receiptAlgo: 'receiver',
    expiresAtMs: undefined,
    submittedAtMs: 0
});

type PlanningFacade = Parameters<typeof sendRelicPlanningRequest>[0];

describe('a Relic planning request to the server (D444)', () => {
    it('asks the server peer on the planning command channel and returns its validated suggestion', async () => {
        const { facade, roomDefinitions, sendWs, awaitReply } = createFacadeDouble('default-qbox-server', replied(serverResult()));
        const abort = new AbortController();

        const outcome = await sendRelicPlanningRequest(facade, input({ signal: abort.signal }));

        expect(roomDefinitions).toEqual([{
            topicId: RELIC_TOPICS.aiPlanning,
            typeId: RELIC_TYPES.aiPlanningRequest,
            purpose: 'command',
            roomId: 'room-1'
        }]);
        expect(sendWs).toHaveBeenCalledWith(REQUEST, { peerId: 'default-qbox-server' });
        expect(awaitReply).toHaveBeenCalledWith({ timeoutMs: RELIC_PLANNING_REPLY_TIMEOUT_MS, signal: abort.signal });
        expect(outcome.right).toMatchObject({ requestId: REQUEST.requestId, baseStateRevision: REVISION, value: SERVER_SUGGESTION });
    });

    it('asks nothing before the server id is known, so the local companion answers', async () => {
        const { facade, roomDefinitions } = createFacadeDouble(undefined, replied(serverResult()));

        expect((await sendRelicPlanningRequest(facade, input())).left).toBe('no-server');
        expect(roomDefinitions).toEqual([]);
    });

    it.each(['timeout', 'aborted', 'undelivered'] as const)('falls back when the reply wait ends %s', async (status) => {
        const { facade } = createFacadeDouble('default-qbox-server', { status, lifecycle: LIFECYCLE });

        expect((await sendRelicPlanningRequest(facade, input())).left).toBe(status);
    });

    it.each([
        { label: 'a reply to another request', result: { ...serverResult(), requestId: 'relic-planning:other' } },
        { label: 'a reply for another schema', result: { ...serverResult(), schemaId: 'relic-hunters.expedition-blueprint' } },
        { label: 'a reply for a turn that has moved on', result: { ...serverResult(), baseStateRevision: `${REVISION}|stale` } },
        {
            label: 'a reply suggesting an illegal move',
            result: serverResult({ ...SERVER_SUGGESTION, action: { kind: 'move', targetRoomId: 'vault' } })
        },
        { label: 'a reply that is no result', result: { headline: 'Scout the Hallway first' } }
    ])('refuses $label as an invalid reply', async ({ result }) => {
        const { facade } = createFacadeDouble('default-qbox-server', replied(result));

        expect((await sendRelicPlanningRequest(facade, input())).left).toBe('invalid-reply');
    });

    it('refuses a reply that arrives after the draft or turn changed', async () => {
        const { facade } = createFacadeDouble('default-qbox-server', replied(serverResult()));

        const outcome = await sendRelicPlanningRequest(facade, input({ currentBaseStateRevision: () => `${REVISION}|moved` }));

        expect(outcome.left).toBe('invalid-reply');
    });
});

function input(overrides: Partial<Parameters<typeof sendRelicPlanningRequest>[1]> = {}) {
    return {
        roomId: 'room-1',
        request: REQUEST,
        context: RELIC_PLANNING_AI_CONTEXT_FIXTURE,
        currentBaseStateRevision: () => REVISION,
        signal: new AbortController().signal,
        ...overrides
    };
}

function serverResult(value: object = SERVER_SUGGESTION): object {
    return createRallarAiJsonResult({
        request: REQUEST,
        provider: createRallarAiMockProvider({ providerId: 'relic-planning-deterministic' }),
        value,
        generationId: 'server-generation-1',
        createdAtEpochMs: 10
    });
}

function replied(payload: object): RallarMessageReplyOutcome<object> {
    return {
        status: 'replied',
        reply: { payload } as RallarMessage<object>,
        lifecycle: LIFECYCLE
    };
}

function createFacadeDouble(serverPeerId: string | undefined, outcome: RallarMessageReplyOutcome<object>) {
    const awaitReply = vi.fn(async () => outcome);
    const handle: RallarMessageHandle = {
        msgId: LIFECYCLE.msgId,
        typeId: LIFECYCLE.typeId,
        corrId: LIFECYCLE.msgId,
        replyToMsgId: undefined,
        rtcCapture: unusedByARequest,
        lifecycle: () => LIFECYCLE,
        onEvent: () => () => {},
        wait: unusedByARequest,
        awaitReply: awaitReply as RallarMessageHandle['awaitReply'],
        cancel: () => {}
    };
    const sendWs = vi.fn(async () => handle);
    const roomDefinitions: RallarRoomMessageChannelDefinition[] = [];
    function room<T>(definition: RallarRoomMessageChannelDefinition): RallarTypedMessageChannel<T> {
        roomDefinitions.push(definition);
        return { send: unusedByARequest, sendRtc: unusedByARequest, sendWs, onRtc: unusedByARequest, onWs: unusedByARequest };
    }
    const unusedLane = { send: unusedByARequest, onMessage: unusedByARequest };
    const facade: PlanningFacade = {
        serverPeerId: () => serverPeerId,
        messages: { rtc: unusedLane, ws: unusedLane, channel: unusedByARequest, room }
    };
    return { facade, roomDefinitions, sendWs, awaitReply };
}

function unusedByARequest(): never {
    throw new Error('A planning request sends on the room channel\'s sendWs alone.');
}
