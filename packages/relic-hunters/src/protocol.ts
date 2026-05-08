export const RELIC_PROTOCOL_VERSION = 1 as const;

export const RELIC_TOPICS = {
    command: 'room.relic.command',
    snapshot: 'room.relic.snapshot',
    event: 'room.relic.event',
} as const;

export const RELIC_TYPES = {
    command: 'relic.command.v1',
    snapshot: 'relic.snapshot.v1',
    event: 'relic.event.v1',
} as const;
