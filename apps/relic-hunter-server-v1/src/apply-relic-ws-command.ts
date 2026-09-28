import type { RelicCommand, RelicPublicSnapshot } from '@relic-hunters/mod.ts';

export interface ApplyRelicWsCommandInput {
    readonly command: RelicCommand;
    readonly senderId: string;
    readonly readSessionUsername: (sessionId: string) => Promise<string | undefined>;
    readonly applyCommand: (
        command: RelicCommand,
        senderId: string
    ) => Promise<RelicPublicSnapshot>;
}

export type RelicWsCommandOutcome =
    | Readonly<{ kind: 'applied'; snapshot: RelicPublicSnapshot; }>
    | Readonly<{ kind: 'no-session'; detail: string; }>
    | Readonly<{ kind: 'not-applied'; detail: string; }>;

/**
 * A WS command is applied under its sender's session username, never the one it carries (Q6). The server already
 * acknowledged it at admission, so a rule error or a storage failure ends here as a value: rethrown, it would retry the
 * inbox entry into the same error (C12). No client sees the detail until a reply channel exists (I1).
 */
export async function applyRelicWsCommand(
    input: ApplyRelicWsCommandInput
): Promise<RelicWsCommandOutcome> {
    const username = await input.readSessionUsername(input.senderId);
    if (username === undefined) {
        return { kind: 'no-session', detail: `No issued session ${input.senderId}.` };
    }
    try {
        return {
            kind: 'applied',
            snapshot: await input.applyCommand({ ...input.command, username }, input.senderId)
        };
    }
    catch (error) {
        return {
            kind: 'not-applied',
            detail: error instanceof Error ? error.message : String(error)
        };
    }
}
