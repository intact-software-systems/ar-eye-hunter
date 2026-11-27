import { requireExactKeys, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';
import { decodeExactGroupRef } from '../../encoding/decode-exact-group-ref.ts';

export interface CourtAlertMessage {
    readonly type: 'rallar-court-ready';
    readonly lobby: GroupRef;
    readonly offerRevision: number;
    readonly tag: string;
}

export function decodeCourtAlertMessage(value: unknown): CourtAlertMessage {
    const row = requireRecord(value, 'Court notification');
    requireExactKeys(row, ['type','lobby','offerRevision','tag'], 'Court notification');
    if (row.type !== 'rallar-court-ready' || typeof row.tag !== 'string' || !/^[a-f0-9]{32}$/.test(row.tag)) throw new TypeError('Invalid court notification.');
    requirePositiveInteger(row.offerRevision, 'Court offer revision');
    return { type: row.type, lobby: decodeExactGroupRef(row.lobby, 'Notification lobby'), offerRevision: Number(row.offerRevision), tag: row.tag };
}
