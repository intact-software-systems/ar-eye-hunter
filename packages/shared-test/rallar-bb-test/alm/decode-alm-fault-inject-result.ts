import { decodeTransportFaultActedCounts } from '@shared/transport-faults/to-transport-fault-acted-counts.ts';

import type { RallarBlackBoxTestFaultInjectCommand } from '../rallar-black-box-test-contracts.ts';
import { toAlmInvalidRuntimeResultError } from './decode-alm-runtime-result.ts';
import type { RallarBlackBoxTestFaultInjectResultValue } from './rallar-black-box-alm-result-values.ts';

/** A storage or product-socket fault acts on no frame, so only a transport fault's page answer is read. */
export function decodeAlmFaultInjectResultValue(
    value: unknown,
    command: Pick<RallarBlackBoxTestFaultInjectCommand, 'faultId' | 'carrier'>
): RallarBlackBoxTestFaultInjectResultValue {
    if (command.carrier === 'storage' || command.carrier === 'product-socket') {
        return { faultId: command.faultId, injected: true };
    }
    const acted = decodeTransportFaultActedCounts(value);
    if (acted.right === undefined) {
        throw toAlmInvalidRuntimeResultError(`fault.inject result (${acted.left})`);
    }
    return { faultId: command.faultId, injected: true, acted: acted.right };
}
