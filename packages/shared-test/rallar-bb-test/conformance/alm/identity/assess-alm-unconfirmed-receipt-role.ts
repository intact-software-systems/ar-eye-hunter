import { EitherCollectors } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestRecipe } from '../../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import { isAlmConformanceRole, type AlmConformanceRole } from '../alm-conformance-roles.ts';
import { toConnectedSessionIds } from './assess-alm-acknowledged-identity.ts';
import {
    toAuthoredAlmConformanceParticipant,
    toRecordedAlmConformanceParticipant,
    type AlmConformanceIdentityParticipant,
    type RecordedAlmConformanceParticipant
} from './assess-alm-conformance-identity.ts';

export interface AlmUnconfirmedReceiptRoleEvidence {
    readonly runId: string;
    readonly sender: AlmConformanceIdentityParticipant;
    /** The participant of the role the sender's recipe names in `metadata.almUnconfirmedReceiptRole`. */
    readonly unconfirmed: AlmConformanceIdentityParticipant;
}

/** The role none of the sender's receipts may confirm, as its recipe's metadata names it; undefined when none. */
export function toAlmUnconfirmedReceiptRole(sender: RallarBlackBoxTestRecipe): AlmConformanceRole | undefined {
    const role = sender.metadata?.almUnconfirmedReceiptRole;
    return typeof role === 'string' && isAlmConformanceRole(role) ? role : undefined;
}

/** Joins the sender's receipts to the unconfirmed role's sessions: no receipt of the cell may confirm that role. */
export function assessAlmUnconfirmedReceiptRole(
    { runId, sender, unconfirmed }: AlmUnconfirmedReceiptRoleEvidence
): readonly string[] {
    const readings = [sender, unconfirmed].map((participant) =>
        toRecordedAlmConformanceParticipant(runId, participant)
    );
    const issues = EitherCollectors.toListFoldLefts(readings);
    const [recordedSender, recordedUnconfirmed] = EitherCollectors.toListFoldRights(readings)
        .map(toAuthoredAlmConformanceParticipant);
    if (issues.length > 0 || recordedSender === undefined || recordedUnconfirmed === undefined) {
        return issues;
    }
    return assessReceiptsLeaveRoleUnconfirmed(recordedSender, recordedUnconfirmed);
}

function assessReceiptsLeaveRoleUnconfirmed(
    sender: RecordedAlmConformanceParticipant,
    unconfirmed: RecordedAlmConformanceParticipant
): readonly string[] {
    const role = unconfirmed.participant.role;
    const unconfirmedSessionIds = toConnectedSessionIds(unconfirmed);
    const receipts = sender.participant.recipe.commands.filter((command) => command.kind === 'messages.receipts');
    if (unconfirmedSessionIds.length === 0 || receipts.length === 0) {
        return [`The ${role}'s session or a receipt of the sender is missing.`];
    }
    return receipts.flatMap((command) => {
        const value = sender.results.get(command.commandId!)?.value;
        const confirmed = isJsonRecordValue(value) ? value.confirmedRecipientPeerIds : undefined;
        if (!Array.isArray(confirmed)) {
            return [`${command.handleId}: the receipt names no confirmed recipients.`];
        }
        return confirmed.some((peerId) => typeof peerId === 'string' && unconfirmedSessionIds.includes(peerId))
            ? [`${command.handleId}: the receipt confirms the ${role}, which no receipt of the cell may confirm.`]
            : [];
    });
}
