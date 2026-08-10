export const myProcessInstanceId = crypto.randomUUID();
export const myPublisherId = myProcessInstanceId;
export const myRtcTopologyStreamId = myProcessInstanceId;
export const myServerId = `server-${myProcessInstanceId.substring(0, 8)}`;
