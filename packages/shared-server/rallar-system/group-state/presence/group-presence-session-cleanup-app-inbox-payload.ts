import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '../../client-state/inbox/app-client-inbox-contracts.ts';
import { decodeClientAuthorisedWsSessionConnectAppInboxPayload } from '../../client-state/inbox/client-state-inbox-command-codec.ts';
import { requireEpoch, requireExactKeys, requireRecord, requireString } from '../../protocol/exact-object-decoding.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../../protocol/json-wire-identity.ts';

export interface GroupPresenceSessionCleanupAppInboxPayload {
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly disconnectedAtEpochMs: number;
    readonly reason: string;
}

export function decodeGroupPresenceSessionCleanupAppInboxPayload(
    value: JsonWireValue
): GroupPresenceSessionCleanupAppInboxPayload {
    const payload = requireRecord(value, 'Group presence cleanup AppInbox payload');
    requireExactKeys(
        payload,
        ['connection', 'disconnectedAtEpochMs', 'reason'],
        'Group presence cleanup AppInbox payload'
    );
    requireEpoch(payload.disconnectedAtEpochMs, 'Group presence cleanup disconnect time');
    requireString(payload.reason, 'Group presence cleanup reason');
    return {
        connection: decodeClientAuthorisedWsSessionConnectAppInboxPayload(
            decodeJsonWireValue(payload.connection, 'Group presence cleanup connection')
        ),
        disconnectedAtEpochMs: Number(payload.disconnectedAtEpochMs),
        reason: payload.reason
    };
}
