import { Either } from '@shared/resilience/Either.ts';

import {
    isRallarBlackBoxAssertOperator,
    RALLAR_BLACK_BOX_ASSERT_OPERATORS
} from '../assert/assert-value-operators.ts';
import type {
    RallarBlackBoxControlAgentAssertionsCapability,
    RallarBlackBoxControlAgentCapabilities,
    RallarBlackBoxControlAgentCrdtCapability
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

interface DecodedCapabilityBlocks {
    readonly crdt: RallarBlackBoxControlAgentCrdtCapability;
    readonly assertions: Either<string, RallarBlackBoxControlAgentAssertionsCapability>;
    readonly messaging: Either<string, RallarBlackBoxControlAgentCapabilities['messaging']>;
}

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

/** The capability block an agent advertises; any missing or unreadable part rejects the whole block. */
export function decodeControlAgentCapabilities(value: unknown): Either<string, RallarBlackBoxControlAgentCapabilities> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('capabilities must be a JSON object');
    }
    const assertions = decodeAssertionsCapability(value.assertions);
    const messaging = decodeControlAgentMessagingCapability(value.messaging);
    return decodeCrdtCapability(value.crdt).flatMap(
        (issue) => Either.ofLeft(issue),
        (crdt) => toDecodedControlAgentCapabilities({ crdt, assertions, messaging })
    );
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

function decodeCrdtCapability(value: unknown): Either<string, RallarBlackBoxControlAgentCrdtCapability> {
    if (
        !isJsonRecordValue(value) ||
        typeof value.supported !== 'boolean' ||
        !Array.isArray(value.transports) ||
        typeof value.apiBaseUrlConfigured !== 'boolean'
    ) {
        return Either.ofLeft('capabilities.crdt must report supported, transports and apiBaseUrlConfigured');
    }
    if (!value.transports.every(isControlAgentCrdtTransport)) {
        return Either.ofLeft('capabilities.crdt.transports must list known CRDT transports');
    }
    const runtimeSurface = value.runtimeSurface;
    if (runtimeSurface !== undefined && !isNonEmptyText(runtimeSurface)) {
        return Either.ofLeft('capabilities.crdt.runtimeSurface must be a non-empty string when present');
    }
    return Either.ofRight({
        supported: value.supported,
        transports: value.transports,
        ...(runtimeSurface === undefined ? {} : { runtimeSurface }),
        apiBaseUrlConfigured: value.apiBaseUrlConfigured
    });
}

function decodeAssertionsCapability(value: unknown): Either<string, RallarBlackBoxControlAgentAssertionsCapability> {
    if (
        !isJsonRecordValue(value) ||
        typeof value.absence !== 'boolean' ||
        typeof value.untilLoop !== 'boolean' ||
        !Array.isArray(value.operators)
    ) {
        return Either.ofLeft('capabilities.assertions must report absence, untilLoop and operators');
    }
    return value.operators.every(isRallarBlackBoxAssertOperator)
        ? Either.ofRight({ absence: value.absence, untilLoop: value.untilLoop, operators: value.operators })
        : Either.ofLeft('capabilities.assertions.operators must list known assert operators');
}

function toDecodedControlAgentCapabilities(
    blocks: DecodedCapabilityBlocks
): Either<string, RallarBlackBoxControlAgentCapabilities> {
    return blocks.assertions.flatMap(
        (issue) => Either.ofLeft(issue),
        (assertions) => blocks.messaging.mapRight((messaging) => ({ crdt: blocks.crdt, assertions, messaging }))
    );
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
