import type { AlmConformanceVerdictFact } from '../alm-conformance-message-commands.ts';
import type { AlmCarrierOutcome } from './alm-carrier-matrix.ts';

/** A send the product refuses at its call: no handle exists, so its facts are on the refusal the send returned. */
export type AlmCarrierCallRefusal = Extract<AlmCarrierOutcome, Readonly<{ kind: 'refused'; by: 'call'; }>>;

/**
 * What the refusal a send observing `call-refused` returns holds once its call came to `refusal`: one issue, at the
 * cell's path, with the cell's code. Each fact is named for the assertion that reads it.
 */
export function toAlmCallRefusalFacts(refusal: AlmCarrierCallRefusal): readonly AlmConformanceVerdictFact[] {
    return [
        ['one-issue', 'callRefusal', 'length', 1],
        ['issue-path', 'callRefusal.0.path', 'equals', refusal.path],
        ['issue-code', 'callRefusal.0.code', 'equals', refusal.code]
    ];
}
