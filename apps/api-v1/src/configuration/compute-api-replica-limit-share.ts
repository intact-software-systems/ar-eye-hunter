/**
 * A replica's share of a limit the whole fleet should enforce: each replica behind one balancer counts only the
 * requests it serves, so it enforces the fleet limit divided among the replicas, rounded up and never below one.
 */
export function computeApiReplicaLimitShare(fleetLimit: number, replicaCount: number): number {
    return Math.max(1, Math.ceil(fleetLimit / replicaCount));
}
