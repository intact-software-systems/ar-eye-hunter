import { compareRtcTopologyIdentifiers } from '../../topology/persistence/rtc-topology-identifiers.ts';
import { RtcRttRepository } from '../persistence/rtc-rtt-repository.ts';
import type { RtcRttMutationRead, RtcRttStableRequest } from './rtc-rtt-mutation-contracts.ts';
import { toRtcRttMutationReceiptId } from './rtc-rtt-mutation-identifiers.ts';

export async function readRtcRttMutation(
    repository: RtcRttRepository,
    request: RtcRttStableRequest
): Promise<RtcRttMutationRead> {
    const receipt = await repository.probeMutationReceiptEntry(
        toRtcRttMutationReceiptId(request.rtt)
    );
    if (receipt) {
        return { receipt };
    }

    const endpointIds = [...new Set([request.rtt.sessionIdFrom, request.rtt.sessionIdTo])]
        .sort(compareRtcTopologyIdentifiers);
    const [measurement, incidentMeasurements, ...endpointAdmissionReads] = await Promise.all([
        repository.readMeasurementEntry(request.rtt.sessionIdFrom, request.rtt.sessionIdTo),
        repository.listMeasurementEntriesForEndpoints(endpointIds),
        ...endpointIds.map((endpointId) => repository.readEndpointAdmissionEntry(endpointId))
    ]);
    return {
        receipt: null,
        measurement: measurement.value ?? null,
        expiredMeasurementEntry: measurement.expiredEntry ?? null,
        endpointAdmissions: endpointAdmissionReads.flatMap((read) => (read.value ? [read.value] : [])),
        expiredEndpointAdmissionEntries: endpointAdmissionReads.flatMap((read) =>
            read.expiredEntry ? [read.expiredEntry] : []
        ),
        incidentMeasurements
    };
}
