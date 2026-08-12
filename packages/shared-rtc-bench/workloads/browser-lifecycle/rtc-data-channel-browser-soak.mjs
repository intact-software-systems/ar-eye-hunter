import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const iterations = Number(readArg('iterations', '25'));
const out = readArg('out', 'tmp/perf/results/rtc-data-channel-browser-soak.json');

const browser = await chromium.launch({
  headless: true,
});

try {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  const readHeapUsed = async () => {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
    const metrics = await cdp.send('Performance.getMetrics');
    return metrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value;
  };

  await page.setContent('<!doctype html><title>RTC DataChannel soak</title>');
  const heapBefore = await readHeapUsed();
  const startedAt = performance.now();
  const soak = await page.evaluate(async (iterationCount) => {
    async function waitFor(predicate, timeoutMs = 5000) {
      const started = performance.now();
      while (performance.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return false;
    }

    async function runIteration(index) {
      const pcA = new RTCPeerConnection({
        iceServers: [],
      });
      const pcB = new RTCPeerConnection({
        iceServers: [],
      });
      const events = [];

      pcA.onicecandidate = (event) => {
        if (event.candidate) void pcB.addIceCandidate(event.candidate);
      };
      pcB.onicecandidate = (event) => {
        if (event.candidate) void pcA.addIceCandidate(event.candidate);
      };

      const channelA = pcA.createDataChannel(`soak-${index}`);
      let channelB;
      pcB.ondatachannel = (event) => {
        channelB = event.channel;
        channelB.onopen = () => events.push('remote-open');
        channelB.onclose = () => events.push('remote-close');
        channelB.onerror = () => events.push('remote-error');
      };
      channelA.onopen = () => events.push('local-open');
      channelA.onclose = () => events.push('local-close');
      channelA.onerror = () => events.push('local-error');

      const offer = await pcA.createOffer();
      await pcA.setLocalDescription(offer);
      await pcB.setRemoteDescription(offer);
      const answer = await pcB.createAnswer();
      await pcB.setLocalDescription(answer);
      await pcA.setRemoteDescription(answer);

      const opened = await waitFor(
        () => channelA.readyState === 'open' && channelB?.readyState === 'open',
      );
      if (!opened) {
        pcA.close();
        pcB.close();
        return {
          index,
          opened,
          events,
          localState: channelA.readyState,
          remoteState: channelB?.readyState,
        };
      }

      channelA.send(JSON.stringify({ index, ok: true }));
      channelA.close();
      await waitFor(() => channelA.readyState === 'closed' && channelB?.readyState === 'closed');
      pcA.close();
      pcB.close();
      await new Promise((resolve) => setTimeout(resolve, 0));

      return {
        index,
        opened,
        events,
        localState: channelA.readyState,
        remoteState: channelB?.readyState,
        pcAState: pcA.connectionState,
        pcBState: pcB.connectionState,
      };
    }

    const results = [];
    for (let index = 1; index <= iterationCount; index += 1) {
      results.push(await runIteration(index));
    }

    return {
      iterations: iterationCount,
      results,
      openedCount: results.filter((result) => result.opened).length,
      closedCount: results.filter(
        (result) => result.localState === 'closed' && result.remoteState === 'closed',
      ).length,
      localErrorCount: results.filter((result) => result.events.includes('local-error')).length,
      remoteErrorCount: results.filter((result) => result.events.includes('remote-error')).length,
    };
  }, iterations);
  const durationMs = performance.now() - startedAt;
  const heapAfter = await readHeapUsed();

  const output = {
    createdAt: new Date().toISOString(),
    input: {
      iterations,
    },
    durationMs,
    heap: {
      beforeBytes: heapBefore,
      afterBytes: heapAfter,
      deltaBytes:
        heapBefore === undefined || heapAfter === undefined ? undefined : heapAfter - heapBefore,
    },
    soak,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
}
