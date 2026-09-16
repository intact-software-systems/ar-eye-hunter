import { Either } from '@shared/resilience/Either.ts';

import { RALLAR_BLACK_BOX_ASSERT_OPERATORS } from '../assert/assert-value-operators.ts';
import type {
    RallarBlackBoxControlAgentAssertionsCapability,
    RallarBlackBoxControlAgentCapabilities
} from '../distributed-run.ts';
import type {
    RallarBlackBoxTestAssertOperator,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestCrdtTransport,
    RallarBlackBoxTestRecipe
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    CONTROL_AGENT_MESSAGING_CAPABILITY,
    decodeControlAgentMessagingCapability
} from './control-agent-messaging-capability.ts';

const CONTROL_AGENT_CRDT_TRANSPORTS: readonly RallarBlackBoxTestCrdtTransport[] = [
    'local-only',
    'ws',
    'rtc',
    'ws-then-rtc',
    'rtc-with-ws-fallback'
];

const BASELINE_ASSERT_OPERATORS: readonly RallarBlackBoxTestAssertOperator[] = [
    'equals',
    'notEquals',
    'contains',
    'exists',
    'gte',
    'lte'
];

const EXTENDED_ASSERT_OPERATORS: readonly RallarBlackBoxTestAssertOperator[] = RALLAR_BLACK_BOX_ASSERT_OPERATORS
    .filter((operator) => !BASELINE_ASSERT_OPERATORS.includes(operator));

export interface DistributedAssertionFeatures {
    readonly absence: boolean;
    readonly untilLoop: boolean;
    readonly operators: readonly RallarBlackBoxTestAssertOperator[];
}

export interface ToControlAgentCapabilitiesInput {
    /** Absent before the agent has loaded a test configuration. */
    readonly config: RallarBlackBoxTestConfig | undefined;
    /** Absent when the agent's configuration names no provider mode. */
    readonly providerMode: string | undefined;
    /** Absent when the agent's configuration names no API base URL. */
    readonly apiBaseUrl: string | undefined;
}

// The advertisement is a build-time truth: an agent built from this checkout
// evaluates absence waits, until loops, and the full operator set, so the
// capability block mirrors the runtime feature set rather than configuration.
export function toControlAgentCapabilities(
    input: ToControlAgentCapabilitiesInput
): RallarBlackBoxControlAgentCapabilities {
    const crdtSupported = isCrdtCapableProvider(input.providerMode) ||
        hasCrdtRuntimeHints(input.config);
    return {
        crdt: {
            supported: crdtSupported,
            transports: crdtSupported ? CONTROL_AGENT_CRDT_TRANSPORTS : [],
            runtimeSurface: input.providerMode,
            apiBaseUrlConfigured: Boolean(input.apiBaseUrl)
        },
        assertions: {
            absence: true,
            untilLoop: true,
            operators: RALLAR_BLACK_BOX_ASSERT_OPERATORS
        },
        messaging: CONTROL_AGENT_MESSAGING_CAPABILITY
    };
}

/**
 * The capability block an agent advertises. An unreadable assertions block reads as absent, so the agent is
 * gated as one that predates assertion advertisement; unrecognised CRDT transports are dropped.
 */
export function decodeControlAgentCapabilities(value: unknown): Either<string, RallarBlackBoxControlAgentCapabilities> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('capabilities must be a JSON object');
    }
    const crdt = value.crdt;
    if (
        !isJsonRecordValue(crdt) ||
        typeof crdt.supported !== 'boolean' ||
        !Array.isArray(crdt.transports) ||
        typeof crdt.apiBaseUrlConfigured !== 'boolean'
    ) {
        return Either.ofLeft('capabilities.crdt must report supported, transports and apiBaseUrlConfigured');
    }
    const assertions = decodeAssertionsCapability(value.assertions).right;
    const crdtCapability = {
        supported: crdt.supported,
        transports: crdt.transports.filter(isControlAgentCrdtTransport),
        runtimeSurface: isNonEmptyText(crdt.runtimeSurface) ? crdt.runtimeSurface : undefined,
        apiBaseUrlConfigured: crdt.apiBaseUrlConfigured
    };
    return decodeControlAgentMessagingCapability(value.messaging).mapRight((messaging) => ({
        crdt: crdtCapability,
        messaging,
        ...(assertions ? { assertions } : {})
    }));
}

export function computeDistributedAssertionFeatures(
    recipes: readonly RallarBlackBoxTestRecipe[]
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
            command.groups.forEach((group) => group.commands.forEach(visit));
        }
        if (command.kind === 'assert' && EXTENDED_ASSERT_OPERATORS.includes(command.operator)) {
            operators.add(command.operator);
        }
        if ((command.kind === 'recipe.load' || command.kind === 'recipe.run') && command.recipe) {
            command.recipe.commands.forEach(visit);
        }
    };
    recipes.forEach((recipe) => recipe.commands.forEach(visit));

    return {
        absence,
        untilLoop,
        operators: [...operators].sort()
    };
}

/** Every required assertion feature the agent does not advertise; empty when the agent can run the recipes. */
export function validateAgentAssertionCapability(
    features: DistributedAssertionFeatures,
    capabilities: RallarBlackBoxControlAgentCapabilities | undefined
): readonly string[] {
    const assertions = capabilities?.assertions;
    const advertisedOperators = assertions?.operators ?? [];
    const missingOperators = features.operators.filter((operator) => !advertisedOperators.includes(operator));
    return [
        ...(features.absence && assertions?.absence !== true ? ['absence waits'] : []),
        ...(features.untilLoop && assertions?.untilLoop !== true ? ['until loops'] : []),
        ...(missingOperators.length > 0 ? [`assert operators: ${missingOperators.join(', ')}`] : [])
    ];
}

export function toMissingAssertionCapabilityReason(missing: readonly string[]): string {
    return `Agent does not advertise required assertion capabilities: ${missing.join('; ')}.`;
}

function decodeAssertionsCapability(value: unknown): Either<string, RallarBlackBoxControlAgentAssertionsCapability> {
    if (!isJsonRecordValue(value) || typeof value.absence !== 'boolean' || typeof value.untilLoop !== 'boolean') {
        return Either.ofLeft('capabilities.assertions must report absence and untilLoop');
    }
    return Either.ofRight({
        absence: value.absence,
        untilLoop: value.untilLoop,
        operators: Array.isArray(value.operators) ? value.operators.filter(isAssertOperator) : []
    });
}

function isCrdtCapableProvider(providerMode: string | undefined): boolean {
    return providerMode === 'browser-rallar' ||
        providerMode === 'rallar-browser' ||
        providerMode === 'rallar-remote-browser' ||
        providerMode === 'mixed';
}

function hasCrdtRuntimeHints(config: RallarBlackBoxTestConfig | undefined): boolean {
    const rallar = config?.rallar;
    return isJsonRecordValue(rallar) && (
        rallar.crdt === true ||
        typeof rallar.crdtTransport === 'string' ||
        rallar.crdtRuntime === true
    );
}

function isNonEmptyText(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isControlAgentCrdtTransport(value: unknown): value is RallarBlackBoxTestCrdtTransport {
    return typeof value === 'string' && CONTROL_AGENT_CRDT_TRANSPORTS.some((transport) => transport === value);
}

function isAssertOperator(value: unknown): value is RallarBlackBoxTestAssertOperator {
    return typeof value === 'string' && RALLAR_BLACK_BOX_ASSERT_OPERATORS.some((operator) => operator === value);
}
