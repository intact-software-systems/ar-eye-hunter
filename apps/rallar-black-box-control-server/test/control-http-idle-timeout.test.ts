import { expect, test } from 'bun:test';

import { CONTROL_HTTP_IDLE_TIMEOUT_SECONDS } from '../src/http/control-http-idle-timeout-seconds.ts';
import { RESULT_RELEASE_ACK_TIMEOUT_MS } from '../src/routes/agent-routes-write.ts';

const BUN_DEFAULT_IDLE_TIMEOUT_SECONDS = 10;

test('a result release waiting the full agent acknowledgement window keeps its HTTP connection', () => {
    expect({
        outlastsAckWait: CONTROL_HTTP_IDLE_TIMEOUT_SECONDS * 1000 > RESULT_RELEASE_ACK_TIMEOUT_MS,
        outlastsBunDefault: CONTROL_HTTP_IDLE_TIMEOUT_SECONDS > BUN_DEFAULT_IDLE_TIMEOUT_SECONDS
    }).toEqual({ outlastsAckWait: true, outlastsBunDefault: true });
});
