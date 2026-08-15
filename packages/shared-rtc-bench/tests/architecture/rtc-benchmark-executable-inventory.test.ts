import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const packageRoot = path.join(repoRoot, 'packages/shared-rtc-bench');
const executablePaths = [
  'baseline/command/rtc-baseline-cli.ts',
  'workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
  'workloads/signaling/rtc-ice-candidate-queue-bench.ts',
  'workloads/signaling/rtc-peer-listener-cleanup-bench.ts',
  'workloads/data-channel/rtc-data-channel-replace-key-bench.ts',
  'workloads/data-channel/rtc-data-channel-drain-bench.ts',
  'workloads/data-channel/rtc-data-channel-close-retention-bench.ts',
  'workloads/data-channel/rtc-data-channel-error-reference-bench.ts',
  'workloads/topology/rtc-topology-star-bench.ts',
  'workloads/topology/rtc-topology-tree-no-rtt-bench.ts',
  'workloads/topology/rtc-topology-mesh-no-rtt-bench.ts',
  'workloads/topology/rtc-room-graph-rtt-bench.ts',
  'workloads/topology/rtc-topology-inactive-churn-bench.ts',
  'workloads/topology/rtc-rtt-repository-filter-bench.ts',
  'workloads/multicast/rtc-multicast-serialization-bench.ts',
  'workloads/group-coordination/webrtc-group-cache-fallback-bench.ts',
  'workloads/group-coordination/webrtc-group-manager-state-bench.ts',
  'workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts',
  'workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts',
  'workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs',
  'topology-delivery/delivery-log-bench.ts',
  'topology-replay/replay-drain-operation-counts.ts',
  'diagnostics/room-graph/rtc-room-graph-no-rtt-bench.ts',
  'diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts',
  'diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts',
] as const;

const sourcePaths = [
  'baseline/acceptance/rtc-baseline-evidence-acceptance.ts',
  'baseline/acceptance/rtc-baseline-failure-accounting.ts',
  'baseline/acceptance/rtc-baseline-worker-protocol.ts',
  'baseline/catalog/rtc-baseline-workload-catalog.ts',
  'baseline/catalog/rtc-baseline-workload-manifest.ts',
  'baseline/command/rtc-baseline-cli-grammar.ts',
  'baseline/command/rtc-baseline-cli-options.ts',
  'baseline/command/rtc-baseline-cli.ts',
  'baseline/contracts/rtc-baseline-artifact-decoding.ts',
  'baseline/contracts/rtc-baseline-artifact-validation.ts',
  'baseline/contracts/rtc-baseline-contracts.ts',
  'baseline/contracts/rtc-baseline-decoding.ts',
  'baseline/contracts/rtc-baseline-validation.ts',
  'baseline/evidence/rtc-baseline-evidence-layout.ts',
  'baseline/evidence/rtc-baseline-evidence-store.ts',
  'baseline/evidence/rtc-baseline-finalized-evidence.ts',
  'baseline/evidence/rtc-baseline-finalized-reader.ts',
  'baseline/evidence/rtc-baseline-statistics.ts',
  'baseline/runtime/rtc-baseline-deno-adapters.ts',
  'baseline/runtime/rtc-baseline-deno-runtime.ts',
  'baseline/runtime/rtc-baseline-envelope.ts',
  'baseline/runtime/rtc-baseline-runtime-observation.ts',
  'diagnostics/room-graph/rtc-room-graph-no-rtt-bench.ts',
  'diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts',
  'diagnostics/rtt-traffic/configure-rtc-rtt-traffic-cache-repositories.ts',
  'diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts',
  'topology-delivery/delivery-log-bench.ts',
  'topology-delivery/delivery-log-benchmark-contracts.ts',
  'topology-delivery/run-rtc-topology-delivery-log-workloads.ts',
  'topology-replay/replay-drain-operation-counts.ts',
  'workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs',
  'workloads/browser-lifecycle/rtc-data-channel-browser-soak-validation.ts',
  'workloads/data-channel/rtc-data-channel-close-retention-bench.ts',
  'workloads/data-channel/rtc-data-channel-drain-bench.ts',
  'workloads/data-channel/rtc-data-channel-error-reference-bench.ts',
  'workloads/data-channel/rtc-data-channel-replace-key-bench.ts',
  'workloads/group-coordination/webrtc-group-cache-fallback-bench.ts',
  'workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts',
  'workloads/group-coordination/webrtc-group-manager-state-bench.ts',
  'workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts',
  'workloads/multicast/rtc-multicast-serialization-bench.ts',
  'workloads/signaling/rtc-ice-candidate-queue-bench.ts',
  'workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
  'workloads/signaling/rtc-peer-connection-diagnostics-runtime.ts',
  'workloads/signaling/rtc-peer-listener-cleanup-bench.ts',
  'workloads/topology/create-deterministic-rtc-topology-group-snapshot.ts',
  'workloads/topology/rtc-room-graph-rtt-bench.ts',
  'workloads/topology/rtc-rtt-repository-filter-bench.ts',
  'workloads/topology/rtc-topology-inactive-churn-bench.ts',
  'workloads/topology/rtc-topology-mesh-no-rtt-bench.ts',
  'workloads/topology/rtc-topology-star-bench.ts',
  'workloads/topology/rtc-topology-tree-no-rtt-bench.ts',
  'workloads/topology/synthetic-rtc-rtt-runtime-state-repository.ts',
] as const;

const owningTests = [
  'tests/architecture/rtc-benchmark-executable-inventory.test.ts',
  'tests/architecture/rtc-benchmark-navigation-contract.test.ts',
  'tests/architecture/rtc-benchmark-package-boundaries.test.ts',
  'tests/baseline/acceptance/rtc-performance-baseline-evidence-acceptance.test.ts',
  'tests/baseline/acceptance/rtc-performance-baseline-evidence-failure.test.ts',
  'tests/baseline/acceptance/rtc-baseline-worker-protocol.test.ts',
  'tests/baseline/catalog/rtc-performance-baseline-workload-catalog.test.ts',
  'tests/baseline/catalog/rtc-performance-baseline-workload-manifest.test.ts',
  'tests/baseline/command/rtc-performance-baseline-cli-grammar.test.ts',
  'tests/baseline/command/rtc-performance-baseline-cli.test.ts',
  'tests/baseline/contracts/rtc-performance-baseline-artifact-validation.test.ts',
  'tests/baseline/contracts/rtc-performance-baseline-contract.test.ts',
  'tests/baseline/contracts/rtc-performance-baseline-decoding.test.ts',
  'tests/baseline/contracts/rtc-performance-baseline-validation.test.ts',
  'tests/baseline/evidence/rtc-performance-baseline-evidence-store.test.ts',
  'tests/baseline/evidence/rtc-performance-baseline-finalization.test.ts',
  'tests/baseline/evidence/rtc-performance-baseline-finalized-reader.test.ts',
  'tests/baseline/evidence/rtc-performance-baseline-statistics.test.ts',
  'tests/baseline/runtime/rtc-performance-baseline-deno-adapters.test.ts',
  'tests/baseline/runtime/rtc-performance-baseline-deno-runtime.test.ts',
  'tests/baseline/runtime/rtc-performance-baseline-envelope.test.ts',
  'tests/diagnostics/room-graph/rtc-room-graph-no-rtt-diagnostic.test.ts',
  'tests/diagnostics/rtt-group-scan/rtc-rtt-group-scan-diagnostic.test.ts',
  'tests/diagnostics/rtt-traffic/rtc-topology-rtt-traffic-diagnostic.test.ts',
  'tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts',
  'tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts',
  'tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts',
  'tests/workloads/multicast/rtc-multicast-serialization-bench.test.ts',
  'tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts',
  'tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts',
  'tests/topology-delivery/rtc-topology-delivery-log-performance-harness.test.ts',
  'tests/topology-replay/rtc-topology-replay-drain-performance-harness.test.ts',
] as const;

function filesBelow(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return filesBelow(entryPath);
    }
    return entry.isFile() ? [entryPath] : [];
  });
}

function packageRelative(paths: readonly string[]): string[] {
  return [...paths].map((file) => path.relative(packageRoot, file)).sort();
}

describe('shared RTC benchmark executable inventory', () => {
  it('contains every executable and its owning capability test', () => {
    const missing = [...executablePaths, ...owningTests].filter(
      (entry) => !fs.existsSync(path.join(packageRoot, entry)),
    );
    expect(missing, `missing package targets/tests:\n${missing.join('\n')}`).toEqual([]);
  });

  it('locks the current package source and capability-owned test inventory', () => {
    const actualSources = packageRelative(
      ['baseline', 'diagnostics', 'topology-delivery', 'topology-replay', 'workloads'].flatMap(
        (directory) => filesBelow(path.join(packageRoot, directory)),
      ),
    ).filter((file) => /\.(?:mjs|ts)$/.test(file));
    const actualTests = packageRelative(filesBelow(path.join(packageRoot, 'tests'))).filter(
      (file) => file.endsWith('.test.ts'),
    );

    expect(actualSources).toEqual([...sourcePaths].sort());
    expect(actualTests).toEqual([...owningTests].sort());
  });
});

export { executablePaths };
