import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { hasALDeliveryDurableWork } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ResolvedRallarServerWsPublication } from './publish-rallar-server-ws-message.ts';
import { resolveAuthorizedRoomSessionIds } from './rallar-server-ws-publication-audience.ts';
import {
    toRallarServerWsLivePublishResult,
    toRallarServerWsOutboxPublishResult
} from './rallar-server-ws-publish-result.ts';
import type { RallarServerWsPublishResult } from './rallar-server-ws-router-contracts.ts';

export async function publishRallarServerWsFanout(
    input: ResolvedRallarServerWsPublication
): Promise<RallarServerWsPublishResult> {
    switch (input.fanout) {
        case 'none':
            return { fanout: 'none', status: 'none', message: input.message, sentCount: 0, entries: [] };
        case 'outbox': {
            const result = await input.service.enqueueOutboxIfAbsent(
                input.message,
                toAdmittedAudience(input),
                input.message.targets?.mode === 'unicast' ? input.inboundScope ?? undefined : undefined
            );
            if (hasALDeliveryDurableWork(result.verdict)) {
                input.wakeOutbox?.();
            }
            return toRallarServerWsOutboxPublishResult(input.message, input.fanout, result);
        }
        case 'live-only': {
            const groupRef = readALTargetGroupRef(input.message);
            const result = input.service.sendToTargetsWithResult({
                message: input.message,
                recipientSessionIds: input.audience === undefined ? undefined : resolveAuthorizedRoomSessionIds({
                    message: input.message,
                    audience: input.audience,
                    admittedPeerIds: input.admittedPeerIds,
                    nowEpochMs: input.nowEpochMs
                }),
                admittedPeerIds: input.admittedPeerIds,
                inboundScope: input.inboundScope,
                recipientScope: input.audience && groupRef
                    ? { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId }
                    : undefined
            });
            if (result.status === 'no-recipients') {
                console.warn(`Rallar server WS topic had no recipients: ${input.message.route.topicId}`);
            }
            return toRallarServerWsLivePublishResult(input.message, input.fanout, result);
        }
    }
}

/**
 * The sessions the live branch would address, handed to the outbox beside the message: the server's own
 * outbound owner sends to that audience and its pending row expects it, never the sessions that happen to
 * be connected to the instance that dequeues it (D24, D43). The wire message stays as the origin sent it,
 * so a room larger than the collection limit still fans out.
 */
function toAdmittedAudience(input: ResolvedRallarServerWsPublication): readonly string[] | undefined {
    const { message, audience, admittedPeerIds } = input;
    return audience === undefined
        ? undefined
        : resolveAuthorizedRoomSessionIds({ message, audience, admittedPeerIds, nowEpochMs: input.nowEpochMs });
}
