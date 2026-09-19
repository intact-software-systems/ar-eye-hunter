import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';

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
        deadlineEpochMs: commandDeadline === undefined ? deadlineEpochMs : Math.min(commandDeadline, deadlineEpochMs)
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
