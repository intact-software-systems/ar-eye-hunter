import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { RTC_BASELINE_WORKLOAD_CATALOG } from '../../../baseline/catalog/rtc-baseline-workload-catalog.ts';
import { createRtcBaselineWorkerCommand } from '../../../baseline/contracts/rtc-baseline-validation.ts';

function rows(text: string) {
    return text
        .trim()
        .split('\n')
        .map((line) => line.split('\t'));
}

const syntheticFacts = rows(`
RTC-B01/peer-connection-diagnostics-burst/pairs-500	1/5	packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts	peers|--rtc-peers|nonnegative-integer|500|-|-;iceCandidatesPerPeer|--rtc-ice-candidates-per-peer|nonnegative-integer|5|-|-;offerCollisionsPerPeer|--rtc-offer-collisions-per-peer|nonnegative-integer|3|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B01/ice-candidate-queue/candidates-25000	1/5	packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts	candidates|--rtc-candidates|nonnegative-integer|25000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B01/peer-listener-cleanup/peers-10000	1/5	packages/shared-rtc-bench/workloads/signaling/rtc-peer-listener-cleanup-bench.ts	peers|--rtc-peers|nonnegative-integer|10000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B02/data-channel-replace-key/depth-32	3/15	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts	queueDepth|--rtc-queue-depth|nonnegative-integer|32|-|-;replacements|--rtc-replacements|nonnegative-integer|25000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B02/data-channel-replace-key/depth-1000	3/15	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts	queueDepth|--rtc-queue-depth|nonnegative-integer|1000|-|-;replacements|--rtc-replacements|nonnegative-integer|25000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B02/data-channel-replace-key/depth-5000	3/15	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts	queueDepth|--rtc-queue-depth|nonnegative-integer|5000|-|-;replacements|--rtc-replacements|nonnegative-integer|25000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B02/data-channel-drain/depth-32	3/15	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts	queueDepth|--rtc-queue-depth|nonnegative-integer|32|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|256|-|-;highWatermarkBytes|--rtc-high-watermark-bytes|nonnegative-integer|1|-|-;lowWatermarkBytes|--rtc-low-watermark-bytes|nonnegative-integer|0|-|-;overflow|--rtc-overflow|string|replace-by-key|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B02/data-channel-drain/depth-1000	3/15	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts	queueDepth|--rtc-queue-depth|nonnegative-integer|1000|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|256|-|-;highWatermarkBytes|--rtc-high-watermark-bytes|nonnegative-integer|1|-|-;lowWatermarkBytes|--rtc-low-watermark-bytes|nonnegative-integer|0|-|-;overflow|--rtc-overflow|string|replace-by-key|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B02/data-channel-drain/depth-5000	3/15	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts	queueDepth|--rtc-queue-depth|nonnegative-integer|5000|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|256|-|-;highWatermarkBytes|--rtc-high-watermark-bytes|nonnegative-integer|1|-|-;lowWatermarkBytes|--rtc-low-watermark-bytes|nonnegative-integer|0|-|-;overflow|--rtc-overflow|string|replace-by-key|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B02/data-channel-close-retention/queue-32	3/15	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts	queueDepth|--rtc-queue-depth|nonnegative-integer|32|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B02/data-channel-error-reference/fixed	3/15	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts	innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-star/sessions-30	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts	sessions|--rtc-sessions|nonnegative-integer|30|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-star/sessions-100	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts	sessions|--rtc-sessions|nonnegative-integer|100|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-star/sessions-300	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts	sessions|--rtc-sessions|nonnegative-integer|300|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-tree/sessions-30	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|30|-|-;degreeLimit|--rtc-degree-limit|nonnegative-integer|5|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-tree/sessions-100	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|100|-|-;degreeLimit|--rtc-degree-limit|nonnegative-integer|5|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-tree/sessions-300	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|300|-|-;degreeLimit|--rtc-degree-limit|nonnegative-integer|5|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-mesh/sessions-30	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|30|-|-;meshParamK|--rtc-mesh-param-k|nonnegative-integer|2|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-mesh/sessions-100	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|100|-|-;meshParamK|--rtc-mesh-param-k|nonnegative-integer|2|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-mesh/sessions-300	3/15	packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|300|-|-;meshParamK|--rtc-mesh-param-k|nonnegative-integer|2|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/room-graph-rtt-sparse/sessions-30	3/15	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|30|-|-;sparseDegree|--rtc-sparse-degree|nonnegative-integer|4|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/room-graph-rtt-sparse/sessions-100	3/15	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|100|-|-;sparseDegree|--rtc-sparse-degree|nonnegative-integer|4|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/room-graph-rtt-sparse/sessions-300	3/15	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|300|-|-;sparseDegree|--rtc-sparse-degree|nonnegative-integer|4|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/room-graph-rtt-complete/sessions-30	3/15	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|30|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/room-graph-rtt-complete/sessions-100	3/15	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|100|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/room-graph-rtt-complete/sessions-300	3/15	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts	sessions|--rtc-sessions|nonnegative-integer|300|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/rtt-repository-filter/room-5-global-1000	3/15	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts	roomSessions|--rtc-room-sessions|nonnegative-integer|5|-|-;globalMeasurements|--rtc-global-measurements|nonnegative-integer|1000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/rtt-repository-filter/room-5-global-10000	3/15	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts	roomSessions|--rtc-room-sessions|nonnegative-integer|5|-|-;globalMeasurements|--rtc-global-measurements|nonnegative-integer|10000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/rtt-repository-filter/room-5-global-100000	3/15	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts	roomSessions|--rtc-room-sessions|nonnegative-integer|5|-|-;globalMeasurements|--rtc-global-measurements|nonnegative-integer|100000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/rtt-repository-filter/room-30-global-1000	3/15	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts	roomSessions|--rtc-room-sessions|nonnegative-integer|30|-|-;globalMeasurements|--rtc-global-measurements|nonnegative-integer|1000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/rtt-repository-filter/room-30-global-10000	3/15	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts	roomSessions|--rtc-room-sessions|nonnegative-integer|30|-|-;globalMeasurements|--rtc-global-measurements|nonnegative-integer|10000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/rtt-repository-filter/room-30-global-100000	3/15	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts	roomSessions|--rtc-room-sessions|nonnegative-integer|30|-|-;globalMeasurements|--rtc-global-measurements|nonnegative-integer|100000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B03/topology-inactive-churn/mode-retain	1/5	packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts	mode|--rtc-mode|string|retain|-|-;groups|--rtc-groups|nonnegative-integer|10000|-|-;sessionsPerGroup|--rtc-sessions-per-group|nonnegative-integer|5|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|3|-|-
RTC-B03/topology-inactive-churn/mode-cleanup	1/5	packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts	mode|--rtc-mode|string|cleanup|-|-;groups|--rtc-groups|nonnegative-integer|10000|-|-;sessionsPerGroup|--rtc-sessions-per-group|nonnegative-integer|5|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|3|-|-
RTC-B04/multicast-serialization/peers-10-payload-4096	3/15	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts	peers|--rtc-peers|nonnegative-integer|10|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|4096|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/multicast-serialization/peers-10-payload-65536	3/15	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts	peers|--rtc-peers|nonnegative-integer|10|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|65536|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/multicast-serialization/peers-100-payload-4096	3/15	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts	peers|--rtc-peers|nonnegative-integer|100|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|4096|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/multicast-serialization/peers-100-payload-65536	3/15	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts	peers|--rtc-peers|nonnegative-integer|100|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|65536|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/multicast-serialization/peers-1000-payload-4096	3/15	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts	peers|--rtc-peers|nonnegative-integer|1000|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|4096|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/multicast-serialization/peers-1000-payload-65536	3/15	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts	peers|--rtc-peers|nonnegative-integer|1000|-|-;payloadBytes|--rtc-payload-bytes|nonnegative-integer|65536|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/group-cache-fallback/fixed	3/15	packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-cache-fallback-bench.ts	snapshots|--rtc-snapshots|nonnegative-integer|20000|-|-;matchingVersions|--rtc-matching-versions|nonnegative-integer|5000|-|-;lookups|--rtc-lookups|nonnegative-integer|500|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/group-manager-state/fixed	3/15	packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-state-bench.ts	clients|--rtc-clients|nonnegative-integer|5000|-|-;desired|--rtc-desired|nonnegative-integer|1000|-|-;lookups|--rtc-lookups|nonnegative-integer|20|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/group-manager-peer-owners/fixed	3/15	packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts	groups|--rtc-groups|nonnegative-integer|1000|-|-;peersPerGroup|--rtc-peers-per-group|nonnegative-integer|10|-|-;lookups|--rtc-lookups|nonnegative-integer|1000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
RTC-B04/heartbeat-callback-churn/fixed	3/15	packages/shared-rtc-bench/workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts	channels|--rtc-channels|nonnegative-integer|10000|-|-;innerRuns|--rtc-inner-runs|nonnegative-integer|5|-|-
`);

const syntheticSourceFacts = rows(`
RTC-B01/peer-connection-diagnostics-burst/pairs-500	packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts
RTC-B01/ice-candidate-queue/candidates-25000	packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts
RTC-B01/peer-listener-cleanup/peers-10000	packages/shared-rtc-bench/workloads/signaling/rtc-peer-listener-cleanup-bench.ts
RTC-B02/data-channel-replace-key/depth-32	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts
RTC-B02/data-channel-replace-key/depth-1000	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts
RTC-B02/data-channel-replace-key/depth-5000	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts
RTC-B02/data-channel-drain/depth-32	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts
RTC-B02/data-channel-drain/depth-1000	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts
RTC-B02/data-channel-drain/depth-5000	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts
RTC-B02/data-channel-close-retention/queue-32	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts
RTC-B02/data-channel-error-reference/fixed	packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts
RTC-B03/topology-star/sessions-30	packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts
RTC-B03/topology-star/sessions-100	packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts
RTC-B03/topology-star/sessions-300	packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts
RTC-B03/topology-tree/sessions-30	packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts
RTC-B03/topology-tree/sessions-100	packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts
RTC-B03/topology-tree/sessions-300	packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts
RTC-B03/topology-mesh/sessions-30	packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts
RTC-B03/topology-mesh/sessions-100	packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts
RTC-B03/topology-mesh/sessions-300	packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts
RTC-B03/room-graph-rtt-sparse/sessions-30	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts
RTC-B03/room-graph-rtt-sparse/sessions-100	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts
RTC-B03/room-graph-rtt-sparse/sessions-300	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts
RTC-B03/room-graph-rtt-complete/sessions-30	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts
RTC-B03/room-graph-rtt-complete/sessions-100	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts
RTC-B03/room-graph-rtt-complete/sessions-300	packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts
RTC-B03/rtt-repository-filter/room-5-global-1000	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts
RTC-B03/rtt-repository-filter/room-5-global-10000	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts
RTC-B03/rtt-repository-filter/room-5-global-100000	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts
RTC-B03/rtt-repository-filter/room-30-global-1000	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts
RTC-B03/rtt-repository-filter/room-30-global-10000	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts
RTC-B03/rtt-repository-filter/room-30-global-100000	packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts
RTC-B03/topology-inactive-churn/mode-retain	packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts
RTC-B03/topology-inactive-churn/mode-cleanup	packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts
RTC-B04/multicast-serialization/peers-10-payload-4096	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts
RTC-B04/multicast-serialization/peers-10-payload-65536	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts
RTC-B04/multicast-serialization/peers-100-payload-4096	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts
RTC-B04/multicast-serialization/peers-100-payload-65536	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts
RTC-B04/multicast-serialization/peers-1000-payload-4096	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts
RTC-B04/multicast-serialization/peers-1000-payload-65536	packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts
RTC-B04/group-cache-fallback/fixed	packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-cache-fallback-bench.ts
RTC-B04/group-manager-state/fixed	packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-state-bench.ts
RTC-B04/group-manager-peer-owners/fixed	packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts
RTC-B04/heartbeat-callback-churn/fixed	packages/shared-rtc-bench/workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts
`);

const fullStackFacts = rows(`
RTC-B06/default/e3-memory-default	1/5	npm:run,test:rallar:full-stack:memory:live-rtc-3	allScenarios|--rtc-all-scenarios|boolean|false|-|-;retentionSoak|--rtc-retention-soak|boolean|false|-|-;retentionCycles|--rtc-retention-cycles|nonnegative-integer|0|-|-;databaseProvider|--rtc-database-provider|string|memory|-|-;iceMode|--rtc-ice-mode|string|repository-default|-|-	-
RTC-B06/all-scenarios/e3-memory-all-scenarios	1/3	npm:run,test:rallar:full-stack:memory:live-rtc-3	allScenarios|--rtc-all-scenarios|boolean|true|RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS|reject;retentionSoak|--rtc-retention-soak|boolean|false|-|-;retentionCycles|--rtc-retention-cycles|nonnegative-integer|0|-|-;databaseProvider|--rtc-database-provider|string|memory|-|-;iceMode|--rtc-ice-mode|string|repository-default|-|-	-
RTC-B06/retention-100/e3-memory-retention-100	1/3	npm:run,test:rallar:full-stack:memory:live-rtc-3	allScenarios|--rtc-all-scenarios|boolean|false|-|-;retentionSoak|--rtc-retention-soak|boolean|true|RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK|reject;retentionCycles|--rtc-retention-cycles|nonnegative-integer|100|RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES|reject;databaseProvider|--rtc-database-provider|string|memory|-|-;iceMode|--rtc-ice-mode|string|repository-default|-|-	rtc-b06-e3-memory-retention
RTC-B06/default/e4-pg-default	1/5	npm:run,test:rallar:full-stack:postgres:live-rtc-3	allScenarios|--rtc-all-scenarios|boolean|false|-|-;retentionSoak|--rtc-retention-soak|boolean|false|-|-;retentionCycles|--rtc-retention-cycles|nonnegative-integer|0|-|-;databaseProvider|--rtc-database-provider|string|postgres|-|-;iceMode|--rtc-ice-mode|string|local|RALLAR_ICE_MODE|reject	-
RTC-B06/all-scenarios/e4-pg-all-scenarios	1/3	npm:run,test:rallar:full-stack:postgres:live-rtc-3:all	allScenarios|--rtc-all-scenarios|boolean|true|RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS|reject;retentionSoak|--rtc-retention-soak|boolean|false|-|-;retentionCycles|--rtc-retention-cycles|nonnegative-integer|0|-|-;databaseProvider|--rtc-database-provider|string|postgres|-|-;iceMode|--rtc-ice-mode|string|local|RALLAR_ICE_MODE|reject	-
RTC-B06/retention-100/e4-pg-retention-100	1/3	npm:run,test:rallar:full-stack:postgres:live-rtc-3	allScenarios|--rtc-all-scenarios|boolean|false|-|-;retentionSoak|--rtc-retention-soak|boolean|true|RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK|reject;retentionCycles|--rtc-retention-cycles|nonnegative-integer|100|RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES|reject;databaseProvider|--rtc-database-provider|string|postgres|-|-;iceMode|--rtc-ice-mode|string|local|RALLAR_ICE_MODE|reject	rtc-b06-e4-pg-retention
`);

describe('RTC baseline workload catalog', () => {
    it('owns every B01-B06 identity, order, evidence, sample, runtime, source, config, descriptor, environment, and cohort fact', () => {
        const synthetic = RTC_BASELINE_WORKLOAD_CATALOG.slice(0, 4).flatMap((workload) =>
            workload.cases.map((entry) => [
                `${workload.workloadId}/${entry.caseId}/${entry.inputKey}`,
                `${entry.warmupOuterAttempts ?? workload.warmupOuterAttempts}/${entry.retainedOuterAttempts ?? workload.retainedOuterAttempts}`,
                entry.runtime.prefixArguments.at(-1),
                entry.configuration
                    .map((field) =>
                        [
                            field.field,
                            field.flag,
                            field.scalarKind,
                            String(field.defaultValue),
                            field.allowlistedEnvironmentVariable ?? '-',
                            field.environmentUnsetBehavior ?? '-'
                        ].join('|')
                    )
                    .join(';')
            ])
        );
        expect(synthetic).toEqual(syntheticFacts);
        expect([
            ...new Set(
                RTC_BASELINE_WORKLOAD_CATALOG.slice(0, 4).flatMap((workload) =>
                    workload.cases.map(
                        (entry) =>
                            `${workload.evidenceClass}|${entry.runtime.executable}|${entry.runtime.prefixArguments.slice(0, -1).join(',')}|${
                                entry.configPaths.join(',')
                            }`
                    )
                )
            )
        ]).toEqual([
            'synthetic-path|deno|run,--config=packages/shared-rtc-bench/deno.json,--allow-read,--allow-write|packages/shared-rtc-bench/deno.json'
        ]);
        expect(
            RTC_BASELINE_WORKLOAD_CATALOG.slice(0, 4).flatMap((workload) =>
                workload.cases.map((entry) => [
                    `${workload.workloadId}/${entry.caseId}/${entry.inputKey}`,
                    entry.sourcePaths.join(',')
                ])
            )
        ).toEqual(syntheticSourceFacts);

        const b05 = RTC_BASELINE_WORKLOAD_CATALOG[4]!;
        expect({
            evidence: b05.evidenceClass,
            attempts: `${b05.warmupOuterAttempts}/${b05.retainedOuterAttempts}`,
            runtime: b05.cases[0]?.runtime,
            source: b05.cases[0]?.sourcePaths,
            config: b05.cases[0]?.configPaths,
            descriptors: b05.cases[0]?.configuration
        }).toEqual({
            evidence: 'native-browser',
            attempts: '1/5',
            runtime: {
                executable: 'node',
                prefixArguments: [
                    'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs'
                ]
            },
            source: [
                'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs'
            ],
            config: ['apps/rallar-black-box/playwright.config.ts'],
            descriptors: [
                {
                    caseKey: {
                        workloadId: 'RTC-B05',
                        caseId: 'browser-data-channel-lifecycle',
                        inputKey: 'iterations-25'
                    },
                    field: 'iterations',
                    flag: '--rtc-iterations',
                    scalarKind: 'nonnegative-integer',
                    defaultValue: 25,
                    allowlistedEnvironmentVariable: null,
                    environmentUnsetBehavior: null
                }
            ]
        });

        const fullStack = RTC_BASELINE_WORKLOAD_CATALOG[5]!;
        expect(
            fullStack.cases.map((entry) => [
                `${fullStack.workloadId}/${entry.caseId}/${entry.inputKey}`,
                `${entry.warmupOuterAttempts}/${entry.retainedOuterAttempts}`,
                `${entry.runtime.executable}:${entry.runtime.prefixArguments.join(',')}`,
                entry.configuration
                    .map((field) =>
                        [
                            field.field,
                            field.flag,
                            field.scalarKind,
                            String(field.defaultValue),
                            field.allowlistedEnvironmentVariable ?? '-',
                            field.environmentUnsetBehavior ?? '-'
                        ].join('|')
                    )
                    .join(';'),
                entry.cohortId ?? '-'
            ])
        ).toEqual(fullStackFacts);
        expect(fullStack.evidenceClass).toBe('local-full-stack');
        expect(fullStack.cases.map((entry) => entry.sourcePaths)).toEqual([
            ['tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts'],
            ['tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts'],
            ['tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts'],
            ['tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts'],
            ['tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts'],
            ['tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts']
        ]);
        expect(fullStack.cases.map((entry) => entry.configPaths)).toEqual([
            ['apps/rallar-black-box/playwright.config.ts'],
            ['apps/rallar-black-box/playwright.config.ts'],
            ['apps/rallar-black-box/playwright.config.ts'],
            ['apps/rallar-black-box/playwright.config.ts'],
            ['apps/rallar-black-box/playwright.config.ts'],
            ['apps/rallar-black-box/playwright.config.ts']
        ]);
    });

    it('builds the exact executable B01 command from catalog and manifest facts', () => {
        const entry = RTC_BASELINE_WORKLOAD_CATALOG[0].cases[0];
        const command = createRtcBaselineWorkerCommand({
            baselineId: '20260807-0123456789ab-e1-local',
            caseEntry: entry,
            outerAttempt: {
                workloadId: 'RTC-B01',
                caseId: 'peer-connection-diagnostics-burst',
                inputKey: 'pairs-500',
                environmentId: 'E1-local',
                intendedPhase: 'retained',
                outerOrdinal: 1,
                sampleIds: ['sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5']
            },
            resolvedConfiguration: entry.configuration.map((field) => ({
                caseKey: field.caseKey,
                field: field.field,
                value: field.defaultValue,
                source: 'default'
            }))
        });
        expect(command).toEqual({
            ok: true,
            value: {
                redactedArgv: {
                    executable: 'deno',
                    arguments: [
                        'run',
                        '--config=packages/shared-rtc-bench/deno.json',
                        '--allow-read',
                        '--allow-write',
                        'packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
                        '--capture=worker',
                        '--baseline-id=20260807-0123456789ab-e1-local',
                        '--workload=RTC-B01',
                        '--case-id=peer-connection-diagnostics-burst',
                        '--input-key=pairs-500',
                        '--intended-phase=retained',
                        '--outer-ordinal=1',
                        '--sample-ids=sample-1,sample-2,sample-3,sample-4,sample-5',
                        '--rtc-ice-candidates-per-peer=5',
                        '--rtc-inner-runs=5',
                        '--rtc-offer-collisions-per-peer=3',
                        '--rtc-peers=500'
                    ]
                },
                projection: {
                    fixedWorkerFlags: [
                        '--capture=worker',
                        '--baseline-id=20260807-0123456789ab-e1-local',
                        '--workload=RTC-B01',
                        '--case-id=peer-connection-diagnostics-burst',
                        '--input-key=pairs-500',
                        '--intended-phase=retained',
                        '--outer-ordinal=1',
                        '--sample-ids=sample-1,sample-2,sample-3,sample-4,sample-5'
                    ],
                    configurationFlags: [
                        '--rtc-ice-candidates-per-peer=5',
                        '--rtc-inner-runs=5',
                        '--rtc-offer-collisions-per-peer=3',
                        '--rtc-peers=500'
                    ]
                }
            }
        });
        expect(
            existsSync(
                'packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts'
            )
        ).toBe(true);
    });
});
