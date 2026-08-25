import type { RallarMessagesController } from '@shared-web/browser/messages/browser-rallar-messages-controller.ts';
import type {
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle
} from '@shared-web/browser/rallar-director-facade.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { BrowserDirectorRelaySession } from './browser-director-relay-session.ts';
import type { BrowserDirectorRelayTransport } from './browser-director-relay-transport.ts';
import type { BrowserDirectorStatusRuntime } from './browser-director-status-runtime.ts';

export interface BrowserDirectorRelayRuntimeInput {
    readonly status: BrowserDirectorStatusRuntime;
    readonly transport: BrowserDirectorRelayTransport;
    readonly messages: RallarMessagesController['operations'];
    readonly realtime: RallarRealtimeFacade;
    readSession(): AuthSession | undefined;
}

export class BrowserDirectorRelayRuntime {
    private readonly input: BrowserDirectorRelayRuntimeInput;
    private readonly stops = new Set<() => void>();

    public constructor(input: BrowserDirectorRelayRuntimeInput) {
        this.input = input;
    }

    public create<TIntent, TOutput, TSnapshot = TOutput>(
        config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>
    ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
        const session = new BrowserDirectorRelaySession({
            ...this.input,
            config,
            onStop: (stop) => this.stops.delete(stop)
        });
        this.stops.add(session.stop);
        return session.start();
    }

    public stopAll(): void {
        const stops = [...this.stops];
        this.stops.clear();
        for (const stop of stops) {
            runShutdownStep(stop);
        }
    }
}

function runShutdownStep(step: () => void): void {
    try {
        step();
    }
    catch {
        // Relay teardown remains best-effort during transport shutdown.
    }
}
