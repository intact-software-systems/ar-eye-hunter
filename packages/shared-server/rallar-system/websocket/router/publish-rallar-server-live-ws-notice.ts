import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs, type ALQosEffectivePolicy } from '@shared/al-contracts/al-policy.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { resolveWsQueueBoxServerProvenScope } from '@shared/services/ws-queue-box-server/scope/resolve-ws-queue-box-server-recipient-scope.ts';
import { resolveLiveWsRoomGroupRef } from '../../queue-pubsub/live-ws-audience.ts';
import {
    encodeLiveWsNotice,
    type LiveWsAudience,
    type LiveWsInboundReference,
    type LiveWsPublicationInput
} from '../../queue-pubsub/live-ws-notice.ts';
import type { PublishRallarServerWsMessageInput } from './publish-rallar-server-ws-message.ts';
import { resolveAuthorizedRoomSessionIds } from './rallar-server-ws-publication-audience.ts';
import type { RallarServerWsPublishResult } from './rallar-server-ws-router-contracts.ts';

interface ToLiveWsPublicationInput {
    readonly message: ALMessage;
    readonly audience: LiveWsAudience;
    readonly channel: string;
    readonly publisherId: string;
    readonly expiresAtMs: number;
    readonly inbound: LiveWsInboundReference | undefined;
    readonly inboundScope: StateScope | null | undefined;
}

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
        const notice = toLiveWsPublicationInput({
            message: input.message,
            audience,
            channel: publication.channel,
            publisherId: publication.publisherId,
            expiresAtMs,
            inbound: input.inbound,
            inboundScope: input.inboundScope
        });
        return notice.left === undefined
            ? await writeLiveWsNotice(input, publication, notice.right!)
            : failedLivePublication(input, notice.left);
    }
    catch (error) {
        return failedLivePublication(input, error instanceof Error ? error.message : String(error));
    }
}

/** Publishes the notice to every process, then sends it to the recipients connected here. */
async function writeLiveWsNotice(
    input: PublishRallarServerWsMessageInput,
    publication: NonNullable<PublishRallarServerWsMessageInput['livePublication']>,
    notice: LiveWsPublicationInput
): Promise<RallarServerWsPublishResult> {
    const encoded = encodeLiveWsNotice(notice);
    if (encoded.kind === 'oversize') {
        return failedLivePublication(input, `Live WS notice is oversized (${encoded.inlineBytes} bytes).`);
    }
    await publication.transport.publish(encoded.notice);
    const localFailureReason = sendLocalPublishedLiveWsNotice(input, notice);
    return {
        fanout: input.fanout,
        status: 'cluster-published',
        message: input.message,
        entries: [],
        ...(localFailureReason === undefined ? {} : { reason: localFailureReason })
    };
}

function toLiveWsPublicationInput(input: ToLiveWsPublicationInput): Either<string, LiveWsPublicationInput> {
    const common = {
        channel: input.channel,
        publisherId: input.publisherId,
        expiresAtMs: input.expiresAtMs,
        message: input.message,
        ...(input.inbound === undefined ? {} : { inbound: input.inbound })
    };
    if (input.audience.mode === 'broad' && input.audience.targetMode === 'all') {
        return Either.ofRight({ ...common, audience: input.audience });
    }
    const scope = resolveLiveWsPublicationScope(input.message, input.audience, input.inboundScope);
    if (scope.left !== undefined) {
        return Either.ofLeft(scope.left);
    }
    return Either.ofRight({ ...common, audience: input.audience, scope: scope.right! });
}

function sendLocalPublishedLiveWsNotice(
    input: PublishRallarServerWsMessageInput,
    notice: LiveWsPublicationInput
): string | undefined {
    try {
        const result = input.service.sendToTargetsWithResult({
            message: input.message,
            expiresAtMs: notice.expiresAtMs,
            recipientSessionIds: notice.audience.mode === 'broad' ? undefined : notice.audience.recipientSessionIds,
            inboundScope: notice.scope,
            recipientScope: notice.scope,
            recipientPrincipalId: notice.audience.mode === 'principal'
                ? notice.audience.principalRef.principalId
                : undefined,
            requireAuthenticatedRecipient: true
        });
        return result.failedCount > 0
            ? `Local WS send failed after publication: ${result.failedCount}/${result.recipientCount} ` +
                `local recipients; first error: ${result.failures[0]?.reason ?? 'unknown failure'}`
            : undefined;
    }
    catch (error) {
        return `Local WS send failed after publication: ${error instanceof Error ? error.message : String(error)}`;
    }
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
    if (
        targets.mode === 'multicast' || targets.scope === 'room' ||
        (targets.scope === 'principal' && targets.groupRef !== undefined)
    ) {
        return readRoomLiveWsPublicationAudience(input);
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

/** A principal broadcast that names its room is a room audience, so it takes the room notice and its inbound key. */
function readRoomLiveWsPublicationAudience(input: PublishRallarServerWsMessageInput): LiveWsAudience | undefined {
    const groupRef = resolveLiveWsRoomGroupRef(input.message);
    if (!input.audience || !groupRef) {
        return undefined;
    }
    const recipientSessionIds = resolveAuthorizedRoomSessionIds({
        message: input.message,
        audience: input.audience,
        admittedPeerIds: input.admittedPeerIds,
        nowEpochMs: input.nowEpochMs
    });
    return { mode: 'room', groupRef, recipientSessionIds };
}

function resolveLiveWsPublicationScope(
    message: ALMessage,
    audience: LiveWsAudience,
    inboundScope: StateScope | null | undefined
): Either<string, StateScope> {
    if (audience.mode === 'room') {
        const { applicationId, workspaceId } = audience.groupRef;
        return Either.ofRight({ applicationId, workspaceId });
    }
    const targets = message.targets;
    if (targets?.mode === 'broadcast' && targets.scope === 'principal' && targets.principalRef) {
        const { applicationId, workspaceId } = targets.principalRef;
        return Either.ofRight({ applicationId, workspaceId });
    }
    const provenScope = resolveWsQueueBoxServerProvenScope(message, inboundScope);
    return provenScope
        ? Either.ofRight(provenScope)
        : Either.ofLeft('Scoped live WS publication has no full recipient scope.');
}

function failedLivePublication(input: PublishRallarServerWsMessageInput, reason: string): RallarServerWsPublishResult {
    if (input.origin) {
        console.error(
            `Rallar server WS ${input.origin} publication failed for ` +
                `${input.message.route.topicId} (${input.message.id.msgId}): ${reason}`
        );
    }
    return { fanout: input.fanout, status: 'failed', message: input.message, entries: [], reason };
}
