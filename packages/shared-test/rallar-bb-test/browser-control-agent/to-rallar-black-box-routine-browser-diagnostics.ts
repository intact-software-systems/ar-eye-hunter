import type { RallarBlackBoxRoutineBrowserDiagnostics } from '../browser/browser-command-contracts.ts';

export function toRallarBlackBoxRoutineBrowserDiagnostics(
    text: string
): RallarBlackBoxRoutineBrowserDiagnostics | undefined {
    return text === 'enabled' || text === 'disabled' ? text : undefined;
}
