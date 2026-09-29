import type {
    BrowserMessageInputValidator,
    ResolvedWsMessageInput
} from '@shared-web/browser/messages/browser-message-input-validator.ts';
import {
    validateBrowserPeerInput,
    type BrowserPeerSendStrategy
} from '@shared-web/browser/messages/create-browser-unicast-message.ts';
import type {
    RallarRtcSendInput,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

export type BrowserRtcPeerSendStrategy = Exclude<BrowserPeerSendStrategy, 'ws'>;

export interface BrowserRtcPeerSend<T> {
    readonly send: RallarRtcSendInput<T> & RallarWsSendInput<T>;
    readonly peerId: string;
    readonly strategy: BrowserRtcPeerSendStrategy;
}

export interface ValidateBrowserRtcPeerSendInput<T> {
    readonly peer: BrowserRtcPeerSend<T>;
    readonly resolved: ResolvedWsMessageInput<T>;
    readonly inputValidator: BrowserMessageInputValidator;
}

export function validateBrowserRtcPeerSend<T>(
    input: ValidateBrowserRtcPeerSendInput<T>
): readonly RallarValidationIssue[] {
    const { peer, resolved } = input;
    return [
        ...validateBrowserPeerInput({ send: peer.send, roomRef: resolved.roomRef }),
        ...(peer.strategy === 'rtc-with-ws-fallback'
            ? input.inputValidator.validateWs(resolved)
            : []),
        ...validateRtcPeerCarriage(peer.send)
    ];
}

function validateRtcPeerCarriage<T>(
    send: BrowserRtcPeerSend<T>['send']
): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    if (send.scope !== undefined && send.scope !== 'room') {
        issues.push({
            path: '$.scope',
            code: 'unsupported',
            message: 'A peer-addressed RTC send names its room: its scope is room.'
        });
    }
    if (
        send.membershipEpoch !== undefined || send.nextHopPeerIds !== undefined ||
        send.overlayId !== undefined || send.fanoutLimit !== undefined
    ) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no membership fence and no overlay routing.'
        });
    }
    return issues;
}
