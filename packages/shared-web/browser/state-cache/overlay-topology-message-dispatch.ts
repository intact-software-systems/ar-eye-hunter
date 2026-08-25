import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { parseAuthoritativeOverlayTopologySnapshot } from '@shared/api/authoritative-state-validation.ts';
import { toOverlayInfoForSession, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

import { isRtcTopologyCurrentStateMessage } from './is-rtc-topology-current-state-message.ts';

export interface AdoptOverlayTopologyInput {
    readonly topology: RallarOverlayTopologySnapshot;
    readonly sessionId: string;
    readonly webRtcGroupManager: WebRtcGroupManager;
    readonly adoption: 'current-state' | 'publication';
}

export interface DispatchOverlayTopologyMessageInput {
    readonly message: ALMessage;
    readonly scope: StateScope;
    readonly sessionId: string;
    readonly webRtcGroupManager: WebRtcGroupManager;
}

export async function dispatchOverlayTopologyMessage(
    input: DispatchOverlayTopologyMessageInput
): Promise<boolean> {
    if (input.message.payload.typeId !== AppTopics.overlayTopology) {
        return false;
    }
    const topology = parseAuthoritativeOverlayTopologySnapshot(
        input.message.payload.resource,
        input.scope
    );
    await adoptOverlayTopology({
        topology,
        sessionId: input.sessionId,
        webRtcGroupManager: input.webRtcGroupManager,
        adoption: isRtcTopologyCurrentStateMessage(
                input.message,
                topology,
                input.sessionId
            )
            ? 'current-state'
            : 'publication'
    });
    return true;
}

export async function adoptOverlayTopology(
    input: AdoptOverlayTopologyInput
): Promise<void> {
    const overlay = toOverlayInfoForSession(input.topology, input.sessionId);
    if (input.adoption === 'current-state') {
        overlaysRepository.setCurrentServerOverlayById(input.topology.overlayId, overlay);
    }
    else {
        overlaysRepository.setOverlayById(input.topology.overlayId, overlay);
    }
    await overlaysRepository.waitForOverlayChangesIdle();
    await input.webRtcGroupManager.notifyOverlayTopologyChanged();
}
