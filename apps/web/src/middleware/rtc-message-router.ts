import {ALMessage, ALPayload} from "@shared/al-contracts/al-contract.ts";
import {WebRtcQueueBoxClientService} from "@shared/services/WebRtcQueueBoxClientService.ts";

export type RtcInboxCallback = (data: ALPayload) => Promise<void>

const rtcInboxCallbacks = new Map<string, RtcInboxCallback>();

export function addRtcInboxCallback(typeId: string, handler: RtcInboxCallback) {
    rtcInboxCallbacks.set(typeId, handler);
}

export function removeRtcInboxCallback(typeId: string) {
    rtcInboxCallbacks.delete(typeId);
}

export function initialise(
    rtcQueueBoxClientService: WebRtcQueueBoxClientService
) {
    rtcQueueBoxClientService
        .onInboxMessageDo(
            "rtc-message-router",
            {
                onMessage: async (entry) => {
                    console.log(`rtc-message-router: ${entry.resource}`);

                    const data = JSON.parse(entry.resource) as ALMessage;

                    const handler = rtcInboxCallbacks.get(data.payload.typeId);

                    if (handler) {
                        await handler(data.payload);
                    } else {
                        console.warn(`No handler for typeId: ${data.payload.typeId}`);
                        console.warn(JSON.stringify(data));
                    }
                }
            }
        )
}
