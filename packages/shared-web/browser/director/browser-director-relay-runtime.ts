import type {
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { BrowserDirectorRelaySession } from './browser-director-relay-session.ts';
import type { BrowserDirectorRelayTransport } from './browser-director-relay-transport.ts';
import type { BrowserDirectorStatusRuntime } from './browser-director-status-runtime.ts';

export namespace BrowserDirectorRelayRuntime {
    export interface Input {
        readonly status: BrowserDirectorStatusRuntime;
        readonly transport: BrowserDirectorRelayTransport;
        readonly messages: RallarMessagesOperations;
        readonly realtime: RallarRealtimeFacade;
        readSession(): AuthSession | undefined;
    }
}

export class BrowserDirectorRelayRuntime {
    private readonly input: BrowserDirectorRelayRuntime.Input;
    private readonly stops = new Set<() => void>();

    public constructor(input: BrowserDirectorRelayRuntime.Input) {
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
