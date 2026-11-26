import { describe, expect, it } from 'vitest';

import { toOrderedSendStoreNamespace } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/create-ordered-send-ws-server.ts';

describe('toOrderedSendStoreNamespace', () => {
    it('names the run\'s stores by the API\'s store id of its WS runtime and the run\'s id', () => {
        expect(toOrderedSendStoreNamespace('0f0e0d0c-0b0a-4908-8706-050403020100'))
            .toBe('server-ws-qbox:default-qbox-server:0f0e0d0c-0b0a-4908-8706-050403020100');
    });
});
