import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type { BlackBoxRallarRuntimeInstallationTarget } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import { decodeBlackBoxRallarConnectionConfig } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts';
import {
    decodeBlackBoxRallarFormationCommandInput,
    decodeBlackBoxRallarFormationRoom,
    type BlackBoxRallarFormationInputIssue
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/formation/decode-black-box-rallar-formation-input.ts';
import type { Either } from '@shared/resilience/Either.ts';

import type {
    RallarBlackBoxBrowserRallarDirectorRuntime,
    RallarBlackBoxBrowserRallarFormationRuntime,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserTestRuntime,
    RallarBlackBoxBrowserWebSocket,
    RallarBlackBoxBrowserWebSocketFactory
} from './browser/browser-command-contracts.ts';

let runtimeImportPromise: Promise<void> | undefined;

export function createSpaBrowserRallarRuntime(): RallarBlackBoxBrowserRallarRuntime {
    return {
        authenticate: async (config) =>
            await (await resolveBrowserRallarRuntime()).authenticate(decodeBlackBoxRallarConnectionConfig(config)),
        connect: async (config) =>
            await (await resolveBrowserRallarRuntime()).connect(decodeBlackBoxRallarConnectionConfig(config)),
        send: async (input) => await (await resolveBrowserRallarRuntime()).send(input),
        sendWs: async (input) => await (await resolveBrowserRallarRuntime()).sendWs(input),
        sendMessage: async (input) => await (await resolveBrowserRallarRuntime()).sendMessage(input),
        observeDelivery: async (input) => await (await resolveBrowserRallarRuntime()).observeDelivery(input),
        cancelDelivery: async (input) => await (await resolveBrowserRallarRuntime()).cancelDelivery(input),
        readReceipts: async (input) => await (await resolveBrowserRallarRuntime()).readReceipts(input),
        injectFault: async (input) => await (await resolveBrowserRallarRuntime()).injectFault(input),
        readStorageCounters: async (input) => await (await resolveBrowserRallarRuntime()).readStorageCounters(input),
        refreshRoom: async (options) => await (await resolveBrowserRallarRuntime()).refreshRoom(options),
        waitForRoom: async (options) => await (await resolveBrowserRallarRuntime()).waitForRoom(options),
        director: createSpaBrowserRallarDirectorRuntime(),
        formation: createSpaBrowserRallarFormationRuntime(),
        close: async () => await (await resolveBrowserRallarRuntime()).close(),
        health: async (input) =>
            await (await resolveBrowserRallarRuntime()).health({
                includeRtcDiagnostics: input?.includeRtcDiagnostics === true
            })
    };
}

export function installSpaBrowserRallarEventBridge(
    runtime: Pick<RallarBlackBoxBrowserTestRuntime, 'receiveRallarBrowserEvent'>
): () => void {
    const targetWindow = readBrowserWindow();
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
        return toRallarBlackBoxBrowserWebSocket(
            new WebSocket(url, typeof protocols === 'string' || protocols === undefined ? protocols : [...protocols])
        );
    };
}

function createSpaBrowserRallarDirectorRuntime(): RallarBlackBoxBrowserRallarDirectorRuntime {
    return {
        appoint: async (input) => await (await resolveBrowserRallarRuntime()).director.appoint(input),
        resign: async (input) => await (await resolveBrowserRallarRuntime()).director.resign(input),
        status: async (input) => await (await resolveBrowserRallarRuntime()).director.status(input),
        relayStart: async (input) => await (await resolveBrowserRallarRuntime()).director.relayStart(input),
        intent: async (input) => await (await resolveBrowserRallarRuntime()).director.intent(input),
        syncRequest: async (input) => await (await resolveBrowserRallarRuntime()).director.syncRequest(input),
        relayStop: async (input) => await (await resolveBrowserRallarRuntime()).director.relayStop(input)
    };
}

function createSpaBrowserRallarFormationRuntime(): RallarBlackBoxBrowserRallarFormationRuntime {
    return {
        command: async (input) => {
            const room = requireDecoded(decodeBlackBoxRallarFormationRoom(input));
            const commandInput = requireDecoded(decodeBlackBoxRallarFormationCommandInput({
                command: input.command,
                ...(input.layout === undefined ? {} : { layout: input.layout }),
                ...(input.landing === undefined ? {} : { landing: input.landing })
            }));
            const reason = typeof input.reason === 'string' ? input.reason : undefined;
            return await (await resolveBrowserRallarRuntime()).formation.command({
                ...room,
                input: commandInput,
                ...(reason === undefined ? {} : { reason })
            });
        },
        readiness: async (input) =>
            await (await resolveBrowserRallarRuntime()).formation.readiness(
                requireDecoded(decodeBlackBoxRallarFormationRoom(input))
            )
    };
}

async function resolveBrowserRallarRuntime(): Promise<BlackBoxRallarRuntime> {
    const targetWindow = readBrowserWindow();
    if (!targetWindow.__blackBoxRallar) {
        runtimeImportPromise ??= import('@shared-test/black-box-runner/browser/rallar-browser-runtime.ts').then(
            () => undefined
        );
        await runtimeImportPromise;
    }
    const runtime = targetWindow.__blackBoxRallar;
    if (!runtime) {
        throw new Error('browser-rallar provider did not expose window.__blackBoxRallar.');
    }
    return runtime;
}

function readBrowserWindow(): BlackBoxRallarRuntimeInstallationTarget {
    if (typeof window === 'undefined') {
        throw new Error('browser-rallar provider requires a browser window.');
    }
    return window;
}

function requireDecoded<T>(decoding: Either<readonly BlackBoxRallarFormationInputIssue[], T>): T {
    return decoding.fold(
        (issues) => {
            const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
            throw new Error(`browser-rallar formation command input is not valid. ${details}`);
        },
        (decoded) => decoded
    );
}

function toRallarBlackBoxBrowserWebSocket(socket: WebSocket): RallarBlackBoxBrowserWebSocket {
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
        send: (data) => {
            socket.send(
                ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : data
            );
        },
        close: (code, reason) => socket.close(code, reason),
        addEventListener: (type, listener) => socket.addEventListener(type, listener),
        removeEventListener: (type, listener) => socket.removeEventListener(type, listener)
    };
}
