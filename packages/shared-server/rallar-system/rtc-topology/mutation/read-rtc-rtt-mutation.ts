import { RtcRttRepository } from '../persistence/rtc-rtt-repository.ts';
import { compareRtcTopologyIdentifiers } from '../../rtc-topology-identifiers.ts';
import type { RtcRttMutationRead, RtcRttStableRequest } from './rtc-rtt-mutation-contracts.ts';
import { toRtcRttMutationReceiptId } from './rtc-rtt-mutation-identifiers.ts';

export async function readRtcRttMutation(
  repository: RtcRttRepository,
  request: RtcRttStableRequest,
): Promise<RtcRttMutationRead> {
  const receipt = await repository.probeMutationReceiptEntry(
    toRtcRttMutationReceiptId(request.rtt),
  );
  if (receipt) return { receipt };

  const [measurement, measurements, ...endpointAdmissionReads] = await Promise.all([
    repository.readMeasurementEntry(request.rtt.sessionIdFrom, request.rtt.sessionIdTo),
    repository.listMeasurementEntries(),
    ...[...new Set([request.rtt.sessionIdFrom, request.rtt.sessionIdTo])]
      .sort(compareRtcTopologyIdentifiers)
      .map((endpointId) => repository.readEndpointAdmissionEntry(endpointId)),
  ]);
  return {
    receipt: null,
    measurement: measurement.value ?? null,
    expiredMeasurementEntry: measurement.expiredEntry ?? null,
    endpointAdmissions: endpointAdmissionReads.flatMap((read) => (read.value ? [read.value] : [])),
    expiredEndpointAdmissionEntries: endpointAdmissionReads.flatMap((read) =>
      read.expiredEntry ? [read.expiredEntry] : [],
    ),
    measurements,
  };
}
