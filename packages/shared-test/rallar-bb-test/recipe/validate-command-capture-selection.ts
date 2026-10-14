import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { validateEventHistoryPolicy } from '../runtime/event-history.ts';

/** Only executable capture fields are inspected; send payloads remain opaque. */
export function validateCommandCaptureSelection(command: RallarBlackBoxTestRecord): readonly string[] {
    if (command.kind === 'recipe.run') {
        return [
            ...(parseRtcCaptureMode(command.rtcCaptureMode).left ?? []).map((issue) => issue.message),
            ...(command.eventHistory === undefined ? [] : validateEventHistoryPolicy(command.eventHistory))
        ];
    }
    const config = command.kind === 'configure' ? command.config : command;
    if (command.kind !== 'configure' && command.kind !== 'rtc.connect' && command.kind !== 'crdt.open') {
        return [];
    }
    const historyIssues =
        command.kind === 'configure' && typeof config === 'object' && config !== null && 'eventHistory' in config
            ? validateEventHistoryPolicy(config.eventHistory)
            : [];
    if (typeof config !== 'object' || config === null || !('rallar' in config)) {
        return historyIssues;
    }
    const rallar = config.rallar;
    if (typeof rallar !== 'object' || rallar === null || !('rtcCaptureMode' in rallar)) {
        return historyIssues;
    }
    return [...historyIssues, ...(parseRtcCaptureMode(rallar.rtcCaptureMode).left ?? []).map((issue) => issue.message)];
}
