import type {
    RallarDirectorRelaySendResult,
    RallarMessageSendResult,
    RallarRealtimeSendResult
} from '@shared-web/browser/rallar.ts';

export interface RallarGameSendResult {
    readonly status:
        | 'sent'
        | 'partial'
        | 'skipped'
        | 'failed'
        | 'no-director'
        | 'not-director'
        | 'not-ready'
        | 'stopped';
    readonly transport?: 'local' | 'ws' | 'rtc' | 'realtime' | 'director-relay';
    readonly reason?: string;
    readonly ws?: RallarMessageSendResult;
    readonly realtime?: readonly RallarRealtimeSendResult[];
    readonly relay?: RallarDirectorRelaySendResult;
}
