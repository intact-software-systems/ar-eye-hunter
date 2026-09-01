import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type { BlackBoxRallarRuntimeInstallationTarget } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import { isBlackBoxCommandRecord } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import { decodeBlackBoxRallarConnectionConfig } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts';
import type {
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserTestRuntime,
    RallarBlackBoxBrowserWebSocketFactory
} from './browser-adapter.ts';

let runtimeImportPromise: Promise<void> | undefined;

function browserWindow(): BlackBoxRallarRuntimeInstallationTarget {
    if (typeof window === 'undefined') {
        throw new Error('browser-rallar provider requires a browser window.');
    }

    return window;
}

async function loadBrowserRallarRuntime(): Promise<void> {
    runtimeImportPromise ??= import(
        '@shared-test/black-box-runner/browser/rallar-browser-runtime.ts'
    ).then(() => undefined);
    await runtimeImportPromise;
}

async function resolveBrowserRallarRuntime(): Promise<BlackBoxRallarRuntime> {
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

async function resolveBrowserRallarDirectorRuntime(): Promise<
    NonNullable<RallarBlackBoxBrowserRallarRuntime['director']>
> {
    const runtime = await resolveBrowserRallarRuntime();
    if (!runtime.director) {
        throw new Error('browser-rallar provider did not expose director runtime commands.');
    }
    return runtime.director;
}

export function createSpaBrowserRallarRuntime(): RallarBlackBoxBrowserRallarRuntime {
    return {
        async authenticate(config) {
            const runtime = await resolveBrowserRallarRuntime();
            if (!runtime.authenticate) {
                throw new Error('browser-rallar provider did not expose authenticate.');
            }
            return await runtime.authenticate(decodeBlackBoxRallarConnectionConfig(config));
        },
        async connect(config) {
            return await (await resolveBrowserRallarRuntime()).connect(decodeBlackBoxRallarConnectionConfig(config));
        },
        async send(input) {
            return await (await resolveBrowserRallarRuntime()).send(input);
        },
        async sendWs(input) {
            return await (await resolveBrowserRallarRuntime()).sendWs?.(input);
        },
        async refreshRoom(options) {
            return await (await resolveBrowserRallarRuntime()).refreshRoom(options);
        },
        director: {
            async appoint(input) {
                return await (await resolveBrowserRallarDirectorRuntime()).appoint(input);
            },
            async resign(input) {
                return await (await resolveBrowserRallarDirectorRuntime()).resign(input);
            },
            async status(input) {
                return await (await resolveBrowserRallarDirectorRuntime()).status(input);
            },
            async relayStart(input) {
                return await (await resolveBrowserRallarDirectorRuntime()).relayStart(input);
            },
            async intent(input) {
                return await (await resolveBrowserRallarDirectorRuntime()).intent(input);
            },
            async syncRequest(input) {
                return await (await resolveBrowserRallarDirectorRuntime()).syncRequest(input);
            },
            async relayStop(input) {
                return await (await resolveBrowserRallarDirectorRuntime()).relayStop(input);
            }
        },
        async close() {
            return await (await resolveBrowserRallarRuntime()).close();
        },
        async health(input?: unknown) {
            return await (await resolveBrowserRallarRuntime()).health({
                includeRtcDiagnostics: isBlackBoxCommandRecord(input) && input.includeRtcDiagnostics === true
            });
        }
    };
}

export function installSpaBrowserRallarEventBridge(
    runtime: Pick<RallarBlackBoxBrowserTestRuntime, 'receiveRallarBrowserEvent'>
): () => void {
    const targetWindow = browserWindow();
    const previous = targetWindow.__blackBoxRallarEmit;
    targetWindow.__blackBoxRallarEmit = (event) =>
        runtime.receiveRallarBrowserEvent({
            ...event,
            roomRef: event.roomRef ? { ...event.roomRef } : undefined,
            scope: event.scope ? { ...event.scope } : undefined
        });
    return () => {
        targetWindow.__blackBoxRallarEmit = previous;
    };
}

export function createBrowserWebSocketFactory(): RallarBlackBoxBrowserWebSocketFactory {
    return (url, protocols) => {
        if (typeof WebSocket === 'undefined') {
            throw new Error('WebSocket is not available for browser-rallar WebSocket commands.');
        }

        const socket = new WebSocket(
            url,
            typeof protocols === 'string' ? protocols : protocols ? [...protocols] : undefined
        );
        return {
            get readyState() {
                return socket.readyState;
            },
            get protocol() {
                return socket.protocol;
            },
            get url() {
                return socket.url;
            },
            get bufferedAmount() {
                return socket.bufferedAmount;
            },
            send(data) {
                if (ArrayBuffer.isView(data)) {
                    socket.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
                    return;
                }
                if (
                    typeof data === 'string' || data instanceof ArrayBuffer || data instanceof Blob
                ) {
                    socket.send(data);
                    return;
                }
                throw new TypeError('Browser WebSocket data must be text, Blob, or binary bytes.');
            },
            close: (code, reason) => socket.close(code, reason),
            addEventListener: (type, listener) => socket.addEventListener(type, listener),
            removeEventListener: (type, listener) => socket.removeEventListener(type, listener)
        };
    };
}
