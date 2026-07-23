import {
    newALEventRoute,
    newALUntargetedMessage,
} from '@shared/al-contracts/al-contract.ts';
import {
    RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
    RALLAR_CRDT_APP_TOPIC_ID,
    RALLAR_CRDT_PROTOCOL_VERSION,
    RALLAR_CRDT_UPDATE_TYPE_ID,
    type RallarCrdtAppendResponseEnvelope,
    type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type {
    RallarServerWsMessage,
    RallarServerWsMessageContext,
} from '../rallar-facade/ws-topic-router.ts';
import type {
    RallarCrdtServerTopicBridgeOptions,
    RallarCrdtServerTrustedMetadata,
} from './RallarCrdtServer.ts';

/**
 * Compatibility-only adapter for embedders that have not supplied AppInbox ingress.
 * api-v1 always supplies mutationIngress and never reaches this path.
 */
export async function appendLegacyRallarCrdtWsUpdate(
    message: RallarServerWsMessage<RallarCrdtUpdateEnvelope>,
    context: RallarServerWsMessageContext<unknown>,
    options: RallarCrdtServerTopicBridgeOptions,
    trusted: RallarCrdtServerTrustedMetadata,
): Promise<void> {
    const result = await options.logRepository?.append({
        update: message.payload,
        trusted: {
            actorId: trusted.senderId,
            principalId: trusted.principalId,
            sessionId: trusted.sessionId,
            serverId: context.service.name,
            authorizationScope: message.payload.document.scope as never,
        },
    });
    if (!result) return;
    const response: RallarCrdtAppendResponseEnvelope = {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        requestId: message.payload.updateId,
        document: message.payload.document,
        acceptedAtEpochMs: result.status === 'rejected'
            ? Date.now()
            : result.append.acceptedAtEpochMs,
        results: [result],
    };
    await context.proxy.toPeer(
        context.senderId,
        newALUntargetedMessage(
            context.service.name,
            newALEventRoute(
                message.raw.route.topicId,
                message.raw.route.contextId,
                message.payload.updateId,
            ),
            RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
            response,
        ),
        'live-only',
    );
    if (result.status !== 'accepted') return;
    if (message.payload.document.scope === 'principal') {
        await fanOutPrincipalUpdate(message, context, options, trusted);
        return;
    }
    await context.proxy.toTargets(message.raw, options.fanout ?? 'live-only');
}

async function fanOutPrincipalUpdate(
    message: RallarServerWsMessage<RallarCrdtUpdateEnvelope>,
    context: RallarServerWsMessageContext<unknown>,
    options: RallarCrdtServerTopicBridgeOptions,
    trusted: RallarCrdtServerTrustedMetadata,
): Promise<void> {
    const document = message.payload.document;
    const sessionIds = await Promise.resolve(
        options.resolvePrincipalSessionIds?.({
            document,
            update: message.payload,
            trusted,
            raw: message.raw,
        }) ?? [],
    );
    const targetMessage = newALUntargetedMessage(
        context.service.name,
        newALEventRoute(
            RALLAR_CRDT_APP_TOPIC_ID,
            document.principalId ?? document.documentId,
            message.payload.updateId,
        ),
        RALLAR_CRDT_UPDATE_TYPE_ID,
        message.payload,
    );
    for (const sessionId of sessionIds) {
        if (sessionId !== context.senderId) {
            await context.proxy.toPeer(sessionId, targetMessage, options.fanout ?? 'live-only');
        }
    }
}
