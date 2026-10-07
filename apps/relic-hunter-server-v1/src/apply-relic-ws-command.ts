import type { RelicCommand, RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RelicCommandSender } from './relic-command-sender.ts';

/** The issued session a command is applied under: its username names the hunter, its client id the principal. */
export type RelicSessionIdentity = Pick<AuthSession, 'clientId' | 'username'>;

export type RelicCommandApplication =
    | Readonly<{ kind: 'applied'; snapshot: RelicPublicSnapshot; publishFailure: Error | undefined; }>
    /** A rule refused the command, so nothing was written; its text was published to the hunter unless that failed. */
    | Readonly<{ kind: 'refused'; error: Error; publishFailure: Error | undefined; }>;

export interface ApplyRelicWsCommandInput {
    readonly command: RelicCommand;
    readonly senderId: string;
    readonly readSession: (sessionId: string) => Promise<RelicSessionIdentity | undefined>;
    readonly applyCommand: (
        command: RelicCommand,
        sender: RelicCommandSender
    ) => Promise<RelicCommandApplication>;
}

export type RelicWsCommandOutcome =
    | Readonly<{ kind: 'applied'; snapshot: RelicPublicSnapshot; }>
    | Readonly<{ kind: 'applied-not-published'; snapshot: RelicPublicSnapshot; error: Error; }>
    | Readonly<{ kind: 'refused'; error: Error; publishFailure: Error | undefined; }>
    | Readonly<{ kind: 'no-session'; detail: string; }>
    | Readonly<{ kind: 'session-unreadable'; error: Error; }>
    | Readonly<{ kind: 'not-applied'; error: Error; }>;

export interface RelicWsCommandWarning {
    readonly message: string;
    readonly error: Error | undefined;
}

type RelicWsCommandSender =
    | Readonly<{ kind: 'sender'; session: RelicSessionIdentity; }>
    | Extract<RelicWsCommandOutcome, { kind: 'no-session' | 'session-unreadable'; }>;

/**
 * A WS command is applied under its sender's session username, never the one it carries (Q6). The server already
 * acknowledged it at admission, so a session read failure, a rule refusal or a storage failure ends here as a value:
 * rethrown, it would retry the inbox entry into the same error (C12). A rule's refusal reaches the hunter's own
 * sessions as a hunter event (D168); the other failures reach no client until a reply channel exists (I1).
 */
export async function applyRelicWsCommand(
    input: ApplyRelicWsCommandInput
): Promise<RelicWsCommandOutcome> {
    const sender = await readRelicWsCommandSender(input);
    if (sender.kind !== 'sender') {
        return sender;
    }
    try {
        const application = await input.applyCommand(
            { ...input.command, username: sender.session.username },
            { sessionId: input.senderId, clientId: sender.session.clientId }
        );
        return toRelicWsCommandOutcome(application);
    }
    catch (error) {
        return { kind: 'not-applied', error: toError(error) };
    }
}

export function toRelicWsCommandWarning(
    senderId: string,
    outcome: RelicWsCommandOutcome
): RelicWsCommandWarning | undefined {
    const subject = `[relic] WS command from ${senderId}`;
    switch (outcome.kind) {
        case 'applied':
            return undefined;
        case 'applied-not-published':
            return { message: `${subject} was applied, but its publication failed.`, error: outcome.error };
        case 'refused':
            return outcome.publishFailure === undefined
                ? undefined
                : {
                    message: `${subject} was refused, but its refusal was not published.`,
                    error: outcome.publishFailure
                };
        case 'no-session':
            return { message: `${subject} was not applied: ${outcome.detail}`, error: undefined };
        case 'session-unreadable':
            return { message: `${subject} was not applied: its session could not be read.`, error: outcome.error };
        case 'not-applied':
            return { message: `${subject} was not applied.`, error: outcome.error };
    }
}

function toRelicWsCommandOutcome(application: RelicCommandApplication): RelicWsCommandOutcome {
    if (application.kind === 'refused') {
        return application;
    }
    return application.publishFailure === undefined
        ? { kind: 'applied', snapshot: application.snapshot }
        : { kind: 'applied-not-published', snapshot: application.snapshot, error: application.publishFailure };
}

async function readRelicWsCommandSender(input: ApplyRelicWsCommandInput): Promise<RelicWsCommandSender> {
    try {
        const session = await input.readSession(input.senderId);
        return session === undefined
            ? { kind: 'no-session', detail: `No issued session ${input.senderId}.` }
            : { kind: 'sender', session };
    }
    catch (error) {
        return { kind: 'session-unreadable', error: toError(error) };
    }
}
