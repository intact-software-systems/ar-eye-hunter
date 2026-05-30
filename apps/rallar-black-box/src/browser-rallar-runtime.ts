import type {
    RallarBlackBoxBrowserRallarEvent,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserTestRuntime,
    RallarBlackBoxBrowserWebSocket,
    RallarBlackBoxBrowserWebSocketFactory,
} from '@shared-test/rallar-bb-test/browser-adapter.ts';

type BrowserRallarWindow = Window & Readonly<{
    __blackBoxRallar?: RallarBlackBoxBrowserRallarRuntime;
}> & {
    __blackBoxRallarEmit?: (event: RallarBlackBoxBrowserRallarEvent) => void | Promise<void>;
};

let runtimeImportPromise: Promise<void> | undefined;

function browserWindow(): BrowserRallarWindow {
    if (typeof window === 'undefined') {
        throw new Error('browser-rallar provider requires a browser window.');
    }

    return window as BrowserRallarWindow;
}

async function loadBrowserRallarRuntime(): Promise<void> {
    runtimeImportPromise ??= import(
        '@shared-test/black-box-runner/browser/rallar-browser-runtime.ts'
    ).then(() => undefined);
    await runtimeImportPromise;
}

async function resolveBrowserRallarRuntime(): Promise<RallarBlackBoxBrowserRallarRuntime> {
    const targetWindow = browserWindow();
    if (!targetWindow.__blackBoxRallar) {
        await loadBrowserRallarRuntime();
    }

    const runtime = targetWindow.__blackBoxRallar;
    if (!runtime) {
        throw new Error('browser-rallar provider did not expose window.__blackBoxRallar.');
    }

    return runtime;
}

export function createSpaBrowserRallarRuntime(): RallarBlackBoxBrowserRallarRuntime {
    return {
        async connect(config) {
            return await (await resolveBrowserRallarRuntime()).connect(config);
        },
        async send(input) {
            return await (await resolveBrowserRallarRuntime()).send(input);
        },
        async sendWs(input) {
            return await (await resolveBrowserRallarRuntime()).sendWs?.(input);
        },
        async close() {
            return await (await resolveBrowserRallarRuntime()).close();
        },
        async health() {
            return await (await resolveBrowserRallarRuntime()).health();
        },
    };
}

export function installSpaBrowserRallarEventBridge(
    runtime: RallarBlackBoxBrowserTestRuntime,
): () => void {
    const targetWindow = browserWindow();
    const previous = targetWindow.__blackBoxRallarEmit;
    targetWindow.__blackBoxRallarEmit = event => runtime.receiveRallarBrowserEvent(event);
    return () => {
        targetWindow.__blackBoxRallarEmit = previous;
    };
}

export function createBrowserWebSocketFactory(): RallarBlackBoxBrowserWebSocketFactory {
    return (url, protocols) => {
        if (typeof WebSocket === 'undefined') {
            throw new Error('WebSocket is not available for browser-rallar WebSocket commands.');
        }

        return new WebSocket(
            url,
            protocols as string | string[] | undefined,
        ) as RallarBlackBoxBrowserWebSocket;
    };
}
