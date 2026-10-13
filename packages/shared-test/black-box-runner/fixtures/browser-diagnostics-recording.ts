import type { ApiJsonValue } from '../../../shared/api/api-json-value.ts';

export type RallarBlackBoxRoutineBrowserDiagnostics = 'enabled' | 'disabled';

export interface BrowserDiagnosticsReceipt {
    readonly routineBrowserDiagnostics: RallarBlackBoxRoutineBrowserDiagnostics;
    readonly omittedRoutineBrowserDiagnostics: number;
    readonly forwardedBrowserDiagnostics: number;
}

export function toRallarBlackBoxRoutineBrowserDiagnostics(
    text: string
): RallarBlackBoxRoutineBrowserDiagnostics | undefined {
    return text === 'enabled' || text === 'disabled' ? text : undefined;
}

export function toBrowserDiagnosticsReceipt(value: ApiJsonValue | undefined): BrowserDiagnosticsReceipt | undefined {
    if (
        typeof value !== 'object' || value === null || Array.isArray(value) ||
        !('routineBrowserDiagnostics' in value) || !('omittedRoutineBrowserDiagnostics' in value) ||
        !('forwardedBrowserDiagnostics' in value)
    ) {
        return undefined;
    }
    const mode = typeof value.routineBrowserDiagnostics === 'string'
        ? toRallarBlackBoxRoutineBrowserDiagnostics(value.routineBrowserDiagnostics)
        : undefined;
    const omitted = value.omittedRoutineBrowserDiagnostics;
    const forwarded = value.forwardedBrowserDiagnostics;
    if (
        mode === undefined || typeof omitted !== 'number' || !Number.isSafeInteger(omitted) || omitted < 0 ||
        typeof forwarded !== 'number' || !Number.isSafeInteger(forwarded) || forwarded < 0 ||
        (mode === 'enabled' && omitted !== 0)
    ) {
        return undefined;
    }
    return {
        routineBrowserDiagnostics: mode,
        omittedRoutineBrowserDiagnostics: omitted,
        forwardedBrowserDiagnostics: forwarded
    };
}

export function validateBrowserDiagnosticsLifetime(
    initial: BrowserDiagnosticsReceipt,
    current: BrowserDiagnosticsReceipt
): readonly string[] {
    return current.routineBrowserDiagnostics === initial.routineBrowserDiagnostics &&
            current.omittedRoutineBrowserDiagnostics >= initial.omittedRoutineBrowserDiagnostics &&
            current.forwardedBrowserDiagnostics >= initial.forwardedBrowserDiagnostics
        ? []
        : ['browser-recording-lifetime-mismatch'];
}
