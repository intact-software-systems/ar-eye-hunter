import { createDurableSendHarness } from './create-durable-send-harness.ts';
import {
    DURABLE_SEND_HARNESS_GLOBAL,
    DURABLE_SEND_PLAN_PARAMETER,
    DURABLE_SEND_PLANS
} from './durable-send-harness-contract.ts';

const plan = DURABLE_SEND_PLANS.find((candidate) =>
    candidate === new URLSearchParams(location.search).get(DURABLE_SEND_PLAN_PARAMETER)
);
if (plan === undefined) {
    throw new Error(
        `The harness page names no plan in its "${DURABLE_SEND_PLAN_PARAMETER}" parameter`
    );
}

Reflect.set(
    globalThis,
    DURABLE_SEND_HARNESS_GLOBAL,
    await createDurableSendHarness(crypto.randomUUID(), plan)
);
