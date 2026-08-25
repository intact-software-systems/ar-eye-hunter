import { BrowserCallSessionRuntime } from '@shared-web/browser/calls/browser-call-session-runtime.ts';
import type { RallarCallHandle, RallarCallStartInput } from '@shared-web/browser/rallar-calls-facade.ts';

/** Starts call sessions after the browser connection is ready. */
export class BrowserCallLifecycleRuntime {
    private readonly input: BrowserCallSessionRuntime.Input;

    public constructor(input: BrowserCallSessionRuntime.Input) {
        this.input = input;
    }

    public async start(input: RallarCallStartInput): Promise<RallarCallHandle> {
        await this.input.connect();
        return await new BrowserCallSessionRuntime(this.input, input).start();
    }
}
