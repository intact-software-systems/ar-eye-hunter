import { WebRtcQueueBoxClientService } from "./WebRtcQueueBoxClientService.ts";

// support connect to peers in group, etc.
// fault tolerance to group accept/connect, if not peer available, etc.

// Updates on clients online/offline
// Maintain the peer-connected lists

// ALM: group multicast over WebSocket
export class WebRtcGroupService {

    constructor(
        public readonly rtcQBox: WebRtcQueueBoxClientService
    ) {}


}