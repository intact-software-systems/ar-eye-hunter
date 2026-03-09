import { tryRunInIntervals } from "@shared/resilience/TryWith.ts";
import { toALMessage } from "@shared/al-contracts/al-contract.ts";
import { WsQueueBoxClientService } from "@shared/services/WsQueueBoxClientService.ts";
import { AppTopics, ClientData } from "@shared/api/api-config.ts";

const intervalMsecs = 60000;

export async function initHeartbeat(
    webSocketQueueBox: WsQueueBoxClientService,
    clientData: ClientData
) {
    await tryRunInIntervals(
        () => {
            webSocketQueueBox.enqueueOutboxIfAbsent(
                toALMessage<ClientData>(
                    clientData.sessionId,
                    AppTopics.client,
                    clientData
                )
            )
            console.log(`Sent heartbeat to server: ${JSON.stringify(clientData)}`)
        },
        intervalMsecs,
    )
}