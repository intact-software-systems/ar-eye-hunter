export const RTC_TOPOLOGY_HYDRATION_RETRY_DELAYS_MS = [100, 1_000, 5_000, 30_000] as const;

export interface RtcTopologyHydrationScheduler {
    schedule(delayMs: number, task: () => void): () => void;
    yield(): Promise<void>;
}

export const defaultRtcTopologyHydrationScheduler: RtcTopologyHydrationScheduler = {
    schedule: (delayMs, task) => {
        const timer = setTimeout(task, delayMs);
        return () => clearTimeout(timer);
    },
    yield: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
};
