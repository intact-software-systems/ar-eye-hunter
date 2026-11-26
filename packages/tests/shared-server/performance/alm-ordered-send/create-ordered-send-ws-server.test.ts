import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
    API_V1_DEFAULT_QUEUE_RESILIENCE,
    ORDERED_SEND_SERVER_PEER_ID,
    toOrderedSendStoreNamespace
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/create-ordered-send-ws-server.ts';

const API_V1_ROOT = new URL('../../../../../apps/api-v1/', import.meta.url);

describe('the ordered-send WS server\'s copies of the API\'s own values', () => {
    it('takes the circuit breaker of the API\'s queues as the API\'s default configuration states it', () => {
        const defaults = JSON.parse(
            readFileSync(new URL('resources/configuration/defaults-config.json', API_V1_ROOT), 'utf8')
        );

        expect(API_V1_DEFAULT_QUEUE_RESILIENCE).toEqual(defaults.topology.queueResilience);
    });

    // The composition root states the name as a literal and exports no constant of it: this reads its text until
    // it exports one, and the cell then takes the constant.
    it('answers as the peer id the API\'s composition root gives its WS runtime', () => {
        const compositionRoot = readFileSync(
            new URL('src/composition/create-default-rallar-server.ts', API_V1_ROOT),
            'utf8'
        );

        expect(compositionRoot).toContain(`wsRuntimeName: '${ORDERED_SEND_SERVER_PEER_ID}'`);
    });
});

describe('toOrderedSendStoreNamespace', () => {
    it('names the run\'s stores by the API\'s store id of its WS runtime and the run\'s id', () => {
        expect(toOrderedSendStoreNamespace('0f0e0d0c-0b0a-4908-8706-050403020100'))
            .toBe('server-ws-qbox:default-qbox-server:0f0e0d0c-0b0a-4908-8706-050403020100');
    });
});
