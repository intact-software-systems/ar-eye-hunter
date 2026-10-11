import type { RallarDefaults } from '@shared-web/browser/rallar-connection-facade.ts';

import {
    createBlackBoxRallarDiagnosticsPorts,
    type BlackBoxRallarRuntimeDiagnostics
} from '../black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import { toBlackBoxRallarDefaults } from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarVolatileLimits } from './black-box-rallar-volatile-limits.ts';

export interface ConfigureBlackBoxRallarConnectionInput {
    readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
    readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
    readonly volatileLimits: BlackBoxRallarVolatileLimits;
    readonly config: BlackBoxRallarConnectionConfig;
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
    const { rallar, diagnostics, volatileLimits, config } = input;
    const almDiagnostics = config.rallar.almDiagnostics ?? true;
    const diagnosticsPorts = createBlackBoxRallarDiagnosticsPorts(diagnostics, rallar.diagnostics, almDiagnostics);
    rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
    const defaults = toBlackBoxRallarDefaults(config);
    rallar.setDefaults(defaults === undefined ? undefined : { ...defaults, diagnosticsPorts });
    volatileLimits.set(config);
    return { defaults, almDiagnostics };
}
