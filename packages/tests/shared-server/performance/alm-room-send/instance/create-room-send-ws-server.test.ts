import { describe, expect, it } from 'vitest';

import { toRoomSendStoreNamespace } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/instance/create-room-send-ws-server.ts';

describe('toRoomSendStoreNamespace', () => {
    it('names the run\'s stores by the API\'s store id of its WS runtime and the run\'s id', () => {
        expect(toRoomSendStoreNamespace('0f0e0d0c-0b0a-4908-8706-050403020100'))
            .toBe('server-ws-qbox:default-qbox-server:0f0e0d0c-0b0a-4908-8706-050403020100');
    });
});
