import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

import { snapshotComparisonValue } from './snapshot-comparison-value.ts';
import { snapshotExecutableMetadata } from './snapshot-executable-metadata.ts';

/** Captures executable structure and capture options. Opaque application payloads retain their semantics. */
export function snapshotExecutableRecipe(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestRecipe {
    return Object.freeze({
        ...recipe,
        ...(recipe.metadata === undefined ? {} : { metadata: snapshotExecutableMetadata(recipe.metadata) }),
        commands: Object.freeze(recipe.commands.map(snapshotExecutableCommand))
    });
}

export function snapshotExecutableCommand(command: RallarBlackBoxTestCommand): RallarBlackBoxTestCommand {
    if (command.metadata !== undefined) {
        command = { ...command, metadata: snapshotExecutableMetadata(command.metadata) };
    }
    switch (command.kind) {
        case 'recipe.load':
        case 'recipe.run':
            return snapshotOwnedOptions(command, {
                recipe: command.recipe && snapshotExecutableRecipe(command.recipe)
            });
        case 'loop':
            return snapshotOwnedOptions(command, {
                commands: Object.freeze(command.commands.map(snapshotExecutableCommand)),
                thresholds: command.thresholds && Object.freeze({ ...command.thresholds })
            });
        case 'parallel':
            return snapshotOwnedOptions(command, {
                groups: Object.freeze(command.groups.map((group) =>
                    Object.freeze({
                        ...group,
                        commands: Object.freeze(group.commands.map(snapshotExecutableCommand))
                    })
                ))
            });
        case 'configure':
            return snapshotOwnedOptions(command, { config: snapshotRuntimeConfig(command.config) });
        case 'rtc.connect':
        case 'rtc.send':
        case 'rtc.stream':
        case 'crdt.open':
            return snapshotConnectionCommand(command);
        case 'assert':
        case 'wait':
        case 'crdt.wait':
            return snapshotComparisonCommand(command);
        case 'http.request':
        case 'ws.open':
            return snapshotNetworkCommand(command);
        case 'barrier':
            return snapshotOwnedOptions(command, {
                participants: command.participants && Object.freeze([...command.participants])
            });
        case 'fault.inject':
            return snapshotFaultCommand(command);
        case 'messages.observe':
        case 'messages.send':
            return snapshotMessageCommand(command);
        default:
            return Object.freeze({ ...command });
    }
}

function snapshotFaultCommand(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'fault.inject'; }>
): RallarBlackBoxTestCommand {
    const fault = { ...command };
    fault.match = Object.freeze({ ...command.match });
    fault.action = typeof command.action === 'object' ? Object.freeze({ ...command.action }) : command.action;
    return Object.freeze(fault);
}

/** Configuration controls SDK selection, capture, defaults, fleet admission and redaction. */
function snapshotRuntimeConfig(config: RallarBlackBoxTestConfig): RallarBlackBoxTestConfig {
    return snapshotOwnedOptions(config, {
        rallar: config.rallar && snapshotConnectionOptions(config.rallar),
        browser: config.browser && Object.freeze({ ...config.browser }),
        control: config.control && Object.freeze({ ...config.control }),
        defaults: config.defaults && Object.freeze({ ...config.defaults }),
        fleet: config.fleet && snapshotOwnedOptions(config.fleet, {
            ...(Array.isArray(config.fleet.tags) ? { tags: Object.freeze([...config.fleet.tags]) } : {}),
            ...(isJsonRecordValue(config.fleet.location)
                ? { location: Object.freeze({ ...config.fleet.location }) }
                : {})
        }),
        redaction: config.redaction && snapshotOwnedOptions(config.redaction, {
            keys: config.redaction.keys && Object.freeze([...config.redaction.keys]),
            keySubstrings: config.redaction.keySubstrings && Object.freeze([...config.redaction.keySubstrings]),
            secretValues: config.redaction.secretValues && Object.freeze([...config.redaction.secretValues])
        })
    });
}

/** Scoped SDK command options are owned; their outgoing application data stays opaque. */
function snapshotConnectionCommand(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' | 'rtc.send' | 'rtc.stream' | 'crdt.open'; }>
): RallarBlackBoxTestCommand {
    const scope = command.scope && Object.freeze({ ...command.scope });
    const roomRef = command.roomRef && Object.freeze({ ...command.roomRef });
    switch (command.kind) {
        case 'rtc.connect':
            return snapshotOwnedOptions(command, {
                scope,
                roomRef,
                rallar: command.rallar && snapshotConnectionOptions({ ...command.rallar }),
                readiness: command.readiness && Object.freeze({ ...command.readiness })
            });
        case 'crdt.open':
            return snapshotOwnedOptions(command, {
                scope,
                roomRef,
                rallar: command.rallar && snapshotConnectionOptions({ ...command.rallar }),
                policies: command.policies &&
                    Object.freeze(command.policies.map((policy) => Object.freeze({ ...policy }))),
                validation: command.validation && Object.freeze({ ...command.validation }),
                encryption: command.encryption && Object.freeze({ ...command.encryption })
            });
        case 'rtc.stream':
            return snapshotOwnedOptions(command, {
                scope,
                roomRef,
                thresholds: command.thresholds && Object.freeze({ ...command.thresholds })
            });
        case 'rtc.send':
            return snapshotOwnedOptions(command, { scope, roomRef });
    }
}

/** Structured operands decide whether execution proceeds; this policy never visits outgoing payload fields. */
function snapshotComparisonCommand(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'assert' | 'wait' | 'crdt.wait'; }>
): RallarBlackBoxTestCommand {
    switch (command.kind) {
        case 'assert':
            return snapshotOwnedOptions(command, { expected: snapshotComparisonValue(command.expected) });
        case 'wait':
            return snapshotOwnedOptions(command, {
                match: snapshotOwnedOptions(command.match, {
                    equals: snapshotComparisonValue(command.match.equals),
                    payloadFields: snapshotComparisonValue(command.match.payloadFields)
                })
            });
        case 'crdt.wait':
            return snapshotOwnedOptions(command, {
                sync: command.sync && Object.freeze({ ...command.sync }),
                conditions: Object.freeze(
                    command.conditions.map((condition) =>
                        snapshotOwnedOptions(condition, { expected: snapshotComparisonValue(condition.expected) })
                    )
                )
            });
    }
}

/** Network policy arrays/headers are owned, while request bodies and WS sends retain payload semantics. */
function snapshotNetworkCommand(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'http.request' | 'ws.open'; }>
): RallarBlackBoxTestCommand {
    return command.kind === 'ws.open'
        ? snapshotOwnedOptions(command, {
            protocols: Array.isArray(command.protocols) ? Object.freeze([...command.protocols]) : command.protocols,
            headers: command.headers && Object.freeze({ ...command.headers })
        })
        : snapshotOwnedOptions(command, {
            request: snapshotOwnedOptions(command.request, {
                headers: command.request.headers && Object.freeze({ ...command.request.headers })
            }),
            response: command.response && snapshotOwnedOptions(command.response, {
                acceptedStatusCodes: command.response.acceptedStatusCodes &&
                    Object.freeze([...command.response.acceptedStatusCodes])
            })
        });
}

/** Messaging control options select carrier/replay behavior; message payloads are intentionally not copied. */
function snapshotMessageCommand(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'messages.observe' | 'messages.send'; }>
): RallarBlackBoxTestCommand {
    if (command.kind === 'messages.observe') {
        return snapshotOwnedOptions(command, { state: Object.freeze([...command.state]) });
    }
    return 'replayOnCarrier' in command
        ? snapshotOwnedOptions(command, { replayOnCarrier: Object.freeze({ ...command.replayOnCarrier }) })
        : snapshotOwnedOptions(command, {
            roomRef: command.roomRef && Object.freeze({ ...command.roomRef }),
            minSnapshotVersion: command.minSnapshotVersion && Object.freeze({ ...command.minSnapshotVersion }),
            qos: command.qos && Object.freeze({ ...command.qos, ack: Object.freeze({ ...command.qos.ack }) })
        });
}

/** Only these nested records are connection options; unknown extension values remain opaque application data. */
function snapshotConnectionOptions<Record extends RallarBlackBoxTestRecord>(options: Record): Record {
    return Object.freeze({
        ...options,
        ...Object.fromEntries(
            ['scope', 'roomRef', 'rtcCaptureContext'].flatMap((key) =>
                isJsonRecordValue(options[key]) ? [[key, Object.freeze({ ...options[key] })]] : []
            )
        )
    });
}

/** Owning optional execution fields must preserve the caller's absence, including native in-process consumers. */
function snapshotOwnedOptions<Options extends object>(original: Options, copied: Partial<Options>): Options {
    return Object.freeze({
        ...original,
        ...Object.fromEntries(Object.entries(copied).filter(([key]) => Object.hasOwn(original, key)))
    });
}
