import {ALMessage} from "@shared/al-contracts/al-contract.ts";
import {webSocketQueueBox} from "./ws-engine.ts";
import {ApiConfig, ChatTopicId, ClientData, ClientTopicId, RtcSignalingTopicId} from "@shared/api/api-config.ts";
import {postClientData, readApiConfig, readClients} from "./api-integration.ts";
import {appClientData} from "./config.ts";

//------------------------------------------
// Config from Api
//------------------------------------------

export const apiConfig: ApiConfig = await readApiConfig();

export function toCreateWsEndpoint(id: string) {
    return apiConfig.wsBaseUrl + apiConfig.endpoints.createWs.replace(":id", id);
}

//------------------------------------------
// Data caches
//------------------------------------------

export const chatMessageById = new Map<string, ALMessage>();
export const clientDataById = new Map<string, ClientData>();

await initClientData()

async function initClientData() {

    await postClientData(appClientData)

    const clientsFromApi: ClientData[] = await readClients()

    for (const client of clientsFromApi) {
        clientDataById.set(client.clientId, client)
    }
}

webSocketQueueBox
    .onInboxMessageDo(
        "ws-data-cache-router",
        {
            onMessage: (entry) => {
                console.log(`ws-data-cache-router: ${entry.resource}`);

                const data = JSON.parse(entry.resource) as ALMessage;

                switch (data.payload.typeId) {
                    case ChatTopicId: {
                        chatMessageById.set(data.id.sender, data)
                        break;
                    }
                    case ClientTopicId: {
                        const client = JSON.parse(data.payload.resource) as ClientData;
                        clientDataById.set(client.clientId, client)

                        if(client.clientId === appClientData.clientId) {
                            console.log('Received my own client data. Ignoring it')
                        }
                        else {
                            // TODO: Connect RTC to new client

                        }

                        break;
                    }
                    case RtcSignalingTopicId:
                        break
                }

                return Promise.resolve();
            }
        }
    )
