export interface RtcTopologyReplayServiceScheduler {
  repeat(task: () => void, intervalMs: number): () => void;
  yield(): Promise<void>;
}

export function rotateRtcTopologyReplayPublishers<T>(
  values: readonly T[],
  offset: number,
): readonly T[] {
  if (values.length < 2 || offset === 0) return values;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export const defaultRtcTopologyReplayScheduler: RtcTopologyReplayServiceScheduler = {
  repeat: (task, intervalMs) => {
    const timer = setInterval(task, intervalMs);
    return () => clearInterval(timer);
  },
  yield: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  },
};
