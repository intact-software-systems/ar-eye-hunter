import { WebRtcHeartbeatService } from '@shared/services/WebRtcHeartbeatService.ts';

type CallbackDto = Readonly<{
  onMessage: (data: unknown) => Promise<void>;
}>;

type BenchResult = Readonly<{
  run: number;
  durationMs: number;
  channelCount: number;
  retainedCallbacks: number;
  maxCallbacksPerChannel: number;
}>;

const OUT = readArg('--out') ?? 'tmp/perf/results/webrtc-heartbeat-callback-churn.json';
const CHANNELS = Number(readArg('--channels') ?? '10000');
const RUNS = Number(readArg('--runs') ?? '5');

class FakeHeartbeatChannel {
  private readonly callbacks = new Map<string, CallbackDto>();

  onRtcMessageDo(id: string, callback: CallbackDto, _type: string): this {
    this.callbacks.set(id, callback);
    return this;
  }

  removeOnRtcMessageCallbackById(id: string): boolean {
    return this.callbacks.delete(id);
  }

  sendAsJsonString(_data: string): Promise<void> {
    return Promise.resolve();
  }

  isOpen(): boolean {
    return true;
  }

  callbackCount(): number {
    return this.callbacks.size;
  }
}

const results: BenchResult[] = [];

for (let run = 1; run <= RUNS; run++) {
  const channels = Array.from({ length: CHANNELS }, () => new FakeHeartbeatChannel());
  const start = performance.now();

  for (let index = 0; index < channels.length; index++) {
    const service = new WebRtcHeartbeatService({
      sessionId: `self-${index}`,
      peerSessionId: `peer-${index}`,
      channel: channels[index] as never,
      maxMissedPings: 3,
      pingFrequencyMsecs: 60_000,
    });
    service.start({
      onHeartbeat: async () => {},
      onMissedHeartbeat: async () => {},
    });
    service.stop();
  }

  const durationMs = performance.now() - start;
  results.push({
    run,
    durationMs,
    channelCount: CHANNELS,
    retainedCallbacks: channels.reduce((sum, channel) => sum + channel.callbackCount(), 0),
    maxCallbacksPerChannel: Math.max(...channels.map((channel) => channel.callbackCount())),
  });
}

await Deno.writeTextFile(
  OUT,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      input: {
        channelCount: CHANNELS,
        runs: RUNS,
      },
      results,
    },
    null,
    2,
  ),
);

console.log(`Wrote ${OUT}`);

function readArg(name: string): string | undefined {
  return Deno.args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}
