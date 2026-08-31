import { toError } from '@shared/resilience/to-error.ts';

import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarEvent,
    BlackBoxRallarTransport
} from './black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarScopeDiagnostics } from './black-box-rallar-operation-policy.ts';
import { toBlackBoxRallarSerializedError } from './black-box-rallar-serialized-error.ts';

interface ConsoleWarning {
    readonly topic: string;
    readonly transport: BlackBoxRallarTransport | 'ws';
    readonly message: string;
}

interface RuntimeEventContext extends BlackBoxRallarScopeDiagnostics {
    readonly connection: string;
    readonly actor: string | undefined;
    readonly transport: BlackBoxRallarTransport;
    readonly roomId: string | undefined;
    readonly laneId: string;
}

export namespace BlackBoxRallarRuntimeDiagnostics {
    export interface Input {
        now(): number;
        publish(event: BlackBoxRallarEvent): void | Promise<void>;
        onPublishError(error: Error): void;
        transportOf(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport;
        laneIdOf(config: BlackBoxRallarConnectionConfig): string;
        scopeDiagnostics(config: BlackBoxRallarConnectionConfig): BlackBoxRallarScopeDiagnostics;
    }
    export interface ErrorInput {
        readonly config: BlackBoxRallarConnectionConfig | undefined;
        readonly topic: string;
        readonly error: Error;
        readonly data?: object;
    }
}

export class BlackBoxRallarRuntimeDiagnostics {
    readonly #input: BlackBoxRallarRuntimeDiagnostics.Input;
    constructor(input: BlackBoxRallarRuntimeDiagnostics.Input) {
        this.#input = input;
    }

    emit = (event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void => {
        try {
            void Promise.resolve(this.#input.publish({ ...event, atEpochMs: this.#input.now() }))
                .catch((caught) => this.#input.onPublishError(toError(caught)));
        }
        catch (caught) {
            this.#input.onPublishError(toError(caught));
        }
    };

    emitDiagnostic = (config: BlackBoxRallarConnectionConfig, topic: string, data?: object): void => {
        this.emit({ kind: 'diagnostic', topic, ...this.context(config), data });
    };

    emitError = (input: BlackBoxRallarRuntimeDiagnostics.ErrorInput): void => {
        this.emit({
            kind: 'diagnostic',
            topic: input.topic,
            ...(input.config ? this.context(input.config) : {}),
            data: input.data,
            error: toBlackBoxRallarSerializedError(input.error)
        });
    };

    emitConnectPhaseStarted = (config: BlackBoxRallarConnectionConfig, phase: string, data?: object): void => {
        this.emitDiagnostic(config, 'rallar.browser.connect.phase_started', { phase, ...data });
    };

    emitConnectPhaseCompleted = (config: BlackBoxRallarConnectionConfig, phase: string, data?: object): void => {
        this.emitDiagnostic(config, 'rallar.browser.connect.phase_completed', { phase, ...data });
    };

    emitConsoleWarning = (config: BlackBoxRallarConnectionConfig, args: readonly unknown[]): void => {
        const warning = classifyConsoleWarning(args);
        if (!warning) {
            return;
        }
        this.emit({
            kind: 'diagnostic',
            ...this.context(config),
            topic: warning.topic,
            transport: warning.transport,
            severity: 'warning',
            data: { message: warning.message, args }
        });
    };

    private context(config: BlackBoxRallarConnectionConfig): RuntimeEventContext {
        return {
            connection: config.connection,
            actor: config.actor,
            transport: this.#input.transportOf(config),
            roomId: config.roomId,
            ...this.#input.scopeDiagnostics(config),
            laneId: this.#input.laneIdOf(config)
        };
    }
}

function consoleWarningPart(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}

function classifyConsoleWarning(args: readonly unknown[]): ConsoleWarning | undefined {
    const message = args.map(consoleWarningPart).join(' ');
    if (message.includes('Unhandled WS message') || message.includes('No callback for typeId')) {
        return { topic: 'rallar.browser.ws.unhandled_message', transport: 'ws', message };
    }
    if (
        message.includes('Received data channel for different data channel name') ||
        message.includes('does not match peerId') ||
        message.includes('No channel for peer') || message.includes('Ignoring self-connection attempt')
    ) {
        return { topic: 'rallar.browser.rtc.data_channel_warning', transport: 'realtime', message };
    }
    return undefined;
}

interface ConsoleTarget {
    warn(...args: unknown[]): void;
}

export interface BlackBoxRallarConsoleDiagnostics<TConfig> {
    install(config: TConfig): () => void;
    close(): void;
}

export interface BlackBoxRallarConsoleDiagnosticsOptions<TConfig> {
    readonly console: ConsoleTarget;
    activeConfig(): TConfig | undefined;
    onWarning(config: TConfig, args: readonly unknown[]): void;
    restoreExisting?(): void;
    publishRestore?(restore: (() => void) | undefined): void;
}

export function createBlackBoxRallarConsoleDiagnostics<TConfig>(
    options: BlackBoxRallarConsoleDiagnosticsOptions<TConfig>
): BlackBoxRallarConsoleDiagnostics<TConfig> {
    const configs = new Map<symbol, TConfig>();
    let restore: (() => void) | undefined;
    const restorePatch = (): void => {
        restore?.();
    };
    const ensurePatch = (): void => {
        if (restore) {
            return;
        }
        options.restoreExisting?.();
        const previousWarn = options.console.warn;
        options.console.warn = (...args: unknown[]) => {
            previousWarn(...args);
            const active = options.activeConfig() ?? [...configs.values()].at(-1);
            if (active !== undefined) {
                options.onWarning(active, args);
            }
        };
        restore = () => {
            options.console.warn = previousWarn;
            restore = undefined;
            configs.clear();
            options.publishRestore?.(undefined);
        };
        options.publishRestore?.(restorePatch);
    };
    return {
        install: (config) => {
            const token = Symbol('black-box-rallar-console-diagnostics');
            configs.set(token, config);
            ensurePatch();
            return () => {
                configs.delete(token);
                if (configs.size === 0 && options.activeConfig() === undefined) {
                    restorePatch();
                }
            };
        },
        close: restorePatch
    };
}
