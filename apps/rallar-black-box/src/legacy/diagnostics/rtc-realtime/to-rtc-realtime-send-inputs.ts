import type { RallarRtcSendInput } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRealtimeJsonSendInput } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { splitCsvValues } from '../../shared/json-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RtcRealtimeFormValues } from './rtc-realtime-contracts.ts';

export interface RtcRealtimeSendInputs {
    readonly realtime: RallarRealtimeJsonSendInput<unknown>;
    readonly messagesRtc: RallarRtcSendInput<unknown>;
}

export namespace RtcRealtimeSendInputs {
    export interface Source {
        readonly form: RtcRealtimeFormValues;
        readonly globalValues: CommandCenterGlobalValues;
        readonly payload: unknown;
    }
}

/** The facade sends the panel issues, which a copied recipe carries verbatim as its rtc.send envelopes. */
export function toRtcRealtimeSendInputs(
    { form, globalValues, payload }: RtcRealtimeSendInputs.Source
): RtcRealtimeSendInputs {
    const activeGroupId = globalValues.roomId.trim();
    const peerIds = splitCsvValues(form.peerIdsText);
    const targetPeerIds = peerIds.length > 0 ? peerIds : undefined;
    const roomRef: GroupRef | undefined = activeGroupId
        ? { applicationId: globalValues.applicationId, workspaceId: globalValues.workspaceId, groupId: activeGroupId }
        : undefined;
    return {
        realtime: {
            data: payload,
            laneId: form.laneId,
            roomId: activeGroupId,
            roomRef,
            peerIds: targetPeerIds,
            openTimeoutMs: form.timeoutMs
        },
        messagesRtc: {
            roomId: activeGroupId,
            roomRef,
            typeId: form.typeId,
            topicId: form.topicId,
            contextId: form.contextId || activeGroupId || form.typeId,
            payload,
            minSnapshotVersion: form.minSnapshotVersion.trim() ? Number(form.minSnapshotVersion) : undefined,
            reliability: form.reliability,
            ack: form.ack,
            ownership: form.ownership,
            nextHopPeerIds: targetPeerIds,
            overlayId: activeGroupId || undefined
        }
    };
}
