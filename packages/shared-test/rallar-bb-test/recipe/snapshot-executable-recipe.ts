import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';

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
            return snapshotOwnedOptions(command, {
                recipe: snapshotExecutableRecipe(command.recipe)
            });
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
            return snapshotOwnedOptions(command, {
                config: snapshotOwnedOptions(command.config, {
                    rallar: command.config.rallar && snapshotConnectionOptions(command.config.rallar),
                    browser: command.config.browser && Object.freeze({ ...command.config.browser }),
                    control: command.config.control && Object.freeze({ ...command.config.control }),
                    defaults: command.config.defaults && Object.freeze({ ...command.config.defaults }),
                    fleet: command.config.fleet && snapshotOwnedOptions(command.config.fleet, {
                        ...(Array.isArray(command.config.fleet.tags)
                            ? { tags: Object.freeze([...command.config.fleet.tags]) }
                            : {}),
                        ...(isOptionRecord(command.config.fleet.location)
                            ? { location: Object.freeze({ ...command.config.fleet.location }) }
                            : {})
                    }),
                    redaction: command.config.redaction && snapshotOwnedOptions(command.config.redaction, {
                        keys: command.config.redaction.keys && Object.freeze([...command.config.redaction.keys]),
                        keySubstrings: command.config.redaction.keySubstrings &&
                            Object.freeze([...command.config.redaction.keySubstrings]),
                        secretValues: command.config.redaction.secretValues &&
                            Object.freeze([...command.config.redaction.secretValues])
                    })
                })
            });
        case 'rtc.connect':
            return snapshotOwnedOptions(command, {
                rallar: command.rallar && snapshotConnectionOptions({ ...command.rallar }),
                scope: command.scope && Object.freeze({ ...command.scope }),
                roomRef: command.roomRef && Object.freeze({ ...command.roomRef }),
                readiness: command.readiness && Object.freeze({ ...command.readiness })
            });
        case 'rtc.send':
        case 'rtc.stream':
            return snapshotOwnedOptions(command, {
                scope: command.scope && Object.freeze({ ...command.scope }),
                roomRef: command.roomRef && Object.freeze({ ...command.roomRef }),
                ...(command.kind === 'rtc.stream'
                    ? { thresholds: command.thresholds && Object.freeze({ ...command.thresholds }) }
                    : {})
            });
        case 'crdt.open':
            return snapshotOwnedOptions(command, {
                rallar: command.rallar && snapshotConnectionOptions({ ...command.rallar }),
                scope: command.scope && Object.freeze({ ...command.scope }),
                roomRef: command.roomRef && Object.freeze({ ...command.roomRef }),
                policies: command.policies &&
                    Object.freeze(command.policies.map((policy) => Object.freeze({ ...policy }))),
                validation: command.validation && Object.freeze({ ...command.validation }),
                encryption: command.encryption && Object.freeze({ ...command.encryption })
            });
        case 'crdt.wait':
            return snapshotOwnedOptions(command, {
                sync: command.sync && Object.freeze({ ...command.sync }),
                conditions: Object.freeze(command.conditions.map((condition) => Object.freeze({ ...condition })))
            });
        case 'http.request':
            return snapshotOwnedOptions(command, {
                request: Object.freeze({
                    ...command.request,
                    headers: command.request.headers && Object.freeze({ ...command.request.headers })
                }),
                response: command.response && Object.freeze({
                    ...command.response,
                    acceptedStatusCodes: command.response.acceptedStatusCodes &&
                        Object.freeze([...command.response.acceptedStatusCodes])
                })
            });
        case 'ws.open':
            return snapshotOwnedOptions(command, {
                protocols: Array.isArray(command.protocols) ? Object.freeze([...command.protocols]) : command.protocols,
                headers: command.headers && Object.freeze({ ...command.headers })
            });
        case 'wait':
            return snapshotOwnedOptions(command, {
                match: Object.freeze({ ...command.match })
            });
        case 'barrier':
            return snapshotOwnedOptions(command, {
                participants: command.participants && Object.freeze([...command.participants])
            });
        case 'fault.inject':
            return command.carrier === 'storage'
                ? snapshotOwnedOptions(command, {
                    match: Object.freeze({ ...command.match }),
                    action: typeof command.action === 'object' ? Object.freeze({ ...command.action }) : command.action
                })
                : snapshotOwnedOptions(command, {
                    match: Object.freeze({ ...command.match }),
                    action: typeof command.action === 'object' ? Object.freeze({ ...command.action }) : command.action
                });
        case 'messages.observe':
            return snapshotOwnedOptions(command, {
                state: Object.freeze([...command.state])
            });
        case 'messages.send':
            return 'replayOnCarrier' in command
                ? snapshotOwnedOptions(command, {
                    replayOnCarrier: Object.freeze({ ...command.replayOnCarrier })
                })
                : snapshotOwnedOptions(command, {
                    roomRef: command.roomRef && Object.freeze({ ...command.roomRef }),
                    minSnapshotVersion: command.minSnapshotVersion && Object.freeze({ ...command.minSnapshotVersion }),
                    qos: command.qos && Object.freeze({ ...command.qos, ack: Object.freeze({ ...command.qos.ack }) })
                });
        default:
            return Object.freeze({ ...command });
    }
}

/** Only these nested records are connection options; unknown extension values remain opaque application data. */
function snapshotConnectionOptions<Record extends RallarBlackBoxTestRecord>(options: Record): Record {
    return Object.freeze({
        ...options,
        ...Object.fromEntries(
            ['scope', 'roomRef', 'rtcCaptureContext'].flatMap((key) =>
                isOptionRecord(options[key]) ? [[key, Object.freeze({ ...options[key] })]] : []
            )
        )
    });
}

function isOptionRecord(value: unknown): value is RallarBlackBoxTestRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Owning optional execution fields must preserve the caller's absence, including native in-process consumers. */
function snapshotOwnedOptions<Options extends object>(original: Options, copied: Partial<Options>): Options {
    return Object.freeze({
        ...original,
        ...Object.fromEntries(Object.entries(copied).filter(([key]) => Object.hasOwn(original, key)))
    });
}

/** ALM addresses/checkpoints drive reload decisions; all other metadata values remain opaque. */
function snapshotExecutableMetadata(metadata: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
    if (!isOptionRecord(metadata)) {
        return metadata;
    }
    const pair = metadata.almReloadPair;
    return Object.freeze({
        ...metadata,
        ...(Array.isArray(metadata.almReloadCheckpoints)
            ? {
                almReloadCheckpoints: Object.freeze(
                    metadata.almReloadCheckpoints.map((checkpoint) =>
                        isOptionRecord(checkpoint) ? Object.freeze({ ...checkpoint }) : checkpoint
                    )
                )
            }
            : {}),
        ...(isOptionRecord(pair)
            ? {
                almReloadPair: Object.freeze({
                    ...pair,
                    ...(isOptionRecord(pair.sender) ? { sender: Object.freeze({ ...pair.sender }) } : {}),
                    ...(isOptionRecord(pair.receiver) ? { receiver: Object.freeze({ ...pair.receiver }) } : {}),
                    ...(Array.isArray(pair.checkpoints)
                        ? {
                            checkpoints: Object.freeze(
                                pair.checkpoints.map((checkpoint) =>
                                    isOptionRecord(checkpoint) ? Object.freeze({ ...checkpoint }) : checkpoint
                                )
                            )
                        }
                        : {})
                })
            }
            : {})
    });
}
