import type { RallarCallMediaInput, RallarCallStatus } from '@shared-web/browser/rallar-calls-facade.ts';
import type {
    RallarMediaFacade,
    RallarMediaSourcesFacade,
    RallarMediaSourceStatus
} from '@shared-web/browser/rallar-media-facade.ts';

export namespace BrowserCallMediaRuntime {
    export interface Input {
        readonly media: RallarMediaFacade;
        readSourceStatuses(): readonly RallarMediaSourceStatus[];
    }
}

/** Owns one call's local media state and the underlying source mutations. */
export class BrowserCallMediaRuntime {
    readonly sources: RallarMediaSourcesFacade;
    private audioEnabled: boolean | undefined;
    private readonly initial: RallarCallMediaInput | undefined;
    private readonly input: BrowserCallMediaRuntime.Input;
    private localStreamId: string | undefined;
    private videoEnabled: boolean | undefined;

    constructor(
        input: BrowserCallMediaRuntime.Input,
        initial: RallarCallMediaInput | undefined
    ) {
        this.input = input;
        this.initial = initial;
        this.localStreamId = initial?.stream?.id;
        this.audioEnabled = initial?.audio;
        this.videoEnabled = initial?.video;
        this.sources = {
            microphone: input.media.microphone,
            camera: input.media.camera,
            screen: input.media.screen
        };
    }

    async open(): Promise<void> {
        if (this.initial?.stream) {
            await this.setLocalStream(this.initial.stream);
        }
        if (this.initial?.audio !== undefined) {
            await this.setAudioEnabled(this.initial.audio);
        }
        if (this.initial?.video !== undefined) {
            await this.setVideoEnabled(this.initial.video);
        }
    }

    readStatus(): RallarCallStatus['media'] {
        return {
            localStreamId: this.localStreamId,
            audioEnabled: this.audioEnabled,
            videoEnabled: this.videoEnabled,
            sources: this.input.readSourceStatuses()
        };
    }

    async setLocalStream(stream: MediaStream): Promise<void> {
        await this.input.media.setLocalStream(stream);
        this.localStreamId = stream.id;
    }

    async setAudioEnabled(enabled: boolean): Promise<void> {
        await this.input.media.setAudioEnabled(enabled);
        this.audioEnabled = enabled;
    }

    async setVideoEnabled(enabled: boolean): Promise<void> {
        await this.input.media.setVideoEnabled(enabled);
        this.videoEnabled = enabled;
    }

    async stopLocal(kind: 'audio' | 'video' | 'all'): Promise<void> {
        await this.input.media.stopLocal(kind);
        if (kind === 'audio' || kind === 'all') {
            this.audioEnabled = false;
        }
        if (kind === 'video' || kind === 'all') {
            this.videoEnabled = false;
        }
        if (kind === 'all') {
            this.localStreamId = undefined;
        }
    }
}
