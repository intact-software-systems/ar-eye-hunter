import {
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestTransport
} from './rallar-black-box-test-contracts.ts';
const ABORT_ERROR_CODE = 'RALLAR_BLACK_BOX_ABORTED';
export function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

export function toPositiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : undefined;
}

export function toNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : undefined;
}

export function toFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

export function toBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean'
        ? value
        : undefined;
}

export function toText(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined;
}

export function toTransport(value: unknown): RallarBlackBoxTestTransport | undefined {
    return value === 'realtime' ||
            value === 'messages.rtc' ||
            value === 'messages.ws' ||
            value === 'ws' ||
            value === 'http'
        ? value
        : undefined;
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === ABORT_ERROR_CODE;
}

export function toCommandLabelForId(command: RallarBlackBoxTestCommand, fallbackIndex: number): string {
    const source = command.commandId ?? `${command.kind}-${fallbackIndex}`;
    return source.replace(/[^a-zA-Z0-9_.:-]/g, '-');
}

export function toBoundedDeadlineCommand<T extends RallarBlackBoxTestCommand>(
    command: T,
    deadlineEpochMs: number
): T {
    const commandDeadline = command.deadlineEpochMs;
    return {
        ...command,
        deadlineEpochMs: commandDeadline === undefined
            ? deadlineEpochMs
            : Math.min(commandDeadline, deadlineEpochMs)
    };
}

export function computeCommandDeadlineEpochMs(
    command: RallarBlackBoxTestCommand,
    nowEpochMs: number
): number | undefined {
    const timeoutDeadline = command.timeoutMs === undefined
        ? undefined
        : nowEpochMs + Math.max(0, command.timeoutMs);

    if (command.deadlineEpochMs === undefined) {
        return timeoutDeadline;
    }

    return timeoutDeadline === undefined
        ? command.deadlineEpochMs
        : Math.min(timeoutDeadline, command.deadlineEpochMs);
}
