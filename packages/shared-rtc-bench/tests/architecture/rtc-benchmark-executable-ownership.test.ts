import fs from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '../..');
const executableOwnership = [
  {
    executable: 'baseline/command/rtc-baseline-cli.ts',
    semanticTest: 'tests/baseline/command/rtc-performance-baseline-cli.test.ts',
  },
  {
    executable: 'workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
    semanticTest: 'tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/signaling/rtc-ice-candidate-queue-bench.ts',
    semanticTest: 'tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/signaling/rtc-peer-listener-cleanup-bench.ts',
    semanticTest: 'tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/data-channel/rtc-data-channel-replace-key-bench.ts',
    semanticTest: 'tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/data-channel/rtc-data-channel-drain-bench.ts',
    semanticTest: 'tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/data-channel/rtc-data-channel-close-retention-bench.ts',
    semanticTest: 'tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/data-channel/rtc-data-channel-error-reference-bench.ts',
    semanticTest: 'tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/topology/rtc-topology-star-bench.ts',
    semanticTest: 'tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/topology/rtc-topology-tree-no-rtt-bench.ts',
    semanticTest: 'tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/topology/rtc-topology-mesh-no-rtt-bench.ts',
    semanticTest: 'tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/topology/rtc-room-graph-rtt-bench.ts',
    semanticTest: 'tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/topology/rtc-topology-inactive-churn-bench.ts',
    semanticTest: 'tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/topology/rtc-rtt-repository-filter-bench.ts',
    semanticTest: 'tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts',
  },
  {
    executable: 'workloads/multicast/rtc-multicast-serialization-bench.ts',
    semanticTest: 'tests/workloads/multicast/rtc-multicast-serialization-bench.test.ts',
  },
  {
    executable: 'workloads/group-coordination/webrtc-group-cache-fallback-bench.ts',
    semanticTest: 'tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts',
  },
  {
    executable: 'workloads/group-coordination/webrtc-group-manager-state-bench.ts',
    semanticTest: 'tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts',
  },
  {
    executable: 'workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts',
    semanticTest: 'tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts',
  },
  {
    executable: 'workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts',
    semanticTest: 'tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts',
  },
  {
    executable: 'workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs',
    semanticTest: 'tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts',
  },
  {
    executable: 'topology-delivery/delivery-log-bench.ts',
    semanticTest: 'tests/topology-delivery/rtc-topology-delivery-log-performance-harness.test.ts',
  },
  {
    executable: 'topology-replay/replay-drain-operation-counts.ts',
    semanticTest: 'tests/topology-replay/rtc-topology-replay-drain-performance-harness.test.ts',
  },
  {
    executable: 'diagnostics/room-graph/rtc-room-graph-no-rtt-bench.ts',
    semanticTest: 'tests/diagnostics/room-graph/rtc-room-graph-no-rtt-diagnostic.test.ts',
  },
  {
    executable: 'diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts',
    semanticTest: 'tests/diagnostics/rtt-group-scan/rtc-rtt-group-scan-diagnostic.test.ts',
  },
  {
    executable: 'diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts',
    semanticTest: 'tests/diagnostics/rtt-traffic/rtc-topology-rtt-traffic-diagnostic.test.ts',
  },
] as const;

function findMissingExecutableOwnership(
  pathExists: (relativePath: string) => boolean,
): readonly string[] {
  return executableOwnership.flatMap(({ executable, semanticTest }) => [
    ...(pathExists(executable) ? [] : [`executable: ${executable}`]),
    ...(pathExists(semanticTest) ? [] : [`semantic test: ${semanticTest}`]),
  ]);
}

describe('shared RTC benchmark executable ownership', () => {
  it('binds every shipped executable to a capability-owning semantic test', () => {
    const executablePaths = executableOwnership.map(({ executable }) => executable);
    const missing = findMissingExecutableOwnership((relativePath) =>
      fs.existsSync(path.join(packageRoot, relativePath)),
    );

    expect(new Set(executablePaths).size).toBe(executablePaths.length);
    expect(missing, `missing executable ownership:\n${missing.join('\n')}`).toEqual([]);
  });

  it('fails closed when an executable or its semantic owner is absent', () => {
    const [first] = executableOwnership;
    const contractPaths = new Set<string>(
      executableOwnership.flatMap(({ executable, semanticTest }) => [executable, semanticTest]),
    );

    expect(
      findMissingExecutableOwnership(
        (relativePath) => contractPaths.has(relativePath) && relativePath !== first.executable,
      ),
    ).toEqual([`executable: ${first.executable}`]);
    expect(
      findMissingExecutableOwnership(
        (relativePath) => contractPaths.has(relativePath) && relativePath !== first.semanticTest,
      ),
    ).toEqual([`semantic test: ${first.semanticTest}`]);
  });

  it('ignores unrelated package modules and fixtures', () => {
    const availablePaths = new Set<string>([
      ...executableOwnership.flatMap(({ executable, semanticTest }) => [executable, semanticTest]),
      'workloads/topology/unrelated-module.ts',
      'tests/fixtures/unrelated-fixture.ts',
    ]);

    expect(
      findMissingExecutableOwnership((relativePath) => availablePaths.has(relativePath)),
    ).toEqual([]);
  });
});
