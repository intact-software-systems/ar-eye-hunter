import { ALMessage, ALPayload } from '@shared/al-contracts/al-contract.ts';
import { getMiddleware } from '@shared-web/browser/app-context.ts';

export type RtcInboxCallback = (data: ALPayload) => Promise<void>

export function addRtcInboxCallback(typeId: string, handler: RtcInboxCallback) {
    getMiddleware().middleware
        .rtcRxStreamer
        .onInboxMessageDo(
            typeId,
            {
                onMessage: async (data: ALMessage) => {
                    await handler(data.payload);
                }
            }
        );
}

export function removeRtcInboxCallback(typeId: string) {
    getMiddleware().middleware
        .rtcRxStreamer
        .removeInboxMessageCallback(typeId);
}
