import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestState
} from '../../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '../../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

/** UI fixtures preserve their authored event identities and timestamps while supplying complete current runtime facts. */
export function createRuntimeStateFixture(events: readonly RallarBlackBoxTestEvent[] = []): RallarBlackBoxTestState {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    for (const event of events) {
        runtime.recordEvent(event);
    }
    return { ...runtime.state(), events };
}
