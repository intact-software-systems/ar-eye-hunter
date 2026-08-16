import { expect, it } from 'vitest';

import {
  planRallarRtcTopologySnapshot as packagePlanSnapshot,
  RallarRtcTopologyService as PackageService,
} from '@shared-server/mod.ts';
import {
  planRallarRtcTopologySnapshot as directPlanSnapshot,
  RallarRtcTopologyService as DirectService,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type {
  RallarRtcTopologyRttQueueResult,
  RallarRtcTopologyServiceOptions,
  RallarRtcTopologyUpdateOptions,
  RallarRtcTopologyUpdateResult,
  RtcTopologyKindHysteresisWidths,
  RtcTopologyPlanningIntent,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

it('keeps the supported RTC topology service package and deep imports identical', () => {
  expect(PackageService).toBe(DirectService);
  expect(packagePlanSnapshot).toBe(directPlanSnapshot);
  expect(new PackageService()).toBeInstanceOf(DirectService);
});

type DirectRtcTopologyServiceTypeFixture = Readonly<{
  options: RallarRtcTopologyServiceOptions;
  updateOptions: RallarRtcTopologyUpdateOptions;
  updateResult: RallarRtcTopologyUpdateResult;
  rttQueueResult: RallarRtcTopologyRttQueueResult;
  planningIntent: RtcTopologyPlanningIntent;
  hysteresisWidths: RtcTopologyKindHysteresisWidths;
}>;

const directRtcTopologyServiceTypeFixture =
  undefined as unknown as DirectRtcTopologyServiceTypeFixture;

void directRtcTopologyServiceTypeFixture;
