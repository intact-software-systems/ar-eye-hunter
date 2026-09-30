import { readALTargetGroupRef, type ALMessage } from '../al-contracts/al-contract.ts';
import type { OverlayId, OverlayInfo, PeerId } from '../api/api-config.ts';
import { isSameGroupRef, toScopedOverlayId } from '../api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '../api/group-types.ts';
import type { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';

export interface RtcOutboundObservation {
    readonly overlayId: OverlayId | undefined;
    readonly room: GroupSnapshot | undefined;
    readonly overlay: OverlayInfo | undefined;
    readonly connectedPeerIds: readonly PeerId[];
    readonly nowMs: number;
}

export interface ReadRtcOutboundObservationInput {
    readonly message: ALMessage;
    readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
    readonly overlayCache: ReadableKeyedValues<string, OverlayInfo>;
    readonly connectedPeerIds: readonly PeerId[];
    readonly nowMs: number;
}

export function readRtcOutboundObservation(
    input: ReadRtcOutboundObservationInput
): RtcOutboundObservation {
    const { message, groupCache } = input;
    const groupRef = readALTargetGroupRef(message);
    const selected = readRtcSelectedOverlay(input, groupRef);
    return {
        overlayId: selected.overlayId,
        overlay: selected.overlay,
        room: groupRef
            ? readRtcGroupSnapshotByRef(groupCache, groupRef)
            : selected.overlayId
            ? groupCache.read(selected.overlayId)
            : undefined,
        connectedPeerIds: input.connectedPeerIds,
        nowMs: input.nowMs
    };
}

export function readRtcGroupSnapshotByRef(
    groupCache: ReadableKeyedValues<string, GroupSnapshot>,
    ref: GroupRef
): GroupSnapshot | undefined {
    return groupCache.readAllValues().find((group) => isSameGroupRef(group.group, ref));
}

interface RtcSelectedOverlay {
    readonly overlayId: OverlayId | undefined;
    readonly overlay: OverlayInfo | undefined;
}

function readRtcSelectedOverlay(
    input: ReadRtcOutboundObservationInput,
    groupRef: GroupRef | undefined
): RtcSelectedOverlay {
    const { message, overlayCache } = input;
    const explicitId = message.forwarding?.overlayId;
    const scopedId = groupRef
        ? toScopedOverlayId(groupRef)
        : message.targets?.mode === 'broadcast'
        ? message.route.contextId
        : undefined;
    const candidates = [explicitId, scopedId, groupRef?.groupId]
        .filter((overlayId, index, all): overlayId is OverlayId => !!overlayId && all.indexOf(overlayId) === index);
    for (const overlayId of candidates) {
        const overlay = overlayCache.read(overlayId);
        if (overlay !== undefined) {
            return { overlayId, overlay };
        }
    }
    return { overlayId: explicitId ?? scopedId, overlay: undefined };
}
