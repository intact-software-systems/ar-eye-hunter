// deno-lint-ignore-file no-explicit-any
import { RALLAR_BLACK_BOX_ASSERT_OPERATORS } from '../assert/assert-value-operators.ts';
import type {
    RallarBlackBoxControlAgentCapabilities,
    RallarBlackBoxControlAgentAssertionsCapability,
} from '../distributed-run.ts';
import type {
    RallarBlackBoxTestAssertOperator,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestCrdtTransport,
    RallarBlackBoxTestRecipe,
} from '../types.ts';

const CONTROL_AGENT_CRDT_TRANSPORTS = [
    'local-only',
    'ws',
    'rtc',
    'ws-then-rtc',
    'rtc-with-ws-fallback',
] as const;

const BASELINE_ASSERT_OPERATORS: readonly RallarBlackBoxTestAssertOperator[] = [
    'equals',
    'notEquals',
    'contains',
    'exists',
    'gte',
    'lte',
];

export const RALLAR_BLACK_BOX_EXTENDED_ASSERT_OPERATORS:
    readonly RallarBlackBoxTestAssertOperator[] = RALLAR_BLACK_BOX_ASSERT_OPERATORS
        .filter(operator => !BASELINE_ASSERT_OPERATORS.includes(operator));

export interface DistributedAssertionFeatures {
    readonly absence: boolean;
    readonly untilLoop: boolean;
    readonly operators: readonly RallarBlackBoxTestAssertOperator[];
}

export interface ToControlAgentCapabilitiesInput {
    readonly config: RallarBlackBoxTestConfig | undefined;
    readonly providerMode: string | undefined;
    readonly apiBaseUrl: string | undefined;
}

// The advertisement is a build-time truth: an agent built from this checkout
// evaluates absence waits, until loops, and the full operator set, so the
// capability block mirrors the runtime feature set rather than configuration.
export function toControlAgentCapabilities(
    input: ToControlAgentCapabilitiesInput,
): RallarBlackBoxControlAgentCapabilities {
    const crdtSupported = isCrdtCapableProvider(input.providerMode) ||
        hasCrdtRuntimeHints(input.config);
    return {
        crdt: {
            supported: crdtSupported,
            transports: crdtSupported ? CONTROL_AGENT_CRDT_TRANSPORTS : [],
            runtimeSurface: input.providerMode,
            apiBaseUrlConfigured: Boolean(input.apiBaseUrl),
        },
        assertions: {
            absence: true,
            untilLoop: true,
            operators: RALLAR_BLACK_BOX_ASSERT_OPERATORS,
        },
    };
}

export function parseControlAgentCapabilities(
    value: any,
): RallarBlackBoxControlAgentCapabilities | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const crdt = isRecord(value.crdt) ? value.crdt : undefined;
    if (!crdt || typeof crdt.supported !== 'boolean') {
        return undefined;
    }

    const transports = Array.isArray(crdt.transports)
        ? crdt.transports.filter((transport): transport is RallarBlackBoxTestCrdtTransport =>
            typeof transport === 'string' &&
            CONTROL_AGENT_CRDT_TRANSPORTS
                .includes(transport as typeof CONTROL_AGENT_CRDT_TRANSPORTS[number])
        )
        : undefined;
    const assertions = parseAssertionsCapability(value.assertions);
    return {
        crdt: {
            supported: crdt.supported,
            transports,
            runtimeSurface: optionalString(crdt.runtimeSurface),
            apiBaseUrlConfigured: typeof crdt.apiBaseUrlConfigured === 'boolean'
                ? crdt.apiBaseUrlConfigured
                : undefined,
        },
        ...(assertions ? { assertions } : {}),
    };
}

export function collectDistributedAssertionFeatures(
    recipes: readonly RallarBlackBoxTestRecipe[],
): DistributedAssertionFeatures {
    let absence = false;
    let untilLoop = false;
    const operators = new Set<RallarBlackBoxTestAssertOperator>();

    const visit = (command: RallarBlackBoxTestCommand): void => {
        if (command.kind === 'wait' && command.absent === true) {
            absence = true;
        }
        if (command.kind === 'loop') {
            if (command.until !== undefined) {
                untilLoop = true;
            }
            command.commands.forEach(visit);
        }
        if (command.kind === 'parallel') {
            command.groups.forEach(group => group.commands.forEach(visit));
        }
        if (
            command.kind === 'assert' &&
            RALLAR_BLACK_BOX_EXTENDED_ASSERT_OPERATORS.includes(command.operator)
        ) {
            operators.add(command.operator);
        }
        if ((command.kind === 'recipe.load' || command.kind === 'recipe.run') && command.recipe) {
            command.recipe.commands.forEach(visit);
        }
    };
    recipes.forEach(recipe => recipe.commands.forEach(visit));

    return {
        absence,
        untilLoop,
        operators: [...operators].sort(),
    };
}

export function validateAgentAssertionCapability(
    features: DistributedAssertionFeatures,
    capabilities: RallarBlackBoxControlAgentCapabilities | undefined,
): string | undefined {
    const missing: string[] = [];
    const assertions = capabilities?.assertions;
    if (features.absence && assertions?.absence !== true) {
        missing.push('absence waits');
    }
    if (features.untilLoop && assertions?.untilLoop !== true) {
        missing.push('until loops');
    }
    const advertisedOperators = assertions?.operators ?? [];
    const missingOperators = features.operators
        .filter(operator => !advertisedOperators.includes(operator));
    if (missingOperators.length > 0) {
        missing.push(`assert operators: ${missingOperators.join(', ')}`);
    }
    if (missing.length === 0) {
        return undefined;
    }
    return `Agent does not advertise required assertion capabilities: ${missing.join('; ')}.`;
}

function parseAssertionsCapability(
    value: any,
): RallarBlackBoxControlAgentAssertionsCapability | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (typeof value.absence !== 'boolean' || typeof value.untilLoop !== 'boolean') {
        return undefined;
    }
    const operators = Array.isArray(value.operators)
        ? value.operators.filter((operator): operator is RallarBlackBoxTestAssertOperator =>
            typeof operator === 'string' &&
            RALLAR_BLACK_BOX_ASSERT_OPERATORS
                .includes(operator as RallarBlackBoxTestAssertOperator)
        )
        : [];
    return {
        absence: value.absence,
        untilLoop: value.untilLoop,
        operators,
    };
}

function isCrdtCapableProvider(providerMode: string | undefined): boolean {
    return providerMode === 'browser-rallar' ||
        providerMode === 'rallar-browser' ||
        providerMode === 'rallar-remote-browser' ||
        providerMode === 'mixed';
}

function hasCrdtRuntimeHints(config: RallarBlackBoxTestConfig | undefined): boolean {
    const rallar = isRecord(config?.rallar) ? config.rallar : {};
    return Boolean(
        rallar.crdt === true ||
            typeof rallar.crdtTransport === 'string' ||
            rallar.crdtRuntime === true,
    );
}

function optionalString(value: any): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: any): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
