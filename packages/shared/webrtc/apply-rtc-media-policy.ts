import { toError } from '../resilience/to-error.ts';
import type { QRtcMediaPolicy } from './qrtc-peer-connection.ts';

interface SenderEncodingPolicy {
    readonly maxBitrateBps?: number;
    readonly maxFramerate?: number;
    readonly scaleResolutionDownBy?: number;
    readonly degradationPreference?: RTCDegradationPreference;
}

export function applyRtcMediaPolicy(pc: RTCPeerConnection, policy: QRtcMediaPolicy): void {
    // Ensure transceivers exist before setting codec preferences.
    ensureTransceiversForPolicy(pc, policy);

    if (policy.preferredVideoCodecs && policy.preferredVideoCodecs.length > 0) {
        applyCodecPreferences(pc, 'video', policy.preferredVideoCodecs);
    }
    if (policy.preferredAudioCodecs && policy.preferredAudioCodecs.length > 0) {
        applyCodecPreferences(pc, 'audio', policy.preferredAudioCodecs);
    }

    if (
        policy.maxVideoBitrateBps ||
        policy.maxVideoFramerate ||
        policy.scaleResolutionDownBy ||
        policy.degradationPreference
    ) {
        void applySenderEncodingParams(
            pc,
            'video',
            {
                maxBitrateBps: policy.maxVideoBitrateBps,
                maxFramerate: policy.maxVideoFramerate,
                scaleResolutionDownBy: policy.scaleResolutionDownBy,
                degradationPreference: policy.degradationPreference
            }
        );
    }

    if (policy.maxAudioBitrateBps) {
        void applySenderEncodingParams(
            pc,
            'audio',
            {
                maxBitrateBps: policy.maxAudioBitrateBps
            }
        );
    }
}

function ensureTransceiversForPolicy(pc: RTCPeerConnection, policy: QRtcMediaPolicy): void {
    const needAudio = !!(policy.preferredAudioCodecs && policy.preferredAudioCodecs.length > 0);
    const needVideo = !!(policy.preferredVideoCodecs && policy.preferredVideoCodecs.length > 0);

    if (needAudio && !pc.getTransceivers().some((t) => t.receiver.track.kind === 'audio')) {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
    }
    if (needVideo && !pc.getTransceivers().some((t) => t.receiver.track.kind === 'video')) {
        pc.addTransceiver('video', { direction: 'sendrecv' });
    }
}

function applyCodecPreferences(
    pc: RTCPeerConnection,
    kind: 'audio' | 'video',
    preferredMimeTypes: readonly string[]
): void {
    const caps = RTCRtpSender.getCapabilities(kind);
    if (!caps) {
        return;
    }

    const codecs = caps.codecs
        .filter(
            (c) => preferredMimeTypes.includes(c.mimeType)
        )
        .sort(
            (a, b) => preferredMimeTypes.indexOf(a.mimeType) - preferredMimeTypes.indexOf(b.mimeType)
        );

    const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === kind);
    if (!transceiver || codecs.length === 0) {
        return;
    }

    try {
        transceiver.setCodecPreferences(codecs);
    }
    catch (caught) {
        console.warn('setCodecPreferences not supported or failed', toError(caught));
    }
}

async function applySenderEncodingParams(
    pc: RTCPeerConnection,
    kind: 'audio' | 'video',
    args: SenderEncodingPolicy
): Promise<void> {
    const sender = pc.getSenders().find((s) => s.track?.kind === kind);
    if (!sender) {
        return;
    }

    const params = sender.getParameters();
    params.encodings = params.encodings && params.encodings.length > 0 ? params.encodings : [{}];

    const enc = params.encodings[0];

    if (args.maxBitrateBps !== undefined) {
        enc.maxBitrate = args.maxBitrateBps;
    }

    if (kind === 'video') {
        if (args.maxFramerate !== undefined) {
            enc.maxFramerate = args.maxFramerate;
        }
        if (args.scaleResolutionDownBy !== undefined) {
            enc.scaleResolutionDownBy = args.scaleResolutionDownBy;
        }

        if (args.degradationPreference !== undefined) {
            // Best-effort: supported in many browsers but not always typed
            params.degradationPreference = args.degradationPreference;
        }
    }

    try {
        await sender.setParameters(params);
    }
    catch (caught) {
        console.warn('setParameters failed', toError(caught));
    }
}
