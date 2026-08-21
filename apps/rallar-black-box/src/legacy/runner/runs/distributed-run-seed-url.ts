import { distributedRunSeedIdFromValue, type DistributedRunSeedId } from '../../../distributed-run-seeds.ts';

export function readDistributedRunSeedFromUrl(): DistributedRunSeedId | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }
    const params = new URLSearchParams(window.location.search);
    return distributedRunSeedIdFromValue(params.get('distributedRunSeed'));
}

export function writeDistributedRunSeedToUrl(seedId: DistributedRunSeedId | undefined): void {
    if (typeof window === 'undefined') {
        return;
    }
    const url = new URL(window.location.href);
    if (seedId) {
        url.searchParams.set('distributedRunSeed', seedId);
    }
    else {
        url.searchParams.delete('distributedRunSeed');
    }
    window.history.replaceState(window.history.state, '', url);
}
