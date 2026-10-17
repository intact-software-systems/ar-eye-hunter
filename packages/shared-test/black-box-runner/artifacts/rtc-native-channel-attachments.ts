import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export namespace RtcNativeChannelAttachments {
    export interface InputDto {
        readonly localSessionId: string;
        readonly peerSessionId: string;
        readonly scopeId: RtcSignalingDiagnostics.Readout<string>;
    }

    export interface PeerLifetime {
        retired: boolean;
        readonly channels: Map<string, ChannelLifetime>;
    }

    export interface ChannelLifetime {
        retired: boolean;
        sequence: number;
        event: ApiJsonObject | undefined;
    }
}

/** Correlates projected resource observations; source admission remains with readRtcNativeAcquisition. */
export class RtcNativeChannelAttachments {
    readonly #input: RtcNativeChannelAttachments.InputDto;
    readonly #peers = new Map<string, RtcNativeChannelAttachments.PeerLifetime>();
    #current: ApiJsonObject | undefined;

    constructor(input: RtcNativeChannelAttachments.InputDto) {
        this.#input = input;
    }

    observe(event: ApiJsonObject): void {
        const service = toJsonObject(event.service);
        const native = toJsonObject(event.native ?? service?.native);
        if (
            !native || event.localSessionId !== this.#input.localSessionId ||
            event.peerSessionId !== this.#input.peerSessionId ||
            !jsonEquals(toJsonObject(native.capture)?.scopeId, this.#input.scopeId)
        ) {
            return;
        }
        const identity = toJsonObject(native.identity);
        const pcId = readObservedString(identity?.peerConnectionId);
        if (pcId === undefined) {
            return;
        }
        let peer = this.#peers.get(pcId);
        if (!peer) {
            peer = { retired: false, channels: new Map() };
            this.#peers.set(pcId, peer);
        }
        const channelId = readObservedString(identity?.channelId);
        const retiring = event.kind === 'native-lifetime' && event.action === 'retiring';
        if (
            service?.stage === 'terminating' ||
            readObservedString(toJsonObject(native.state)?.connectionState) === 'closed' ||
            (retiring && channelId === undefined)
        ) {
            peer.retired = true;
            peer.channels.clear();
        }
        if (!peer.retired) {
            if (channelId !== undefined) {
                this.#observeChannel(peer, native, event);
            }
            this.#retireCompactChannels(service);
        }
        this.#selectCurrentChannel();
    }

    getCurrentChannel(): ApiJsonObject | undefined {
        return this.#current;
    }

    #observeChannel(
        peer: RtcNativeChannelAttachments.PeerLifetime,
        native: ApiJsonObject,
        event: ApiJsonObject
    ): void {
        const channelId = readObservedString(toJsonObject(native.identity)?.channelId);
        if (channelId === undefined) {
            return;
        }
        let channel = peer.channels.get(channelId);
        if (!channel) {
            channel = { retired: false, sequence: -1, event: undefined };
            peer.channels.set(channelId, channel);
        }
        const state = readObservedString(toJsonObject(native.state)?.channelState);
        if (
            (event.kind === 'native-lifetime' && event.action === 'retiring') || state === 'closing' ||
            state === 'closed'
        ) {
            channel.retired = true;
            channel.event = undefined;
            return;
        }
        // Sequences are local to this capture scope; a PC-only event cannot advance a channel's state.
        if (!channel.retired && typeof native.nativeSequence === 'number' && native.nativeSequence > channel.sequence) {
            channel.sequence = native.nativeSequence;
            channel.event = state === 'open' ? event : undefined;
        }
    }

    #retireCompactChannels(service: ApiJsonObject | undefined): void {
        if (!Array.isArray(service?.channels)) {
            return;
        }
        for (const value of service.channels) {
            const compact = toJsonObject(value);
            const identity = toJsonObject(compact?.identity);
            const pcId = readObservedString(identity?.peerConnectionId);
            const channelId = readObservedString(identity?.channelId);
            const state = readObservedString(compact?.channelState);
            if (pcId === undefined || channelId === undefined || (state !== 'closing' && state !== 'closed')) {
                continue;
            }
            const peer = this.#peers.get(pcId);
            if (peer && !peer.retired) {
                // Compact inventories can retire a resource, but cannot supply full listener/capture proof.
                peer.channels.set(channelId, { retired: true, sequence: -1, event: undefined });
            }
        }
    }

    #selectCurrentChannel(): void {
        this.#current = undefined;
        let latestSequence = -1;
        for (const peer of this.#peers.values()) {
            for (const channel of peer.channels.values()) {
                if (
                    !peer.retired && !channel.retired && channel.event !== undefined &&
                    channel.sequence > latestSequence
                ) {
                    this.#current = channel.event;
                    latestSequence = channel.sequence;
                }
            }
        }
    }
}

function readObservedString(value: ApiJsonValue | undefined): string | undefined {
    const readout = toJsonObject(value);
    return readout?.status === 'observed' && typeof readout.value === 'string' ? readout.value : undefined;
}

function toJsonObject(value: ApiJsonValue | undefined): ApiJsonObject | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ApiJsonObject : undefined;
}
