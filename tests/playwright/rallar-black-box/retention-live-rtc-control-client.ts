import { releaseControlResults } from '@shared-test/rallar-bb-test/result-release/release-control-results.ts';

import { LiveRtcControlClient } from './live-rtc-control-client.ts';

/** This diagnostic caller consumes results from server artifacts and ends runtime references after each command. */
export class RetentionLiveRtcControlClient extends LiveRtcControlClient {
    private readonly dependencies: LiveRtcControlClient.Dependencies;
    private readonly releaseAfterCapture: boolean;
    private releaseSequence = 0;

    constructor(dependencies: LiveRtcControlClient.Dependencies, releaseAfterCapture: boolean) {
        super(dependencies);
        this.dependencies = dependencies;
        this.releaseAfterCapture = releaseAfterCapture;
    }

    override async executeResult(command: LiveRtcControlClient.ExecuteInput): Promise<LiveRtcControlClient.Result> {
        const result = await super.executeResult(command);
        if (!this.releaseAfterCapture || command.command.kind === 'agent.reload') {
            return result;
        }
        const released = await releaseControlResults({
            controlBaseUrl: this.dependencies.baseUrl,
            runId: command.runId,
            agentId: command.agentId,
            requestId: `retention-release-${++this.releaseSequence}-${command.commandId}`,
            commandIds: [command.commandId],
            token: undefined
        }, this.fetchControl);
        if (released.left !== undefined) {
            throw new Error(released.left);
        }
        return result;
    }

    private readonly fetchControl: typeof globalThis.fetch = async (url, init) => {
        const response = await this.dependencies.request.fetch(String(url), {
            method: init?.method,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            data: typeof init?.body === 'string' ? init.body : undefined
        });
        try {
            return new Response(await response.text(), { status: response.status(), headers: response.headers() });
        }
        finally {
            await response.dispose();
        }
    };
}
