import { Either } from '@shared/resilience/Either.ts';

import type {
    BlackBoxRallarMessageSendInput,
    BlackBoxRallarRecipientPeer
} from '../black-box-rallar-operation-contracts.ts';
import {
    decodeBlackBoxCommandString,
    type BlackBoxRallarCommandRecord,
    type BlackBoxRallarInputIssue
} from '../decode-black-box-rallar-command-input.ts';

export type BlackBoxRallarMessageAudience = Pick<
    BlackBoxRallarMessageSendInput,
    'toPeer' | 'principalId' | 'recipientPeers' | 'recipientPrincipalIds'
>;

const MESSAGE_PEER_ROLES: readonly NonNullable<BlackBoxRallarMessageSendInput['toPeer']>[] = ['server', 'receiver'];
const MESSAGE_RECIPIENT_PEER_ROLES: readonly BlackBoxRallarRecipientPeer[] = ['receiver', 'recipient-b'];
const MAX_RECIPIENT_PRINCIPAL_IDS = 256;
/** The audiences a send may name, at most one of them; `scope` counts only as `principal`. */
const AUDIENCE_FIELDS = ['toPeer', 'recipientPeers', 'recipientPrincipalIds', 'scope'] as const;

/** Who a `messages.send` addresses: one peer by role, a fixed list by role or by principal, or a principal's sessions. */
export function decodeBlackBoxRallarMessageAudience(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, BlackBoxRallarMessageAudience> {
    const toPeer = MESSAGE_PEER_ROLES.find((role) => role === record.toPeer);
    if (record.toPeer !== undefined && toPeer === undefined) {
        return Either.ofLeft({ message: 'messages.send.toPeer must be server or receiver.' });
    }
    const named = AUDIENCE_FIELDS.filter((field) =>
        field === 'scope' ? record.scope === 'principal' : record[field] !== undefined
    );
    if (named.length > 1) {
        return Either.ofLeft({
            message:
                `messages.send names ${named.join(' and ')}; a send names at most one of toPeer, recipientPeers, ` +
                'recipientPrincipalIds and scope \'principal\'.'
        });
    }
    const principalId = decodeBlackBoxCommandString(record.principalId);
    return decodeRecipientPeers(record.recipientPeers).flatMap(
        (issue) => Either.ofLeft(issue),
        (byRole) =>
            decodeRecipientPrincipalIds(record.recipientPrincipalIds).mapRight((byPrincipal) => ({
                toPeer,
                principalId,
                ...byRole,
                ...byPrincipal
            }))
    );
}

/** Absent, no list by role; present, one or two distinct roles. */
function decodeRecipientPeers(
    value: unknown
): Either<BlackBoxRallarInputIssue, Pick<BlackBoxRallarMessageAudience, 'recipientPeers'>> {
    if (value === undefined) {
        return Either.ofRight({ recipientPeers: undefined });
    }
    const entries: readonly unknown[] = Array.isArray(value) ? value : [];
    const roles = entries.flatMap((entry) => MESSAGE_RECIPIENT_PEER_ROLES.filter((role) => role === entry));
    return Array.isArray(value) && roles.length === entries.length && roles.length > 0 &&
            new Set(roles).size === roles.length
        ? Either.ofRight({ recipientPeers: roles })
        : Either.ofLeft({ message: 'messages.send.recipientPeers must list receiver or recipient-b, each once.' });
}

/** Absent, no list by principal; present, 1 to `MAX_RECIPIENT_PRINCIPAL_IDS` principal ids, each once. */
function decodeRecipientPrincipalIds(
    value: unknown
): Either<BlackBoxRallarInputIssue, Pick<BlackBoxRallarMessageAudience, 'recipientPrincipalIds'>> {
    if (value === undefined) {
        return Either.ofRight({ recipientPrincipalIds: undefined });
    }
    const entries: readonly unknown[] = Array.isArray(value) ? value : [];
    const principalIds = entries.filter((entry): entry is string => typeof entry === 'string');
    if (principalIds.length > MAX_RECIPIENT_PRINCIPAL_IDS) {
        return Either.ofLeft({
            message:
                `messages.send.recipientPrincipalIds must list at most ${MAX_RECIPIENT_PRINCIPAL_IDS} principal ids.`
        });
    }
    return Array.isArray(value) && principalIds.length === entries.length && principalIds.length > 0 &&
            new Set(principalIds).size === principalIds.length
        ? Either.ofRight({ recipientPrincipalIds: principalIds })
        : Either.ofLeft({ message: 'messages.send.recipientPrincipalIds must list distinct principal ids.' });
}
