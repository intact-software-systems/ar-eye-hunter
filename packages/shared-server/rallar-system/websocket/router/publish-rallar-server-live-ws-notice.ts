import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs, type ALQosEffectivePolicy } from '@shared/al-contracts/al-policy.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    encodeLiveWsNotice,
    type LiveWsAudience,
    type LiveWsInboundReference,
    type LiveWsNotice,
    type LiveWsPublicationInput
} from '../../queue-pubsub/live-ws-notice.ts';
import {
    isRoomSnapshotPublication,
    partitionRoomSnapshotPublication
} from '../../queue-pubsub/partition-room-snapshot-publication.ts';
import type { PublishRallarServerWsMessageInput } from './publish-rallar-server-ws-message.ts';
import type { RallarServerWsPublishResult } from './rallar-server-ws-router-contracts.ts';
import { readLiveWsPublicationAudience, resolveLiveWsPublicationScope } from './read-live-ws-publication-audience.ts';

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
    const encoded = toEncodedLiveWsNotices(notice);
    if (encoded.left !== undefined) {
        return failedLivePublication(input, encoded.left);
    }
    for (const part of encoded.right!) {
        await publication.transport.publish(part);
    }
    const localFailureReason = sendLocalPublishedLiveWsNotice(input, notice);
    return {
        fanout: input.fanout,
        status: 'cluster-published',
        message: input.message,
        entries: [],
        ...(localFailureReason === undefined ? {} : { reason: localFailureReason })
    };
}

/** Every part encodes before any is published, so an oversized part never leaves a partial publication. */
function toEncodedLiveWsNotices(notice: LiveWsPublicationInput): Either<string, readonly LiveWsNotice[]> {
    const parts: Either<string, readonly LiveWsPublicationInput[]> = isRoomSnapshotPublication(notice)
        ? partitionRoomSnapshotPublication(notice)
        : Either.ofRight([notice]);
    if (parts.left !== undefined) {
        return Either.ofLeft(parts.left);
    }
    const encoded: LiveWsNotice[] = [];
    for (const part of parts.right!) {
        const result = encodeLiveWsNotice(part);
        if (result.kind === 'oversize') {
            return Either.ofLeft(`Live WS notice is oversized (${result.inlineBytes} bytes).`);
        }
        encoded.push(result.notice);
    }
    return Either.ofRight(encoded);
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
            sentPositions: null,
            expiresAtMs: notice.expiresAtMs,
            recipientSessionIds: notice.audience.mode === 'broad' ? undefined : notice.audience.recipientSessionIds,
            inboundScope: notice.scope,
            recipientScope: notice.scope,
            recipientPrincipalId: notice.audience.mode === 'principal'
                ? notice.audience.principalRef.principalId
                : undefined,
            roomSessionGenerations: notice.audience.mode === 'generation-room'
                ? notice.audience.generations
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

function failedLivePublication(input: PublishRallarServerWsMessageInput, reason: string): RallarServerWsPublishResult {
    if (input.origin) {
        console.error(
            `Rallar server WS ${input.origin} publication failed for ` +
                `${input.message.route.topicId} (${input.message.id.msgId}): ${reason}`
        );
    }
    return { fanout: input.fanout, status: 'failed', message: input.message, entries: [], reason };
}
