import { checkRtcCaptureCompatibility } from '@shared-web/browser/connection/rallar-rtc-capture-connection-required-error.ts';
import type { RallarDefaults } from '@shared-web/browser/rallar-connection-facade.ts';
import { resolveRtcCaptureConfiguration } from '@shared/webrtc/rtc-capture-configuration.ts';

import {
    createBlackBoxRallarDiagnosticsPorts,
    type BlackBoxRallarRuntimeDiagnostics
} from '../black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import { toBlackBoxRallarDefaults } from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
import type { BlackBoxRallarVolatileLimits } from './black-box-rallar-volatile-limits.ts';

export interface ConfigureBlackBoxRallarConnectionInput {
    readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
    readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
    readonly volatileLimits: BlackBoxRallarVolatileLimits;
    readonly config: BlackBoxRallarConnectionConfig;
    readonly connectionState: BlackBoxRallarConnectionState;
}

export interface ConfiguredBlackBoxRallarConnection {
    readonly defaults: RallarDefaults | undefined;
    readonly almDiagnostics: boolean;
}

/**
 * An unscoped connection inherits no application defaults. Explicit host capture settings independently carry
 * diagnostics ports; omission carries neither. Volatile limits reach only the session initialised next.
 */
export function configureBlackBoxRallarConnection(
    input: ConfigureBlackBoxRallarConnectionInput
): ConfiguredBlackBoxRallarConnection {
    const { rallar, diagnostics, volatileLimits, config, connectionState } = input;
    const almDiagnostics = config.rallar.almDiagnostics ?? true;
    if (rallar.status() !== 'idle') {
        const current = connectionState.configuration();
        const rejection = toAlmRecordingCompatibilityRejection(current?.almDiagnostics, almDiagnostics);
        if (rejection) {
            throw rejection;
        }
        if (current) {
            assertHostRtcCaptureCompatible(rallar, config);
            return { defaults: current.defaults, almDiagnostics: current.almDiagnostics };
        }
    }
    const diagnosticsPorts = createBlackBoxRallarDiagnosticsPorts(diagnostics, rallar.diagnostics, almDiagnostics);
    rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
    const defaults = toBlackBoxRallarDefaults(config);
    rallar.setDefaults(defaults === undefined ? undefined : { ...defaults, diagnosticsPorts });
    volatileLimits.set(config);
    connectionState.recordConfiguration({ config, defaults, almDiagnostics });
    return { defaults, almDiagnostics };
}

/** A live or pending middleware keeps its original ports until an explicit lifecycle boundary. */
function toAlmRecordingCompatibilityRejection(current: boolean | undefined, requested: boolean): Error | undefined {
    if (current === undefined) {
        return new Error(
            'ALM recording policy is unverified for the active SDK connection; close and reinitialize before configuring.'
        );
    }
    return current === requested
        ? undefined
        : new Error(
            'ALM recording policy differs from the active SDK connection; close and reinitialize before changing it.'
        );
}

/** Host defaults are immutable for this middleware too; RUN, step and recipe retain canonical precedence. */
function assertHostRtcCaptureCompatible(
    rallar: BlackBoxBrowserRallarRuntimeDependency,
    config: BlackBoxRallarConnectionConfig
): void {
    const host = config.rallar.rtc?.captureMode;
    if (host === undefined) {
        return;
    }
    const currentReceipt = rallar.rtcCapture();
    const compatibility = checkRtcCaptureCompatibility({
        requested: resolveRtcCaptureConfiguration({
            host,
            run: config.rallar.rtcCaptureContext?.run,
            step: config.rallar.rtcCaptureMode,
            recipe: config.rallar.rtcCaptureContext?.recipe,
            sinkAvailable: true
        }),
        current: currentReceipt?.configuration,
        currentReceipt
    });
    if (compatibility.left) {
        throw compatibility.left;
    }
}
