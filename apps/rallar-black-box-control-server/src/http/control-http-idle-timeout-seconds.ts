import { computeHttpIdleTimeoutSeconds } from '@shared-server/http/compute-http-idle-timeout-seconds.ts';

import { RESULT_RELEASE_ACK_TIMEOUT_MS } from '../routes/agent-routes-write.ts';

/** The result release is the longest wait a control route holds open. */
export const CONTROL_HTTP_IDLE_TIMEOUT_SECONDS = computeHttpIdleTimeoutSeconds(RESULT_RELEASE_ACK_TIMEOUT_MS);
