import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs, type ALQosEffectivePolicy } from '@shared/al-contracts/al-policy.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
    encodeLiveWsNotice,
    type LiveWsAudience,
    type LiveWsPublicationInput
} from '../../queue-pubsub/live-ws-notice.ts';
import type { PublishRallarServerWsMessageInput } from './publish-rallar-server-ws-message.ts';
import { resolveAuthorizedRoomSessionIds } from './rallar-server-ws-publication-audience.ts';
import type { RallarServerWsPublishResult } from './rallar-server-ws-router-contracts.ts';

export async function publishRallarServerLiveWsNotice(
    input: PublishRallarServerWsMessageInput,
    effective: ALQosEffectivePolicy
): Promise<RallarServerWsPublishResult> {
    const publication = input.livePublication;
    if (!publication) {
        return failedLivePublication(input, 'The live WS publication has no authorized audience.');
    }
    try {
        const audience = await readLiveWsPublicationAudience(input);
        if (!audience) {
            return failedLivePublication(input, 'The live WS publication has no authorized audience.');
        }
        const expiresAtMs = resolveALMessageExpireAtMs(input.message, effective) ?? Number.MAX_SAFE_INTEGER;
        if (expiresAtMs <= input.nowEpochMs) {
            return { fanout: input.fanout, status: 'expired', message: input.message, entries: [] };
        }
        const common = {
            channel: publication.channel,
            publisherId: publication.publisherId,
            expiresAtMs,
            message: input.message,
            ...(input.inbound === undefined ? {} : { inbound: input.inbound })
        };
        let scope: StateScope | undefined;
        let noticeInput: LiveWsPublicationInput;
        if (audience.mode === 'broad') {
            noticeInput = { ...common, audience };
        }
        else {
            scope = readLiveWsPublicationScope(input.message, input.inboundScope);
            noticeInput = { ...common, audience, scope };
        }
        const encoded = encodeLiveWsNotice(noticeInput);
        if (encoded.kind === 'oversize') {
            return failedLivePublication(input, `Live WS notice is oversized (${encoded.inlineBytes} bytes).`);
        }
        await publication.transport.publish(encoded.notice);
        try {
            input.service.sendToTargetsWithResult({
                message: input.message,
                recipientSessionIds: audience.mode === 'broad' ? undefined : audience.recipientSessionIds,
                inboundScope: scope,
                recipientScope: scope,
                recipientPrincipalId: audience.mode === 'principal' ? audience.principalRef.principalId : undefined,
                requireAuthenticatedRecipient: true
            });
        }
        catch (error) {
            return {
                fanout: input.fanout,
                status: 'cluster-published',
                message: input.message,
                entries: [],
                reason: `Local WS send failed after publication: ${
                    error instanceof Error ? error.message : String(error)
                }`
            };
        }
    }
    catch (error) {
        return failedLivePublication(input, error instanceof Error ? error.message : String(error));
    }
    return { fanout: input.fanout, status: 'cluster-published', message: input.message, entries: [] };
}

async function readLiveWsPublicationAudience(
    input: PublishRallarServerWsMessageInput
): Promise<LiveWsAudience | undefined> {
    const targets = input.message.targets;
    if (!targets) {
        return undefined;
    }
    if (targets.mode === 'unicast') {
        return { mode: 'peer', recipientSessionIds: [targets.toPeerId] };
    }
    if (targets.mode === 'multicast' || targets.scope === 'room') {
        if (!input.audience || !targets.groupRef) {
            return undefined;
        }
        return {
            mode: 'room',
            groupRef: targets.groupRef,
            recipientSessionIds: resolveAuthorizedRoomSessionIds({
                message: input.message,
                audience: input.audience,
                admittedPeerIds: input.admittedPeerIds,
                nowEpochMs: input.nowEpochMs
            })
        };
    }
    if (targets.scope === 'principal') {
        if (!targets.principalRef || !input.livePublication?.readPrincipalSessionIds) {
            return undefined;
        }
        const sessions = await input.livePublication.readPrincipalSessionIds(targets.principalRef);
        if (!sessions) {
            return undefined;
        }
        return {
            mode: 'principal',
            principalRef: targets.principalRef,
            recipientSessionIds: sessions.filter((id) =>
                !targets.exceptPeerIds?.includes(id) &&
                (targets.recipientPeerIds === undefined || targets.recipientPeerIds.includes(id))
            )
        };
    }
    return { mode: 'broad', targetMode: targets.scope };
}

function readLiveWsPublicationScope(message: ALMessage, inboundScope: StateScope | null | undefined): StateScope {
    const targets = message.targets;
    if (targets?.mode === 'multicast' || (targets?.mode === 'broadcast' && targets.scope === 'room')) {
        if (!targets.groupRef) {
            throw new TypeError('Room live WS publication requires a full group reference.');
        }
        return { applicationId: targets.groupRef.applicationId, workspaceId: targets.groupRef.workspaceId };
    }
    if (targets?.mode === 'broadcast' && targets.scope === 'principal' && targets.principalRef) {
        return { applicationId: targets.principalRef.applicationId, workspaceId: targets.principalRef.workspaceId };
    }
    if (targets?.mode === 'unicast' && inboundScope) {
        return inboundScope;
    }
    throw new TypeError('Scoped live WS publication has no full recipient scope.');
}

function failedLivePublication(input: PublishRallarServerWsMessageInput, reason: string): RallarServerWsPublishResult {
    return { fanout: input.fanout, status: 'failed', message: input.message, entries: [], reason };
}
