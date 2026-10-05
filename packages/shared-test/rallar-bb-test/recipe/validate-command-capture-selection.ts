import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

/** Only executable capture fields are inspected; send payloads remain opaque. */
export function validateCommandCaptureSelection(command: RallarBlackBoxTestRecord): readonly string[] {
    if (command.kind === 'recipe.run') {
        return (parseRtcCaptureMode(command.rtcCaptureMode).left ?? []).map((issue) => issue.message);
    }
    const config = command.kind === 'configure' ? command.config : command;
    if (command.kind !== 'configure' && command.kind !== 'rtc.connect') {
        return [];
    }
    if (typeof config !== 'object' || config === null || !('rallar' in config)) {
        return [];
    }
    const rallar = config.rallar;
    if (typeof rallar !== 'object' || rallar === null || !('rtcCaptureMode' in rallar)) {
        return [];
    }
    return (parseRtcCaptureMode(rallar.rtcCaptureMode).left ?? []).map((issue) => issue.message);
}
