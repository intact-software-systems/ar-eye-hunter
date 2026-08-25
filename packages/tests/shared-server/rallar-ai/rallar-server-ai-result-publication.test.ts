import {
    createRallarServerAiResultPublisher,
    toRallarServerAiPublicationTarget,
    type RallarServerAiResultPublicationPort
} from '@shared-server/rallar-ai/rallar-server-ai-result-publication.ts';
import type { RallarServerWsFanout, RallarServerWsPublishResult } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { describe, expect, it } from 'vitest';
import { createRallarServerAiTestResult, RALLAR_SERVER_AI_TEST_ROOM_REF } from './rallar-server-ai-test-fixtures.ts';

describe('Rallar server AI result publication', () => {
    it('publishes room results with canonical workspace identity', async () => {
        const publication = createPublicationCapture();
        const publish = createRallarServerAiResultPublisher({
            publication: publication.port,
            serverSenderId: 'ai-server'
        });

        await publish({
            result: createRallarServerAiTestResult(),
            roomRef: RALLAR_SERVER_AI_TEST_ROOM_REF,
            fanout: 'outbox'
        });

        expect(publication.message?.targets).toEqual({
            mode: 'broadcast',
            scope: 'room',
            groupRef: RALLAR_SERVER_AI_TEST_ROOM_REF
        });
        expect(publication.message?.route).toMatchObject({
            topicId: 'room.ai.generated',
            contextId: 'room-1',
            resourceId: 'generation-1'
        });
        expect(publication.fanout).toBe('outbox');
    });

    it('keeps world publication intentionally unscoped', async () => {
        const publication = createPublicationCapture();
        const publish = createRallarServerAiResultPublisher({
            publication: publication.port,
            serverSenderId: 'ai-server'
        });

        await publish({
            result: createRallarServerAiTestResult(),
            scope: 'world'
        });

        expect(publication.message?.targets).toEqual({
            mode: 'broadcast',
            scope: 'world'
        });
        expect(publication.message?.route.contextId).toBe('world');
    });

    it('requires canonical workspace identity for room publication', () => {
        expect(() => toRallarServerAiPublicationTarget('room', undefined))
            .toThrow('complete GroupRef');
        expect(toRallarServerAiPublicationTarget('world', undefined))
            .toEqual({ scope: 'world' });
    });

    it('does not publish when authorization denies the result', async () => {
        const publication = createPublicationCapture();
        const publish = createRallarServerAiResultPublisher({
            publication: publication.port,
            serverSenderId: 'ai-server',
            authorize: () => false
        });

        await expect(publish({
            result: createRallarServerAiTestResult(),
            scope: 'world'
        })).rejects.toMatchObject({ code: 'unauthorized' });
        expect(publication.message).toBeUndefined();
    });
});

interface PublicationCapture {
    readonly port: RallarServerAiResultPublicationPort;
    readonly message: ALMessage | undefined;
    readonly fanout: RallarServerWsFanout | undefined;
}

function createPublicationCapture(): PublicationCapture {
    let publishedMessage: ALMessage | undefined;
    let publishedFanout: RallarServerWsFanout | undefined;
    const port: RallarServerAiResultPublicationPort = {
        publish: async (message, fanout) => {
            publishedMessage = message;
            publishedFanout = fanout;
            return successfulPublication(message, fanout);
        }
    };
    return {
        port,
        get message() {
            return publishedMessage;
        },
        get fanout() {
            return publishedFanout;
        }
    };
}

function successfulPublication(
    message: ALMessage,
    fanout: RallarServerWsFanout | undefined
): RallarServerWsPublishResult {
    return {
        fanout: fanout ?? 'live-only',
        status: 'sent-live',
        message,
        sentCount: 1,
        entries: []
    };
}
