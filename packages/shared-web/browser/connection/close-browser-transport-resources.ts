import type { RallarSessionHeartbeat } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALRuntimeStorage } from '@shared/alm/storage/al-runtime-storage.ts';
import type { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import type { WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import type { WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';

export namespace CloseBrowserTransportResources {
    /** Startup can fail between acquisitions; each acquired resource still has one cleanup owner. */
    export interface Input {
        readonly heartbeat?: RallarSessionHeartbeat;
        readonly rtcRxStreamer?: WebRtcRxStreamerService;
        readonly webRtcGroupManager?: WebRtcGroupManager;
        readonly webRtcConnectionService?: WebRtcConnectionService;
        readonly webRtcOverlayMulticastManager?: WebRtcOverlayMulticastManager;
        readonly qboxEngine?: InboxOutboxEngine;
        readonly webSocketQueueBox?: WsQueueBoxClientService;
        readonly runtimeStorage?: ALRuntimeStorage;
    }
}

/** Cancels every acquired transport synchronously, then joins all completion-bearing cleanup. */
export async function closeBrowserTransportResources(
    resources: CloseBrowserTransportResources.Input,
    reason = 'rallar-disconnect'
): Promise<void> {
    const failures: Error[] = [];
    const completions: Promise<void>[] = [];
    const steps = [
        () => resources.heartbeat?.stop(),
        () => resources.rtcRxStreamer?.dispose(),
        () => resources.webRtcGroupManager?.stopReconcileWakes(),
        () => disconnectBrowserTransportPeers(resources.webRtcConnectionService),
        () => resources.webRtcConnectionService?.disposeNativeObservations(),
        () => resources.rtcRxStreamer?.stopLocalMedia('all'),
        () => resources.webRtcOverlayMulticastManager?.dispose(),
        () => resources.qboxEngine?.stop(),
        () => resources.webSocketQueueBox?.close(1000, reason)
    ];
    for (const step of steps) {
        try {
            completions.push(Promise.resolve(step()));
        }
        catch (caught) {
            failures.push(toError(caught));
        }
    }
    for (const outcome of await Promise.allSettled(completions)) {
        if (outcome.status === 'rejected') {
            failures.push(toError(outcome.reason));
        }
    }
    try {
        await resources.runtimeStorage?.close();
    }
    catch (caught) {
        failures.push(toError(caught));
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Browser transport cleanup failed');
    }
}

function disconnectBrowserTransportPeers(service: WebRtcConnectionService | undefined): void {
    const failures: Error[] = [];
    for (const peerId of service?.knownPeerIds() ?? []) {
        try {
            service?.disconnectPeer(peerId);
        }
        catch (caught) {
            failures.push(toError(caught));
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Browser peer cleanup failed');
    }
}

/** Optional cleanup diagnostics cannot replace the startup failure that caused rollback. */
export function reportBrowserStartupCleanupFailure(error: Error): void {
    try {
        console.error('Browser startup rollback cleanup failed:', error);
    }
    catch { /* Keep the exact primary startup failure even when diagnostics fail. */ }
}
