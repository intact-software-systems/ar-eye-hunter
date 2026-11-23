import { describe, expect, it } from 'vitest';

import {
    TWO_AGENT_CONNECT_STAGE_WAIT_MS,
    TWO_AGENT_DELIVERY_SMOKE_TEST_TIMEOUT_MS,
    TWO_AGENT_RELOAD_SMOKE_TEST_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/two-agent-smoke-test-timeouts.ts';

describe('two-agent smoke test timeouts', () => {
    it('waits for a connect stage its 135 s connect, its 30 s readiness and the 45 s result poll', () => {
        expect(TWO_AGENT_CONNECT_STAGE_WAIT_MS).toBe(135_000 + 30_000 + 45_000);
    });

    // The delivery smoke's 75 s besides its connects held two deliveries that may take 30 s and 45 s each.
    it('gives the delivery smoke its connects, two deliveries and the evidence poll', () => {
        expect(TWO_AGENT_DELIVERY_SMOKE_TEST_TIMEOUT_MS).toBe(60_000 + 210_000 + 2 * (30_000 + 45_000) + 20_000);
    });

    // The reload smoke's 90 s besides its connects held three deliveries and a reload of up to 315 s.
    it('gives the reload smoke both connect stages, three deliveries, the reload and the evidence poll', () => {
        expect(TWO_AGENT_RELOAD_SMOKE_TEST_TIMEOUT_MS).toBe(
            60_000 + 210_000 + (30_000 + 45_000) + 2 * 30_000 + 210_000 + 2 * (45_000 + 45_000) + 20_000
        );
    });
});
