export type BlackBoxRallarDiagnostics<TEvent extends Readonly<{ atEpochMs: number; }>> = Readonly<{
    emit(event: Omit<TEvent, 'atEpochMs'>): void;
}>;

export function createBlackBoxRallarDiagnostics<TEvent extends Readonly<{ atEpochMs: number; }>>(
    options: Readonly<{
        now(): number;
        emit(event: TEvent): void;
    }>
): BlackBoxRallarDiagnostics<TEvent> {
    return {
        emit: (event) =>
            options.emit({
                ...event,
                atEpochMs: options.now()
            } as TEvent)
    };
}

type ScopeDiagnostics = Readonly<{
    scope?: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }>;
    applicationId?: string;
    workspaceId?: string;
}>;

export type BlackBoxRallarRuntimeDiagnostics = Readonly<{
    emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
    emitDiagnostic(config: BlackBoxRallarConnectionConfig, topic: string, data?: unknown): void;
    emitError(
        config: BlackBoxRallarConnectionConfig | undefined,
        topic: string,
        error: unknown,
        data?: unknown
    ): void;
    emitConnectPhaseStarted(config: BlackBoxRallarConnectionConfig, phase: string, data?: unknown): void;
    emitConnectPhaseCompleted(config: BlackBoxRallarConnectionConfig, phase: string, data?: unknown): void;
    emitConsoleWarning(config: BlackBoxRallarConnectionConfig, args: readonly unknown[]): void;
    serializeError(error: unknown): unknown;
}>;

export function serializeBlackBoxRallarError(error: unknown): unknown {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    }
    return error;
}

function diagnosticObject(data?: unknown): Record<string, unknown> {
    return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { data };
}

function consoleWarningPart(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}

function classifyConsoleWarning(args: readonly unknown[]):
    | Readonly<{
        topic: string;
        transport: BlackBoxRallarTransport | 'ws';
        message: string;
    }>
    | undefined {
    const message = args.map(consoleWarningPart).join(' ');
    if (message.includes('Unhandled WS message') || message.includes('No callback for typeId')) {
        return {
            topic: 'rallar.browser.ws.unhandled_message',
            transport: 'ws',
            message
        };
    }
    if (
        message.includes('Received data channel for different data channel name') ||
        message.includes('does not match peerId') ||
        message.includes('No channel for peer') ||
        message.includes('Ignoring self-connection attempt')
    ) {
        return {
            topic: 'rallar.browser.rtc.data_channel_warning',
            transport: 'realtime',
            message
        };
    }
    return undefined;
}

export function createBlackBoxRallarRuntimeDiagnostics(
    options: Readonly<{
        now(): number;
        publish(event: BlackBoxRallarEvent): void | Promise<void>;
        onPublishError(error: unknown): void;
        transportOf(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport;
        laneIdOf(config: BlackBoxRallarConnectionConfig): string;
        scopeDiagnostics(config: BlackBoxRallarConnectionConfig): ScopeDiagnostics;
    }>
): BlackBoxRallarRuntimeDiagnostics {
    const events = createBlackBoxRallarDiagnostics<BlackBoxRallarEvent>({
        now: options.now,
        emit: (event) => {
            try {
                void Promise.resolve(options.publish(event)).catch(options.onPublishError);
            }
            catch (error) {
                options.onPublishError(error);
            }
        }
    });
    const emit = events.emit;
    const emitDiagnostic = (
        config: BlackBoxRallarConnectionConfig,
        topic: string,
        data?: unknown
    ): void => {
        emit({
            kind: 'diagnostic',
            topic,
            connection: config.connection,
            actor: config.actor,
            transport: options.transportOf(config),
            roomId: config.roomId,
            ...options.scopeDiagnostics(config),
            laneId: options.laneIdOf(config),
            data
        });
    };
    const emitError = (
        config: BlackBoxRallarConnectionConfig | undefined,
        topic: string,
        error: unknown,
        data?: unknown
    ): void => {
        emit({
            kind: 'diagnostic',
            topic,
            connection: config?.connection,
            actor: config?.actor,
            transport: config ? options.transportOf(config) : undefined,
            roomId: config?.roomId,
            ...(config ? options.scopeDiagnostics(config) : {}),
            laneId: config ? options.laneIdOf(config) : undefined,
            data,
            error: serializeBlackBoxRallarError(error)
        });
    };
    return {
        emit,
        emitDiagnostic,
        emitError,
        emitConnectPhaseStarted: (config, phase, data) => {
            emitDiagnostic(config, 'rallar.browser.connect.phase_started', {
                phase,
                ...diagnosticObject(data)
            });
        },
        emitConnectPhaseCompleted: (config, phase, data) => {
            emitDiagnostic(config, 'rallar.browser.connect.phase_completed', {
                phase,
                ...diagnosticObject(data)
            });
        },
        emitConsoleWarning: (config, args) => {
            const classified = classifyConsoleWarning(args);
            if (!classified) {
                return;
            }
            emit({
                kind: 'diagnostic',
                topic: classified.topic,
                connection: config.connection,
                actor: config.actor,
                transport: classified.transport,
                severity: 'warning',
                roomId: config.roomId,
                ...options.scopeDiagnostics(config),
                data: {
                    message: classified.message,
                    args
                }
            });
        },
        serializeError: serializeBlackBoxRallarError
    };
}

type ConsoleTarget = {
    warn(...args: unknown[]): void;
};

export type BlackBoxRallarConsoleDiagnostics<TConfig> = Readonly<{
    install(config: TConfig): () => void;
    close(): void;
}>;

export function createBlackBoxRallarConsoleDiagnostics<TConfig>(
    options: Readonly<{
        console: ConsoleTarget;
        activeConfig(): TConfig | undefined;
        onWarning(config: TConfig, args: readonly unknown[]): void;
        restoreExisting?(): void;
        publishRestore?(restore: (() => void) | undefined): void;
    }>
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
        close: () => restorePatch()
    };
}
import type { BlackBoxRallarConnectionConfig, BlackBoxRallarEvent, BlackBoxRallarTransport } from './contracts.ts';
