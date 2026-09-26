import type { RallarBlackBoxTestRecipe } from '../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../schema/json-schema-validation.ts';
import { isAlmConformanceRole, type AlmConformanceRole } from './alm-conformance-roles.ts';
import { toConnectedSessionIds } from './assess-alm-acknowledged-identity.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';

export interface AlmReceiptRoleIdentityInput {
    readonly sender: RecordedAlmConformanceParticipant;
    readonly recipients: readonly RecordedAlmConformanceParticipant[];
}

/** One pinned receipt: the recipient roles the receipt of `handleId` confirms and leaves unconfirmed. */
interface AlmReceiptRolesEntry {
    readonly handleId: string;
    readonly confirmed: readonly AlmConformanceRole[];
    readonly unconfirmed: readonly AlmConformanceRole[];
}

/** The sender recipe names every receipt it pins in `metadata.almReceiptRoles`, one entry per send. */
export function readAlmReceiptRolesEntries(recipe: RallarBlackBoxTestRecipe): readonly AlmReceiptRolesEntry[] {
    const entries = recipe.metadata?.almReceiptRoles;
    return Array.isArray(entries) ? entries.flatMap(toAlmReceiptRolesEntry) : [];
}

/**
 * D28: the receipt is read from the sender evidence after the run, and its recipient lists name sessions. Each list
 * must name exactly the sessions of the roles the scenario pins, so a count that is right for the wrong peer fails.
 */
export function assessAlmReceiptRoleIdentity(input: AlmReceiptRoleIdentityInput): readonly string[] {
    return readAlmReceiptRolesEntries(input.sender.participant.recipe).flatMap((entry) =>
        assessReceiptRolesEntry(entry, input)
    );
}

function assessReceiptRolesEntry(entry: AlmReceiptRolesEntry, input: AlmReceiptRoleIdentityInput): readonly string[] {
    const receipts = input.sender.participant.recipe.commands.find((command) =>
        command.kind === 'messages.receipts' && command.handleId === entry.handleId
    );
    const value = receipts ? input.sender.results.get(receipts.commandId!)?.value : undefined;
    if (!isJsonRecordValue(value)) {
        return [`${entry.handleId}: sender receipts are missing.`];
    }
    const sessionRoles = toSessionRoles(input.recipients);
    const expected = { ...entry, expected: [...entry.confirmed, ...entry.unconfirmed] };
    return (['confirmed', 'unconfirmed', 'expected'] as const).flatMap((list) => {
        const named = toNamedRoles(value[`${list}RecipientPeerIds`], sessionRoles);
        return named !== undefined && isSameRoleSet(named, expected[list])
            ? []
            : [`${entry.handleId}: the ${list} recipients do not name the sessions of ${toRoleText(expected[list])}.`];
    });
}

function toSessionRoles(recipients: readonly RecordedAlmConformanceParticipant[]): ReadonlyMap<string, string> {
    return new Map(
        recipients.flatMap((recipient) =>
            toConnectedSessionIds(recipient).map((sessionId) => [sessionId, recipient.participant.role] as const)
        )
    );
}

/** `undefined` when the list is not a list of sessions of the recipients. */
function toNamedRoles(peerIds: unknown, sessionRoles: ReadonlyMap<string, string>): readonly string[] | undefined {
    if (!Array.isArray(peerIds)) {
        return undefined;
    }
    const roles = peerIds.map((peerId) => typeof peerId === 'string' ? sessionRoles.get(peerId) : undefined);
    return roles.every((role) => role !== undefined) ? roles.filter((role) => role !== undefined) : undefined;
}

function isSameRoleSet(named: readonly string[], pinned: readonly AlmConformanceRole[]): boolean {
    return named.length === pinned.length && pinned.every((role) => named.includes(role));
}

function toRoleText(roles: readonly AlmConformanceRole[]): string {
    return roles.length === 0 ? 'no recipient' : roles.join(' and ');
}

function toAlmReceiptRolesEntry(value: unknown): readonly AlmReceiptRolesEntry[] {
    if (!isJsonRecordValue(value) || typeof value.handleId !== 'string') {
        return [];
    }
    const confirmed = toRoles(value.confirmed);
    const unconfirmed = toRoles(value.unconfirmed);
    return confirmed === undefined || unconfirmed === undefined
        ? []
        : [{ handleId: value.handleId, confirmed, unconfirmed }];
}

function toRoles(value: unknown): readonly AlmConformanceRole[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const roles = value.filter((role): role is AlmConformanceRole =>
        typeof role === 'string' && isAlmConformanceRole(role)
    );
    return roles.length === value.length ? roles : undefined;
}
