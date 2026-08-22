import { expect, it } from 'vitest';

import * as Package from '@shared-server/mod.ts';
import * as Direct from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

it('keeps the supported RTC topology service package and deep imports identical', () => {
    expect(Package.RallarRtcTopologyService).toBe(Direct.RallarRtcTopologyService);
    expect(Package.planRallarRtcTopologySnapshot).toBe(Direct.planRallarRtcTopologySnapshot);
    expect(new Package.RallarRtcTopologyService()).toBeInstanceOf(Direct.RallarRtcTopologyService);
});

interface DirectRtcTopologyServiceTypeFixture {
    readonly options: Direct.RallarRtcTopologyServiceOptions;
    readonly updateOptions: Direct.RallarRtcTopologyUpdateOptions;
    readonly updateResult: Direct.RallarRtcTopologyUpdateResult;
    readonly rttQueueResult: Direct.RallarRtcTopologyRttQueueResult;
    readonly planningIntent: Direct.RtcTopologyPlanningIntent;
    readonly hysteresisWidths: Direct.RtcTopologyKindHysteresisWidths;
}

function acceptDirectRtcTopologyServiceTypeFixture(
    fixture: DirectRtcTopologyServiceTypeFixture
): DirectRtcTopologyServiceTypeFixture {
    return fixture;
}

function toDeepImportedRttQueueResult(
    result: Package.RallarRtcTopologyRttQueueResult
): Direct.RallarRtcTopologyRttQueueResult {
    return result;
}

function toPackageRttQueueResult(
    result: Direct.RallarRtcTopologyRttQueueResult
): Package.RallarRtcTopologyRttQueueResult {
    return result;
}

void acceptDirectRtcTopologyServiceTypeFixture;
void toDeepImportedRttQueueResult;
void toPackageRttQueueResult;
