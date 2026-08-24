import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { BrowserCallMediaRuntime } from '@shared-web/browser/calls/browser-call-media-runtime.ts';
import { BrowserCallStatusReader } from '@shared-web/browser/calls/browser-call-status-reader.ts';
import type {
    RallarCallEndOptions,
    RallarCallHandle,
    RallarCallStartInput,
    RallarCallStatus
} from '@shared-web/browser/rallar-calls-facade.ts';
import type {
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarTargetSelector
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade, RallarWaitForOpenOptions } from '@shared-web/browser/rallar-rtc-facade.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';

export namespace BrowserCallSessionRuntime {
    export interface Input extends BrowserCallMediaRuntime.Input {
        connect(): Promise<ApiMiddleware>;
        readMiddleware(): ApiMiddleware | undefined;
        resolveTargetPeerIds(input?: RallarTargetSelector): readonly string[];
        createTargetedChannel<T>(
            definition: RallarTargetedChannelDefinition
        ): RallarTargetedChannel<T>;
        readonly rtc: RallarRtcFacade;
    }
}

/** Owns the mutable media, readiness, membership, and termination state of one call. */
export class BrowserCallSessionRuntime {
    private readonly callId: string;
    private readonly fixedPeerIds: readonly string[] | undefined;
    private readonly input: BrowserCallSessionRuntime.Input;
    private readonly laneIds: readonly string[];
    private readonly media: BrowserCallMediaRuntime;
    private readonly startInput: RallarCallStartInput;
    private readonly startedAtEpochMs = Date.now();
    private readonly statusReader: BrowserCallStatusReader;
    private endedAtEpochMs: number | undefined;

    constructor(
        input: BrowserCallSessionRuntime.Input,
        startInput: RallarCallStartInput
    ) {
        this.input = input;
        this.startInput = startInput;
        this.callId = startInput.callId ?? crypto.randomUUID();
        this.laneIds = resolveCallLaneIds(startInput);
        this.fixedPeerIds = startInput.membership === 'live'
            ? undefined
            : input.resolveTargetPeerIds(startInput);
        this.media = new BrowserCallMediaRuntime(input, startInput.media);
        this.statusReader = new BrowserCallStatusReader(input.rtc);
    }

    async start(): Promise<RallarCallHandle> {
        await this.media.open();
        await this.wait({ timeoutMs: this.startInput.data?.openTimeoutMs });
        return this.createHandle();
    }

    private createHandle(): RallarCallHandle {
        return {
            id: this.callId,
            status: () => this.status(),
            wait: async (options) => await this.wait(options),
            channel: <T>(definition?: Partial<RallarTargetedChannelDefinition>) => this.channel<T>(definition),
            setLocalStream: async (stream) => await this.media.setLocalStream(stream),
            setAudioEnabled: async (enabled) => await this.media.setAudioEnabled(enabled),
            setVideoEnabled: async (enabled) => await this.media.setVideoEnabled(enabled),
            stopLocal: async (kind) => await this.media.stopLocal(kind),
            sources: this.media.sources,
            end: async (options) => await this.end(options)
        };
    }

    private status(): RallarCallStatus {
        const peerIds = this.resolvePeerIds();
        return this.statusReader.read({
            callId: this.callId,
            peerIds,
            laneIds: this.laneIds,
            startedAtEpochMs: this.startedAtEpochMs,
            endedAtEpochMs: this.endedAtEpochMs,
            media: this.media.readStatus()
        });
    }

    private async wait(options: RallarWaitForOpenOptions = {}): Promise<RallarCallStatus> {
        if (this.endedAtEpochMs !== undefined) {
            return this.status();
        }
        const ctx = await this.input.connect();
        const peerIds = this.resolvePeerIds();
        if (this.laneIds.length === 0) {
            for (const peerId of peerIds) {
                ctx.middleware.webRtcConnectionService.ensurePeerConnectionStarted(peerId);
            }
            return this.status();
        }
        await Promise.all(
            peerIds.flatMap((peerId) =>
                this.laneIds.map((laneId) =>
                    this.input.rtc.waitForLane(peerId, laneId, {
                        ...options,
                        connect: true
                    })
                )
            )
        );
        return this.status();
    }

    private channel<T>(
        definition: Partial<RallarTargetedChannelDefinition> = {}
    ): RallarTargetedChannel<T> {
        const membership = definition.membership ?? this.startInput.membership ?? 'fixed';
        const target = membership === 'live' && this.hasRoomTarget() &&
                !hasTargetSelectorOverride(definition)
            ? {
                roomId: this.startInput.roomId,
                roomRef: this.startInput.roomRef,
                membership
            }
            : {
                peerIds: this.resolvePeerIds(definition),
                membership
            };
        return this.input.createTargetedChannel<T>({
            ...definition,
            ...target,
            laneId: definition.laneId ?? this.laneIds[0]
        });
    }

    private async end(options: RallarCallEndOptions = {}): Promise<RallarCallStatus> {
        this.endedAtEpochMs ??= Date.now();
        if (options.disconnectPeers ?? false) {
            for (const peerId of this.resolvePeerIds()) {
                this.input.readMiddleware()?.middleware.webRtcConnectionService
                    .disconnectPeer(peerId);
            }
        }
        if (options.stopLocalMedia ?? true) {
            await this.media.stopLocal('all');
        }
        return this.status();
    }

    private resolvePeerIds(target: RallarTargetSelector = {}): readonly string[] {
        if (this.fixedPeerIds && !hasTargetSelectorOverride(target)) {
            return this.fixedPeerIds;
        }
        return this.input.resolveTargetPeerIds({ ...this.startInput, ...target });
    }

    private hasRoomTarget(): boolean {
        return this.startInput.roomId !== undefined || this.startInput.roomRef !== undefined;
    }
}

function resolveCallLaneIds(input: RallarCallStartInput): readonly string[] {
    if (!input.data) {
        return input.media ? [] : [DEFAULT_RTC_DATA_CHANNEL_LANE_ID];
    }
    const lanes = input.data.lanes?.length
        ? input.data.lanes
        : [DEFAULT_RTC_DATA_CHANNEL_LANE_ID];
    return [...new Set(lanes.filter((laneId) => laneId.length > 0))];
}

function hasTargetSelectorOverride(input: RallarTargetSelector): boolean {
    return input.peerId !== undefined || input.peerIds !== undefined ||
        input.roomId !== undefined || input.roomRef !== undefined ||
        input.membership !== undefined;
}
