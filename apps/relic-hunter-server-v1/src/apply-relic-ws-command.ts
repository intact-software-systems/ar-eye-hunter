import type { RelicCommand, RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface RelicCommandApplication {
    readonly snapshot: RelicPublicSnapshot;
    readonly publishFailure: Error | undefined;
}

export interface ApplyRelicWsCommandInput {
    readonly command: RelicCommand;
    readonly senderId: string;
    readonly readSessionUsername: (sessionId: string) => Promise<string | undefined>;
    readonly applyCommand: (
        command: RelicCommand,
        senderId: string
    ) => Promise<RelicCommandApplication>;
}

export type RelicWsCommandOutcome =
    | Readonly<{ kind: 'applied'; snapshot: RelicPublicSnapshot; }>
    | Readonly<{ kind: 'applied-not-published'; snapshot: RelicPublicSnapshot; error: Error; }>
    | Readonly<{ kind: 'no-session'; detail: string; }>
    | Readonly<{ kind: 'session-unreadable'; error: Error; }>
    | Readonly<{ kind: 'not-applied'; error: Error; }>;

type RelicWsCommandSender =
    | Readonly<{ kind: 'sender'; username: string; }>
    | Extract<RelicWsCommandOutcome, { kind: 'no-session' | 'session-unreadable'; }>;

/**
 * A WS command is applied under its sender's session username, never the one it carries (Q6). The server already
 * acknowledged it at admission, so a session read failure, a rule error or a storage failure ends here as a value:
 * rethrown, it would retry the inbox entry into the same error (C12). No client sees the detail until a reply channel
 * exists (I1).
 */
export async function applyRelicWsCommand(
    input: ApplyRelicWsCommandInput
): Promise<RelicWsCommandOutcome> {
    const sender = await readRelicWsCommandSender(input);
    if (sender.kind !== 'sender') {
        return sender;
    }
    try {
        const application = await input.applyCommand({ ...input.command, username: sender.username }, input.senderId);
        return application.publishFailure === undefined
            ? { kind: 'applied', snapshot: application.snapshot }
            : { kind: 'applied-not-published', snapshot: application.snapshot, error: application.publishFailure };
    }
    catch (error) {
        return { kind: 'not-applied', error: toError(error) };
    }
}

export function toRelicWsCommandWarning(
    senderId: string,
    outcome: RelicWsCommandOutcome
): Readonly<{ message: string; error: Error | undefined; }> | undefined {
    const subject = `[relic] WS command from ${senderId}`;
    switch (outcome.kind) {
        case 'applied':
            return undefined;
        case 'applied-not-published':
            return { message: `${subject} was applied, but its snapshot was not published.`, error: outcome.error };
        case 'no-session':
            return { message: `${subject} was not applied: ${outcome.detail}`, error: undefined };
        case 'session-unreadable':
            return { message: `${subject} was not applied: its session could not be read.`, error: outcome.error };
        case 'not-applied':
            return { message: `${subject} was not applied.`, error: outcome.error };
    }
}

async function readRelicWsCommandSender(input: ApplyRelicWsCommandInput): Promise<RelicWsCommandSender> {
    try {
        const username = await input.readSessionUsername(input.senderId);
        return username === undefined
            ? { kind: 'no-session', detail: `No issued session ${input.senderId}.` }
            : { kind: 'sender', username };
    }
    catch (error) {
        return { kind: 'session-unreadable', error: toError(error) };
    }
}
