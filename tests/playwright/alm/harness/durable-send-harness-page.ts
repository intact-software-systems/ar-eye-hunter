import { createDurableSendHarness } from './create-durable-send-harness.ts';
import { DURABLE_SEND_HARNESS_GLOBAL } from './durable-send-harness-contract.ts';

Reflect.set(
    globalThis,
    DURABLE_SEND_HARNESS_GLOBAL,
    await createDurableSendHarness(crypto.randomUUID())
);
