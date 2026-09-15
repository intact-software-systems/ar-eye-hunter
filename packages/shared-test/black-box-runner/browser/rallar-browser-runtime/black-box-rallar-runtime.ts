import { BlackBoxRallarConnectionRuntime } from './black-box-rallar-connection-runtime.ts';
import type {
    BlackBoxRallarEvent
} from './black-box-rallar-operation-contracts.ts';
import type {
    BlackBoxRallarRuntime
} from './black-box-rallar-runtime-contract.ts';
import {
    createBlackBoxBrowserRallarRuntimeDependency
} from './browser-rallar-runtime-composition.ts';
export type {
    BlackBoxRallarAuthenticateDiagnostics,
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConfig,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarCrdtApplyInput,
    BlackBoxRallarCrdtCommandDiagnostics,
    BlackBoxRallarCrdtHandleInput,
    BlackBoxRallarCrdtOpenInput,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarCrdtRuntimeSummary,
    BlackBoxRallarCrdtSyncInput,
    BlackBoxRallarCrdtUndoRedoInput,
    BlackBoxRallarCrdtWaitCondition,
    BlackBoxRallarCrdtWaitInput,
    BlackBoxRallarCrdtWaitOperator,
    BlackBoxRallarDeliveryObservation,
    BlackBoxRallarDirectorAppointInput,
    BlackBoxRallarDirectorCommandDiagnostics,
    BlackBoxRallarDirectorHandleInput,
    BlackBoxRallarDirectorIntentInput,
    BlackBoxRallarDirectorOutputRecord,
    BlackBoxRallarDirectorRelayStartInput,
    BlackBoxRallarDirectorRelaySummary,
    BlackBoxRallarDirectorRoomInput,
    BlackBoxRallarDirectorRuntime,
    BlackBoxRallarDirectorStatusInput,
    BlackBoxRallarDirectorSyncRequestInput,
    BlackBoxRallarEvent,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput,
    BlackBoxRallarMessageSendDiagnostics,
    BlackBoxRallarMessageSendInput,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport,
    BlackBoxRallarWsSendDiagnostics
} from './black-box-rallar-operation-contracts.ts';

export type {
    BlackBoxRallarRoomRefreshOptions,
    BlackBoxRallarRuntime
} from './black-box-rallar-runtime-contract.ts';

export interface BlackBoxRallarRuntimeInstallationTarget {
    __blackBoxRallar?: BlackBoxRallarRuntime;
    __blackBoxRallarEmit?: (event: BlackBoxRallarEvent) => void | Promise<void>;
}

declare global {
    interface Window extends BlackBoxRallarRuntimeInstallationTarget {}
    var __blackBoxRallarRestoreConsoleWarn: (() => void) | undefined;
}

export function createBlackBoxRallarRuntime(
    options: BlackBoxRallarConnectionRuntime.Input
): BlackBoxRallarRuntime {
    return new BlackBoxRallarConnectionRuntime(options).installation().runtime;
}

export function installBlackBoxRallarRuntime(
    targetWindow: BlackBoxRallarRuntimeInstallationTarget
): BlackBoxRallarRuntime {
    const installation = new BlackBoxRallarConnectionRuntime({
        facade: createBlackBoxBrowserRallarRuntimeDependency(),
        targetWindow,
        clock: { now: Date.now },
        delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))
    }).installation();
    targetWindow.__blackBoxRallar = installation.runtime;
    installation.emitRuntimeLoaded();
    return installation.runtime;
}
