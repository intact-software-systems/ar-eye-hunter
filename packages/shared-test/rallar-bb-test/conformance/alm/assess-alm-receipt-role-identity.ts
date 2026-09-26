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
    return Array.isArray(entries) ? entries.filter(isAlmReceiptRolesEntry) : [];
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
        const peerIds = value[`${list}RecipientPeerIds`];
        const named = isStringList(peerIds) ? toNamedRoles(peerIds, sessionRoles) : undefined;
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

/** `undefined` when a listed peer is not a session of the recipients. */
function toNamedRoles(
    peerIds: readonly string[],
    sessionRoles: ReadonlyMap<string, string>
): readonly string[] | undefined {
    const roles = peerIds.map((peerId) => sessionRoles.get(peerId));
    return roles.every((role) => role !== undefined) ? roles.filter((role) => role !== undefined) : undefined;
}

function isSameRoleSet(named: readonly string[], pinned: readonly AlmConformanceRole[]): boolean {
    return named.length === pinned.length && pinned.every((role) => named.includes(role));
}

function toRoleText(roles: readonly AlmConformanceRole[]): string {
    return roles.length === 0 ? 'no recipient' : roles.join(' and ');
}

function isAlmReceiptRolesEntry(value: unknown): value is AlmReceiptRolesEntry {
    return isJsonRecordValue(value) && typeof value.handleId === 'string' && isRoleList(value.confirmed) &&
        isRoleList(value.unconfirmed);
}

function isRoleList(value: unknown): value is readonly AlmConformanceRole[] {
    return isStringList(value) && value.every(isAlmConformanceRole);
}

function isStringList(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
