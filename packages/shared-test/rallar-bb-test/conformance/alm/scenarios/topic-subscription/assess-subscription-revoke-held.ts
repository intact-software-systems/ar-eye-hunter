import { isRallarBlackBoxTestResult } from '../../../../composite-results.ts';
import type { ControlResultEnvelope } from '../../../../control-protocol.ts';
import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '../../../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../../../schema/json-schema-validation.ts';

/** One role's recipe and the result envelope of its run, as the control run recorded it. */
export interface SubscriptionRevokeHeldRole {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly result: ControlResultEnvelope | undefined;
}

export interface SubscriptionRevokeHeldEvidence {
    readonly sender: SubscriptionRevokeHeldRole;
    readonly sibling: SubscriptionRevokeHeldRole;
}

export interface SubscriptionRevokeHeldReading {
    readonly issues: readonly string[];
    /**
     * Whether the first publication's frozen expected set named the sibling's session, which depends on when the server
     * stopped counting its closed socket live: recorded, never judged. Undefined when the evidence is unreadable.
     */
    readonly siblingExpectedFirst: boolean | undefined;
}

/** Joins the sender's receipts to the sibling's session: no receipt of the cell may confirm the sibling. */
export function assessSubscriptionRevokeHeld(evidence: SubscriptionRevokeHeldEvidence): SubscriptionRevokeHeldReading {
    const connect = evidence.sibling.recipe.commands.find((command) => command.kind === 'rtc.connect');
    const siblingSessionId = decodeSessionId(readRecipeResult(evidence.sibling, connect?.commandId)?.value);
    const receipts = evidence.sender.recipe.commands
        .filter((command) => command.kind === 'messages.receipts')
        .map((command) => ({
            handleId: command.handleId,
            result: readRecipeResult(evidence.sender, command.commandId)
        }));
    if (
        siblingSessionId === undefined || receipts.length === 0 ||
        receipts.some(({ result }) => !isJsonRecordValue(result?.value))
    ) {
        return {
            issues: ['The sibling\'s session or a receipt of the sender is missing.'],
            siblingExpectedFirst: undefined
        };
    }
    const issues = receipts.flatMap(({ handleId, result }) =>
        decodePeerIds(result?.value, 'confirmedRecipientPeerIds').includes(siblingSessionId)
            ? [`${handleId}: the receipt confirms the sibling, whose election was revoked before it reopened.`]
            : []
    );
    return {
        issues,
        siblingExpectedFirst: decodePeerIds(receipts[0]?.result?.value, 'expectedRecipientPeerIds')
            .includes(siblingSessionId)
    };
}

/** A command's recorded result inside the role's recipe run. */
function readRecipeResult(
    role: SubscriptionRevokeHeldRole,
    commandId: string | undefined
): RallarBlackBoxTestResult | undefined {
    const value = role.result?.result?.value;
    const results = isJsonRecordValue(value) && Array.isArray(value.results) ? value.results : [];
    return results.filter(isRallarBlackBoxTestResult).find((result) => result.commandId === commandId);
}

function decodeSessionId(value: unknown): string | undefined {
    return isJsonRecordValue(value) && typeof value.sessionId === 'string' ? value.sessionId : undefined;
}

function decodePeerIds(
    value: unknown,
    key: 'confirmedRecipientPeerIds' | 'expectedRecipientPeerIds'
): readonly string[] {
    const peerIds = isJsonRecordValue(value) ? value[key] : undefined;
    return Array.isArray(peerIds) ? peerIds.filter((peerId): peerId is string => typeof peerId === 'string') : [];
}
