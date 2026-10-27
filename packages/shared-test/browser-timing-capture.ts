import type { CDPSession } from '@playwright/test';
import { startRepeating } from '../shared/resilience/start-repeating.ts';
import type { Timers } from '../shared/resilience/timers.ts';

const RENDERER_METRICS = new Set([
    'Timestamp', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration',
    'TaskOtherDuration', 'V8CompileDuration', 'JSHeapUsedSize', 'JSHeapTotalSize',
    'Nodes', 'Documents', 'Frames', 'JSEventListeners', 'LayoutCount', 'RecalcStyleCount'
]);

export namespace BrowserTimingCapture {
    export type Channel = 'renderer' | 'processes';

    export interface Input {
        readonly renderer: Pick<CDPSession, 'send' | 'detach'>;
        readonly browser: Pick<CDPSession, 'send' | 'detach'>;
        readonly timers: Timers;
        /** The caller persists each observation immediately, including partial failed runs. */
        readonly record: (observation: Observation) => void;
    }

    export type Observation = {
        readonly kind: 'stopped';
        readonly stoppedAtEpochMs: number;
    } | {
        readonly kind: 'renderer';
        readonly startedAtEpochMs: number;
        readonly completedAtEpochMs: number;
        readonly metrics: Readonly<Record<string, number>>;
    } | {
        readonly kind: 'processes';
        readonly startedAtEpochMs: number;
        readonly completedAtEpochMs: number;
        readonly processes: readonly {
            readonly id: number;
            readonly type: string;
            readonly cpuTimeSeconds: number;
        }[];
    } | {
        readonly kind: 'failed';
        readonly channel: Channel;
        readonly startedAtEpochMs: number;
        readonly completedAtEpochMs: number;
    } | {
        readonly kind: 'incomplete';
        readonly channel: Channel;
        readonly startedAtEpochMs: number;
        readonly stoppedAtEpochMs: number;
    };
}

/** Owns two independent CDP sampling lifetimes; a blocked renderer cannot hide process CPU evidence. */
export class BrowserTimingCapture {
    private readonly input: BrowserTimingCapture.Input;
    private readonly pending = new Map<BrowserTimingCapture.Channel, number>();
    private readonly cancellations: (() => void)[] = [];
    private stopped = false;
    private started = false;
    private writeFailed = false;

    constructor(input: BrowserTimingCapture.Input) {
        this.input = input;
    }

    async start(): Promise<void> {
        if (this.started || this.stopped) {
            throw new Error('Browser timing capture can only start once');
        }
        this.started = true;
        try {
            await this.input.renderer.send('Performance.enable', { timeDomain: 'timeTicks' });
        }
        catch {
            throw new Error('Browser timing capture could not start');
        }
        for (const channel of ['renderer', 'processes'] as const) {
            this.cancellations.push(startRepeating({
                timers: this.input.timers,
                intervalMs: 1000,
                firstRun: 'now',
                run: () => this.sample(channel)
            }));
        }
    }

    async stop(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        for (const cancel of this.cancellations) {
            cancel();
        }
        try {
            for (const [channel, startedAtEpochMs] of this.pending) {
                this.record({ kind: 'incomplete', channel, startedAtEpochMs, stoppedAtEpochMs: this.input.timers.nowMs() });
            }
        }
        finally {
            // Detaching aborts outstanding protocol reads; they must not block fixture teardown.
            const results = await Promise.allSettled([this.input.renderer.detach(), this.input.browser.detach()]);
            if (results.some((result) => result.status === 'rejected')) {
                throw new Error('Browser timing capture could not detach');
            }
        }
        this.record({ kind: 'stopped', stoppedAtEpochMs: this.input.timers.nowMs() });
        if (this.writeFailed) {
            throw new Error('Browser timing evidence could not be written');
        }
    }

    private async sample(channel: BrowserTimingCapture.Channel): Promise<void> {
        const startedAtEpochMs = this.input.timers.nowMs();
        this.pending.set(channel, startedAtEpochMs);
        let observation: BrowserTimingCapture.Observation;
        try {
            if (channel === 'renderer') {
                const { metrics } = await this.input.renderer.send('Performance.getMetrics');
                observation = {
                    kind: 'renderer', startedAtEpochMs, completedAtEpochMs: this.input.timers.nowMs(),
                    metrics: Object.fromEntries(metrics.filter((metric) => RENDERER_METRICS.has(metric.name)).map((metric) => [metric.name, metric.value]))
                };
            }
            else {
                const { processInfo } = await this.input.browser.send('SystemInfo.getProcessInfo');
                observation = {
                    kind: 'processes', startedAtEpochMs, completedAtEpochMs: this.input.timers.nowMs(),
                    processes: processInfo.map((process) => ({ id: process.id, type: process.type, cpuTimeSeconds: process.cpuTime }))
                };
            }
        }
        catch {
            // Raw protocol errors can contain page URLs. Preserve failure timing without their contents.
            observation = { kind: 'failed', channel, startedAtEpochMs, completedAtEpochMs: this.input.timers.nowMs() };
        }
        this.pending.delete(channel);
        if (!this.stopped) {
            this.record(observation);
        }
    }

    private record(observation: BrowserTimingCapture.Observation): void {
        try {
            this.input.record(observation);
        }
        catch {
            // Surface storage failure to the fixture, without an unhandled rejection from its timer.
            this.writeFailed = true;
        }
    }
}
