import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
import { decodePositiveInteger } from '../runtime/decode-runtime-result-values.ts';
import { computeEffectiveFrameCount } from './distributed-recipe-command-preview.ts';

export function toRtcConnectCommandDetails(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect'; }>
): readonly string[] {
    if (!command.readiness) {
        return [];
    }

    const minReadyPeers = decodePositiveInteger(command.readiness.minReadyPeers) ?? 1;
    const timeoutMs = decodePositiveInteger(command.readiness.timeoutMs) ?? 5_000;
    const intervalMs = decodePositiveInteger(command.readiness.intervalMs) ?? 100;
    return [`readiness: min ${minReadyPeers} ready peer(s), timeout ${timeoutMs} ms, poll ${intervalMs} ms`];
}

export function toRtcStreamCommandDetails(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.stream'; }>
): readonly string[] {
    const frameCount = computeEffectiveFrameCount(command);
    return [
        ...(frameCount === undefined ? [] : [`${frameCount} frame${frameCount === 1 ? '' : 's'}`]),
        ...(command.intervalMs !== undefined
            ? [`interval ${command.intervalMs} ms`]
            : command.rateHz !== undefined
            ? [`rate ${command.rateHz} Hz`]
            : []),
        ...(command.maxInFlight === undefined ? [] : [`max in-flight ${command.maxInFlight}`]),
        ...(command.thresholds?.minSendSuccessRatio === undefined
            ? []
            : [`min success ratio ${command.thresholds.minSendSuccessRatio}`]),
        ...(command.thresholds?.maxDroppedFrames === undefined
            ? []
            : [`max dropped frames ${command.thresholds.maxDroppedFrames}`])
    ];
}
