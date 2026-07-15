export type BlackBoxRallarDiagnostics<TEvent extends Readonly<{ atEpochMs: number }>> = Readonly<{
    emit(event: Omit<TEvent, 'atEpochMs'>): void;
}>;

export function createBlackBoxRallarDiagnostics<TEvent extends Readonly<{ atEpochMs: number }>>(
    options: Readonly<{
        now(): number;
        emit(event: TEvent): void;
    }>,
): BlackBoxRallarDiagnostics<TEvent> {
    return {
        emit: event =>
            options.emit({
                ...event,
                atEpochMs: options.now(),
            } as TEvent),
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
    }>,
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
        install: config => {
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
        close: () => restorePatch(),
    };
}
