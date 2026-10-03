import {
    createCheckpointALOutboundRuntimeStores,
    type CreateDefaultALRuntimeStoresInput
} from '@shared/alm/al-runtime-stores.ts';
import { resolveALCheckpointRuntimeStores } from '@shared/alm/ALRuntimeStoreRegistry.ts';
import { AL_CHECKPOINT_DEFAULT_SETTINGS } from '@shared/alm/checkpoint/al-checkpoint-settings.ts';
import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
import type { ALCheckpointOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';

import {
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from './browser-al-runtime-identity.ts';

/** The session store's checkpoint settings, which the browser composition states once per connect. */
export interface BrowserALCheckpointSettingsInput {
    readonly checkpointIntervalMs?: number;
    /** Beyond it the checkpoint store reads `failing` and new checkpoint admissions follow `onStorageUnavailable`. */
    readonly checkpointLagBoundMs?: number;
}

export interface BrowserALCheckpointSettings {
    readonly intervalMs: number;
    readonly lagBoundMs: number;
}

/** One connect's checkpoint pairs, one per outbound carrier. */
export interface BrowserALCheckpointStores {
    readonly wsClient: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly rtcOverlay: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
}

export interface CreateBrowserALCheckpointStoresInput {
    readonly options: Omit<CreateDefaultALRuntimeStoresInput, 'namespace'>;
    readonly settings: BrowserALCheckpointSettings;
    readonly ownership: ALDurableWorkOwnership;
}

const BROWSER_AL_CHECKPOINT_TIMERS: ALCheckpointWriter.Timers = {
    schedule: (run, delayMs) => {
        const handle = globalThis.setTimeout(run, delayMs);
        return () => globalThis.clearTimeout(handle);
    }
};

export function resolveBrowserALCheckpointSettings(
    input: BrowserALCheckpointSettingsInput
): BrowserALCheckpointSettings {
    return {
        intervalMs: input.checkpointIntervalMs ?? AL_CHECKPOINT_DEFAULT_SETTINGS.intervalMs,
        lagBoundMs: input.checkpointLagBoundMs ?? AL_CHECKPOINT_DEFAULT_SETTINGS.lagBoundMs
    };
}

/** Admits and dispatches from memory; the connect that owns the session's work checkpoints it to IndexedDB. */
export function createBrowserALCheckpointOutboundRuntimeStores(
    name: string,
    input: CreateBrowserALCheckpointStoresInput
): ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage> {
    return createCheckpointALOutboundRuntimeStores({
        ...input.options,
        namespace: `browser:${name}`,
        decodePrepared: decodeALOutboundTransportMessage,
        ownership: input.ownership,
        intervalMs: input.settings.intervalMs,
        lagBoundMs: input.settings.lagBoundMs,
        timers: BROWSER_AL_CHECKPOINT_TIMERS
    });
}

/** Built once per connect, under the connect's claim on the session's work; the stores must be configured first. */
export function resolveBrowserALCheckpointStores(
    sessionId: string,
    ownership: ALDurableWorkOwnership
): BrowserALCheckpointStores {
    return {
        wsClient: resolveALCheckpointRuntimeStores(toBrowserWsClientALRuntimeStoreId(sessionId), ownership),
        rtcOverlay: resolveALCheckpointRuntimeStores(toBrowserRtcOverlayALRuntimeStoreId(sessionId), ownership)
    };
}
