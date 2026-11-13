import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';

/**
 * A stored current-version AL message restamped as a row written under an earlier envelope version would read: the
 * version is lowered and `id.traceId`, which only the current version requires, is absent.
 */
export function toEarlierALEnvelopeVersionResource(resource: string, version: number): string {
    if (version >= AL_MESSAGE_ENVELOPE_VERSION) {
        throw new Error(`Expected an envelope version below ${AL_MESSAGE_ENVELOPE_VERSION}, got ${version}`);
    }
    const message = JSON.parse(resource) as ALMessage;
    const { traceId: _traceId, ...id } = message.id;
    return JSON.stringify({ ...message, id: { ...id, v: version } });
}
