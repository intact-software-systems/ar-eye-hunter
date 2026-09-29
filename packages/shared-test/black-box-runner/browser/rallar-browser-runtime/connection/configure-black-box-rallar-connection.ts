import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';

import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import { toBlackBoxRallarDefaults } from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarVolatileLimits } from './black-box-rallar-volatile-limits.ts';

export interface ConfigureBlackBoxRallarConnectionInput {
    readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
    readonly diagnosticsPorts: RallarDiagnosticsPorts;
    readonly volatileLimits: BlackBoxRallarVolatileLimits;
    readonly config: BlackBoxRallarConnectionConfig;
}

/**
 * A connection that names no application has no defaults, so it also carries no scripted diagnostics ports. Its
 * volatile limits reach only the session the facade initialises next: a facade already connected keeps its own.
 */
export function configureBlackBoxRallarConnection(
    input: ConfigureBlackBoxRallarConnectionInput
): Parameters<BlackBoxBrowserRallarRuntimeDependency['setDefaults']>[0] {
    const { rallar, diagnosticsPorts, volatileLimits, config } = input;
    rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
    const defaults = toBlackBoxRallarDefaults(config);
    rallar.setDefaults(defaults === undefined ? undefined : { ...defaults, diagnosticsPorts });
    volatileLimits.set(config);
    return defaults;
}
