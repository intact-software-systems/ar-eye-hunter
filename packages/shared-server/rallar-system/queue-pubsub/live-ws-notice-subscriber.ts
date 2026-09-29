import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { filterLiveWsRoomRecipientSessionIds, matchesLiveWsAudience } from './live-ws-audience.ts';
import {
    decodeLiveWsNotice,
    type LiveWsAudience,
    type LiveWsNotice,
    type LiveWsNoticeTransport
} from './live-ws-notice.ts';

export interface InstallLiveWsNoticeSubscriberInput {
    readonly transport: LiveWsNoticeTransport;
    readonly channel: string;
    readonly publisherId: string;
    readonly nowMs: () => number;
    readonly inboundStores: readonly Pick<ALInboundAdmissionStore, 'namespace' | 'readDeliverySurface'>[];
    readonly resolveBroadRecipientSessionIds: (message: ALMessage) => readonly string[];
    readonly filterEligibleRecipientSessionIds: (
        recipientSessionIds: readonly string[],
        notice: LiveWsNotice
    ) => readonly string[];
    readonly sendToTargetsWithResult: (delivery: LiveWsNoticeSendInputDto) => void;
}

export interface LiveWsNoticeSendInputDto {
    readonly message: ALMessage;
    readonly recipientSessionIds: readonly string[];
    readonly notice: LiveWsNotice;
    readonly audience: LiveWsAudience;
}

interface LiveWsDelivery {
    readonly message: ALMessage;
    readonly audience: LiveWsAudience;
}

export function installLiveWsNoticeSubscriber(input: InstallLiveWsNoticeSubscriberInput): Promise<void> {
    return input.transport.subscribe(input.channel, async (notice) => {
        try {
            await receiveLiveWsNotice(notice, input);
        }
        catch (error) {
            console.error('Live WS notice receive failed:', error);
        }
    });
}

async function receiveLiveWsNotice(
    value: LiveWsNotice,
    input: InstallLiveWsNoticeSubscriberInput
): Promise<void> {
    const notice = decodeLiveWsNotice(value, input.channel, input.nowMs());
    if (!notice || notice.publisherId === input.publisherId) {
        return;
    }

    const delivery = notice.delivery === 'inline'
        ? { message: notice.message, audience: notice.audience }
        : await readCanonicalLiveWsDelivery(notice, input.inboundStores, input.nowMs());
    if (!delivery || notice.expiresAtMs <= input.nowMs()) {
        return;
    }

    const candidates = delivery.audience.mode === 'broad'
        ? input.resolveBroadRecipientSessionIds(delivery.message)
        : delivery.audience.recipientSessionIds;
    const eligible = input.filterEligibleRecipientSessionIds(candidates, notice);
    if (eligible.length === 0) {
        return;
    }
    input.sendToTargetsWithResult({
        message: delivery.message,
        recipientSessionIds: eligible,
        notice,
        audience: delivery.audience
    });
}

async function readCanonicalLiveWsDelivery(
    notice: Extract<LiveWsNotice, { delivery: 'inbound-key'; }>,
    stores: InstallLiveWsNoticeSubscriberInput['inboundStores'],
    nowMs: number
): Promise<LiveWsDelivery | undefined> {
    const store = stores.find((candidate) => candidate.namespace === notice.inbound.namespace);
    if (!store || notice.audienceMode === 'principal') {
        return undefined;
    }
    const surface = await store.readDeliverySurface(notice.inbound.reference, nowMs);
    if (!surface || surface.source.kind !== 'ws-client') {
        return undefined;
    }
    const message = surface.msg;
    const canonicalExpiresAtMs = resolveALMessageExpireAtMs(message);
    if (
        message.id.senderId !== notice.inbound.reference.senderId ||
        message.id.msgId !== notice.inbound.reference.msgId ||
        surface.source.peerId !== message.id.senderId ||
        (canonicalExpiresAtMs !== undefined && canonicalExpiresAtMs < notice.expiresAtMs)
    ) {
        return undefined;
    }
    const audience = toRecoveredAudience(message, notice, surface.source);
    return audience && matchesLiveWsAudience(message, audience) ? { message, audience } : undefined;
}

function toRecoveredAudience(
    message: ALMessage,
    notice: Extract<LiveWsNotice, { delivery: 'inbound-key'; }>,
    source: Extract<ALInboundMessageRuntime.Source, { kind: 'ws-client'; }>
): LiveWsAudience | undefined {
    const targets = message.targets;
    if (notice.audienceMode === 'peer') {
        if (
            message.route.topicId !== AppTopics.rtcSignaling ||
            message.payload.typeId !== AppTopics.rtcSignaling ||
            targets?.mode !== 'unicast' ||
            source.authenticatedScope?.applicationId !== notice.scope.applicationId ||
            source.authenticatedScope.workspaceId !== notice.scope.workspaceId
        ) {
            return undefined;
        }
        return { mode: 'peer', recipientSessionIds: [targets.toPeerId] };
    }
    if (notice.audienceMode === 'room') {
        if (
            !targets || (targets.mode !== 'multicast' && (targets.mode !== 'broadcast' || targets.scope !== 'room')) ||
            !targets.groupRef || source.groupRecipientPeerIds === undefined ||
            targets.groupRef.applicationId !== notice.scope.applicationId ||
            targets.groupRef.workspaceId !== notice.scope.workspaceId
        ) {
            return undefined;
        }
        return {
            mode: 'room',
            groupRef: targets.groupRef,
            recipientSessionIds: filterLiveWsRoomRecipientSessionIds(
                targets,
                message.id.senderId,
                source.groupRecipientPeerIds
            )
        };
    }
    if (notice.audienceMode === 'broad') {
        return targets?.mode === 'broadcast' && targets.scope === notice.targetMode
            ? { mode: 'broad', targetMode: targets.scope }
            : undefined;
    }
    return undefined;
}
