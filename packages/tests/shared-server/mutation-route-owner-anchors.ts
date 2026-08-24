import { GROUP_OWNER_FIXTURE_SOURCE } from './fixtures/mutation-route-owner/group-state-inbox-owner-fixture.ts';

// The analyzer's focused algorithm suites mutate this representative source fixture. Live production
// connectivity has its own inventory test; keeping mutation scenarios synthetic prevents formatter or
// ownership refactors from silently changing what an analyzer unit test is intended to exercise.

export const GROUP_OWNER_PATH = 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';

export interface GroupOwnerAnchors {
    readonly source: string;
    /** The whole `GROUP_MUTATION_INBOX_TYPES.filter(...)` call the loop iterates. */
    readonly collection: string;
    /** The `for (` header up to and including that filter call's opening parenthesis. */
    readonly loopStart: string;
    /** The registration that immediately follows the loop body. */
    readonly loopEnd: string;
    readonly classStart: string;
}

export function readGroupOwnerAnchors(): GroupOwnerAnchors {
    const source = GROUP_OWNER_FIXTURE_SOURCE;
    return {
        source,
        collection: matchAnchor(
            source,
            /GROUP_MUTATION_INBOX_TYPES\.filter\(\r?\n[^\n]*GROUP_PRESENCE_SESSION_CLEANUP,?\r?\n\s*\)/u,
            'group mutation filter call'
        ),
        loopStart: matchAnchor(
            source,
            /[^\S\r\n]*for \(\s*\r?\n?\s*const type of GROUP_MUTATION_INBOX_TYPES\.filter\(/u,
            'group mutation loop header'
        ),
        loopEnd: matchAnchor(
            source,
            /[^\S\r\n]*this\.handlers\.registerHandler\(\{\r?\n\s*type:\s*AppInboxType\.GROUP_PRESENCE_SESSION_CLEANUP,/u,
            'group presence cleanup registration'
        ),
        classStart: matchAnchor(
            source,
            /export class GroupStateInboxService \{/u,
            'group owner class header'
        )
    };
}

function matchAnchor(source: string, pattern: RegExp, description: string): string {
    const matched = pattern.exec(source);
    if (matched === null) {
        throw new Error(
            `The group owner fixture no longer contains the ${description} these suites splice against. ` +
                'Update the pattern in mutation-route-owner-anchors.ts rather than the callers.'
        );
    }
    return matched[0];
}

// Locates a fragment of production source by what its lines *say* rather than how they are laid
// out. Leading indentation and trailing commas are matched loosely, so a reformat cannot turn a
// splice into a silent no-op; the exact matched text is returned so callers can splice around it.
export function readFlexibleAnchor(source: string, fragment: string): string {
    const pattern = fragment
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(toLinePattern)
        .join('\\r?\\n\\s*');
    const matched = new RegExp(`[^\\S\\r\\n]*${pattern}`, 'u').exec(source);
    if (matched === null) {
        throw new Error(
            `Production source no longer contains this spliced fragment:\n${fragment}\n` +
                'Update the fragment to the construct it should anchor on.'
        );
    }
    return matched[0];
}

function toLinePattern(line: string): string {
    const escaped = line.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return escaped.endsWith(',') ? `${escaped.slice(0, -1)},?` : escaped;
}
