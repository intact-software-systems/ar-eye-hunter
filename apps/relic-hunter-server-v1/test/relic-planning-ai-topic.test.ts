import {
    decodeRelicPlanningAiSuggestion,
    RELIC_PLANNING_AI_PROMPT,
    RELIC_PLANNING_AI_SCHEMA_ID,
    RELIC_PLANNING_AI_SCHEMA_VERSION,
    RELIC_PLANNING_AI_SUGGESTION_SCHEMA,
    RELIC_TOPICS,
    RELIC_TYPES,
    toRelicRoomGroupRef
} from '@relic-hunters/mod.ts';
import { decodeRallarServerAiJsonRequest } from '@shared-server/rallar-ai/decode-rallar-server-ai-json-request.ts';
import type {
    RallarServerAiWebSocketHandler,
    RallarServerAiWebSocketMessageContext,
    RallarServerAiWebSocketPort,
    RallarServerAiWebSocketTopicDefinition
} from '@shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts';
import type { JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { RallarServerWsPublishInputDto } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { newALRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { RELIC_PLANNING_AI_CONTEXT_FIXTURE } from '../../../packages/tests/relic-hunters/relic-planning-ai-context-fixture.ts';
import { installRelicPlanningAiTopic } from '../src/relic-planning-ai-topic.ts';

const SERVER_PEER_ID = 'default-qbox-server';
const ASKER_SESSION_ID = 'alice-session';
const REF = toRelicRoomGroupRef('room-1');
const MEMBER_CONTEXT: RallarServerAiWebSocketMessageContext = {
    senderId: ASKER_SESSION_ID,
    roomId: REF.groupId,
    roomRef: REF,
    authenticatedScope: undefined
};

/** The router as the planning topic meets it: a request is validated, then authorized, then handled. */
function createRouterDouble() {
    const state: {
        topic: RallarServerAiWebSocketTopicDefinition | null;
        handler: RallarServerAiWebSocketHandler | null;
    } = { topic: null, handler: null };
    const publications: RallarServerWsPublishInputDto[] = [];
    const requests: ALMessage[] = [];
    const port: RallarServerAiWebSocketPort = {
        defineTopic: (definition) => {
            state.topic = definition;
        },
        on: (_selector, handler) => {
            state.handler = handler;
            return () => true;
        },
        publish: (input) => {
            publications.push(input);
            return Promise.resolve({
                fanout: input.fanout ?? 'live-only',
                status: 'queued-outbox',
                message: input.message,
                entries: []
            });
        }
    };
    async function route(requestJson: JsonWireObject, context: RallarServerAiWebSocketMessageContext): Promise<void> {
        if (state.topic === null || state.handler === null) {
            throw new Error('Expected the planning topic and its handler');
        }
        if (!state.topic.validate(requestJson)) {
            return;
        }
        const raw = newALUnicastMessage(
            context.senderId,
            newALRoute(RELIC_TOPICS.aiPlanning, context.roomId ?? 'world', 'planning-request-1'),
            SERVER_PEER_ID,
            RELIC_TYPES.aiPlanningRequest,
            requestJson,
            { groupRef: context.roomRef, reliability: 'at-least-once', ack: 'receiver' }
        );
        requests.push(raw);
        const message = { payload: decodeRallarServerAiJsonRequest(requestJson), raw };
        if (!await state.topic.authorize(message, context)) {
            return;
        }
        await state.handler(message, context);
    }
    return { state, publications, requests, port, route };
}

function planningRequest(overrides: Partial<JsonWireObject> = {}): JsonWireObject {
    return {
        requestId: 'relic-planning:room-1:r1:alice',
        schemaId: RELIC_PLANNING_AI_SCHEMA_ID,
        schemaVersion: RELIC_PLANNING_AI_SCHEMA_VERSION,
        schema: RELIC_PLANNING_AI_SUGGESTION_SCHEMA as JsonWireObject,
        prompt: RELIC_PLANNING_AI_PROMPT,
        context: JSON.parse(JSON.stringify(RELIC_PLANNING_AI_CONTEXT_FIXTURE)),
        baseStateRevision: 'relic-planning-ai-v1|room-1|r1',
        dedupeKey: 'relic-planning-ai:room-1:1:alice',
        ...overrides
    } as JsonWireObject;
}

describe('the Relic planning AI topic', () => {
    it('defines the planning request as a room command to the server', () => {
        const router = createRouterDouble();
        installRelicPlanningAiTopic({ websocket: router.port, serverSenderId: SERVER_PEER_ID });

        expect(router.state.topic).toMatchObject({
            topicId: RELIC_TOPICS.aiPlanning,
            typeId: RELIC_TYPES.aiPlanningRequest,
            scope: 'room',
            fanout: 'none',
            maxPayloadBytes: 32 * 1024
        });
    });

    it('answers a member\'s request once, to the asking session, with a legal suggestion for its turn', async () => {
        const router = createRouterDouble();
        installRelicPlanningAiTopic({ websocket: router.port, serverSenderId: SERVER_PEER_ID });

        await router.route(planningRequest(), MEMBER_CONTEXT);

        expect(router.publications).toHaveLength(1);
        const reply = router.publications[0]!;
        expect(reply.fanout).toBe('outbox');
        expect(reply.message.id.senderId).toBe(SERVER_PEER_ID);
        expect(reply.message.payload.typeId).toBe(RELIC_TYPES.aiPlanningReply);
        expect(reply.message.targets).toEqual({ mode: 'unicast', toPeerId: ASKER_SESSION_ID, groupRef: REF });
        const request = router.requests[0]!;
        expect(reply.message.actions).toEqual({ corrId: request.id.msgId, replyToMsgId: request.id.msgId });
        const result = JSON.parse(reply.message.payload.resource);
        expect(result).toMatchObject({
            requestId: 'relic-planning:room-1:r1:alice',
            schemaId: RELIC_PLANNING_AI_SCHEMA_ID,
            schemaVersion: RELIC_PLANNING_AI_SCHEMA_VERSION,
            baseStateRevision: 'relic-planning-ai-v1|room-1|r1',
            validation: { ok: true }
        });
        expect(decodeRelicPlanningAiSuggestion(result.value, RELIC_PLANNING_AI_CONTEXT_FIXTURE).right).toEqual(result.value);
    });

    it('answers no request for another schema', async () => {
        const router = createRouterDouble();
        installRelicPlanningAiTopic({ websocket: router.port, serverSenderId: SERVER_PEER_ID });

        await router.route(planningRequest({ schemaId: 'relic-hunters.expedition-blueprint' }), MEMBER_CONTEXT);
        await router.route(planningRequest({ schemaVersion: '2' }), MEMBER_CONTEXT);

        expect(router.publications).toEqual([]);
    });

    it('answers no request outside a room', async () => {
        const router = createRouterDouble();
        installRelicPlanningAiTopic({ websocket: router.port, serverSenderId: SERVER_PEER_ID });

        await router.route(planningRequest(), { ...MEMBER_CONTEXT, roomId: undefined, roomRef: undefined });

        expect(router.publications).toEqual([]);
    });

    it('answers no request whose room belongs to another application or workspace', async () => {
        const router = createRouterDouble();
        installRelicPlanningAiTopic({ websocket: router.port, serverSenderId: SERVER_PEER_ID });

        await router.route(planningRequest(), { ...MEMBER_CONTEXT, roomRef: { ...REF, workspaceId: 'other-workspace' } });

        expect(router.publications).toEqual([]);
    });

    it('refuses a context it cannot decode and answers nothing', async () => {
        const router = createRouterDouble();
        installRelicPlanningAiTopic({ websocket: router.port, serverSenderId: SERVER_PEER_ID });

        await expect(router.route(planningRequest({ context: { schema: 'relic-planning-ai-context-v1' } }), MEMBER_CONTEXT))
            .rejects.toThrow('Relic planning context');

        expect(router.publications).toEqual([]);
    });
});
