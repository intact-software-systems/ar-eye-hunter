import { WsQueueBoxServerService } from "@shared/services/WsQueueBoxServerService.ts";
import { tryRunInIntervals } from "@shared/resilience/TryWith.ts";
import { toALMessage } from "@shared/al-contracts/al-contract.ts";
import { AppTopics, ClientData } from "@shared/api/api-config.ts";
import * as clientRepository from "./repository/client-repository.ts";
import { myServerId } from "./utils/config-repo.ts";

const intervalMsecs = 60000;

export async function initHeartbeat(
    ws: WsQueueBoxServerService
) {
    await tryRunInIntervals(
        async () => {
            await ws.enqueueOutboxIfAbsent(
                toALMessage<ClientData[]>(
                    myServerId,
                    AppTopics.clients,
                    clientRepository.readAllOnlineClients()
                )
            )
        },
        intervalMsecs
    )
}