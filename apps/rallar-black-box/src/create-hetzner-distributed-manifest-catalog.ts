import {
    createAlmConformance2AgentEntry,
    createAlmConformance3AgentEntry,
    createAlmConformanceExtendedEntries
} from './hetzner/hetzner-alm-manifest-entries.ts';
import type { HetznerDistributedManifestEntry } from './hetzner/hetzner-manifest-entry.ts';
import {
    createDiagnosticRtcMessagesAllPeer50Agent30s20hzTreeEntry,
    createDiagnosticRtcMessagesPrincipal50Agent60m20hzTreeEntry,
    createLongAllPeerEntry,
    createRtcMessagesAllPeer50Agent30s5hzTreeEntry,
    createRtcMessagesMainlineAlternativeEntries,
    createRtcMessagesMediumScaleMatrixEntries,
    createRtcMessagesPrincipal50Agent30s20hzMeshEntry,
    createRtcMessagesPrincipal50Agent30s20hzTreeEntry
} from './hetzner/hetzner-multicast-manifest-entries.ts';
import {
    createCompositeEvidence2AgentEntry,
    createDiagnosticBarrierHealth2AgentEntry,
    createDiagnosticExpectedFailure1AgentEntry,
    createDiagnosticRtcRealtime2Agent20hzStressEntry,
    createGroupAssertions2AgentEntry,
    createHealth2AgentEntry,
    createProviderParity2AgentEntry,
    createRtcAbsenceWait2AgentEntry,
    createRtcRealtime2Agent5sEntry,
    createRtcRealtime3Agent15sEntry,
    createRtcRealtimeStability2Agent30s10hzEntry,
    createRtcRealtimeStability2Agent30s15hzEntry,
    createRtcRealtimeStability2Agent30s20hzEntry,
    createRtcRealtimeStability2Agent30sEntry,
    createRtcRealtimeStability2Agent5sEntry,
    createRtcSmoke2AgentEntry
} from './hetzner/hetzner-rtc-manifest-entries.ts';

export function createHetznerDistributedManifestCatalog(): readonly HetznerDistributedManifestEntry[] {
    return [
        createHealth2AgentEntry(),
        createCompositeEvidence2AgentEntry(),
        createRtcSmoke2AgentEntry(),
        createProviderParity2AgentEntry(),
        createRtcRealtimeStability2Agent5sEntry(),
        createRtcRealtime2Agent5sEntry(),
        createRtcRealtimeStability2Agent30sEntry(),
        createRtcRealtimeStability2Agent30s10hzEntry(),
        createRtcRealtimeStability2Agent30s15hzEntry(),
        createRtcRealtimeStability2Agent30s20hzEntry(),
        createRtcRealtime3Agent15sEntry(),
        createRtcMessagesPrincipal50Agent30s20hzTreeEntry(),
        createRtcMessagesPrincipal50Agent30s20hzMeshEntry(),
        createRtcMessagesAllPeer50Agent30s5hzTreeEntry(),
        ...createRtcMessagesMainlineAlternativeEntries(),
        createRtcAbsenceWait2AgentEntry(),
        createGroupAssertions2AgentEntry(),
        createAlmConformance2AgentEntry(),
        ...createAlmConformanceExtendedEntries(),
        createAlmConformance3AgentEntry(),
        createDiagnosticBarrierHealth2AgentEntry(),
        createDiagnosticExpectedFailure1AgentEntry(),
        createDiagnosticRtcRealtime2Agent20hzStressEntry(),
        createDiagnosticRtcMessagesAllPeer50Agent30s20hzTreeEntry(),
        createDiagnosticRtcMessagesPrincipal50Agent60m20hzTreeEntry(),
        ...[5, 10, 20].map(createLongAllPeerEntry),
        ...createRtcMessagesMediumScaleMatrixEntries()
    ];
}

export {
    HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    type HetznerDistributedManifestEntry
} from './hetzner/hetzner-manifest-entry.ts';
