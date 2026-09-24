#!/usr/bin/env node
// Reconstructs the delivery-lifecycle timeline for both roles from an ALM control run snapshot.
// usage: node lifecycle-timeline.mjs <snapshot.json> [--all] [--topics=a,b] [--json]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const showAll = args.includes('--all');
const topicFilter = (args.find((a) => a.startsWith('--topics=')) ?? '').slice(9).split(',').filter(Boolean);
const snap = JSON.parse(readFileSync(file, 'utf8'));

const roleOf = (agentId) => agentId?.startsWith('alm-sender') ? 'S' : agentId?.startsWith('alm-receiver') ? 'R' : '?';

// Scenario window: the lifecycle run commands on both agents.
const lifecycleCmds = snap.commands.filter((c) =>
    /delivery-lifecycle-(sender|receiver)-run$/.test(c.envelope.commandId)
);
if (lifecycleCmds.length === 0) {
    console.error('no lifecycle run command');
    process.exit(1);
}
const t0 = Math.min(...lifecycleCmds.map((c) => c.queuedAtEpochMs));
const tEnd = Math.max(...lifecycleCmds.map((c) => c.completedAtEpochMs ?? snap.updatedAtEpochMs));
const rel = (ms) => ((ms - t0) / 1000).toFixed(2).padStart(7);

console.log(`# ${file}`);
console.log(`# runId=${snap.runId} lifecycle window t0=${t0} span=${((tEnd - t0) / 1000).toFixed(1)}s`);
for (const c of lifecycleCmds) {
    console.log(
        `# ${roleOf(c.envelope.agentId)} run queued=${rel(c.queuedAtEpochMs)} dispatched=${
            rel(c.dispatchedAtEpochMs)
        } completed=${c.completedAtEpochMs ? rel(c.completedAtEpochMs) : 'NEVER'}`
    );
}

// Final reports for the lifecycle runs: per-step outcomes.
for (const r of snap.reports) {
    const p = r.payload?.payload ?? r.payload;
    const rid = p?.recipeId ?? p?.report?.recipeId ?? p?.value?.recipeId;
    if (!/delivery-lifecycle/.test(String(rid ?? JSON.stringify(p).slice(0, 200)))) {
        continue;
    }
    console.log(`\n## REPORT ${roleOf(r.agentId)} ${rid} at ${rel(r.atEpochMs)}`);
    const outcomes = p?.outcomes ?? p?.steps ?? p?.commandOutcomes ?? [];
    for (const o of outcomes) {
        const err = o.error ? ` ERR=${o.error.code}: ${String(o.error.message).slice(0, 90)}` : '';
        console.log(
            `  ${String(o.status ?? '').padEnd(9)} ${String(o.kind ?? '').padEnd(18)} ${o.commandId} dur=${
                o.durationMs ?? '?'
            }ms${err}`
        );
    }
    if (outcomes.length === 0) {
        console.log('  (raw) ' + JSON.stringify(p).slice(0, 1500));
    }
}

// Results for the lifecycle runs.
for (const res of snap.results) {
    if (!/delivery-lifecycle/.test(res.commandId)) {
        continue;
    }
    console.log(`\n## RESULT ${roleOf(res.agentId)} ${res.commandId} ok=${res.ok}`);
    const v = res.result ?? res.payload ?? res;
    const steps = v?.value?.results ?? v?.value?.outcomes ?? v?.outcomes ?? [];
    for (const o of steps) {
        const err = o.error
            ? ` ERR=${o.error.code}: ${String(o.error.message).slice(0, 130)} ${
                JSON.stringify(o.error.details ?? {}).slice(0, 400)
            }`
            : '';
        const name = String(o.commandId).replace(/^alm-[a-z-]*?delivery-lifecycle-(sender|receiver)-/, '');
        console.log(
            `  ${rel(o.startedAtEpochMs)} ${String(o.status ?? '').padEnd(7)} ${String(o.kind ?? '').padEnd(17)} ${
                name.padEnd(30)
            } ${String(o.durationMs ?? '?').padStart(6)}ms${err}`
        );
    }
    if (steps.length === 0) {
        console.log('  (raw) ' + JSON.stringify(v).slice(0, 2000));
    }
}

const INTERESTING = [
    'rallar.bb.command.result',
    'rallar.bb.messages.sent',
    'rallar.bb.messages.observed',
    'rallar.bb.messages.cancelled',
    'rallar.bb.messages.received',
    'rallar.bb.messages.receipts',
    'rallar.bb.fault.injected',
    'rallar.browser.messages.send_started',
    'rallar.browser.messages.send_completed',
    'rallar.browser.alm.outbound_diagnostics',
    'rallar.browser.alm.inbound_diagnostics',
    'rallar.browser.messages.rtc.message',
    'rallar.browser.messages.ws.message',
    'rallar.browser.rtc.lifecycle',
    'rallar.browser.ws.lifecycle'
];
const wanted = topicFilter.length ? topicFilter : INTERESTING;

const short = (p) => {
    const t = p.topic;
    const b = p.payload ?? {};
    if (t === 'rallar.bb.command.result') {
        return `${b.kind} ${b.commandId} ${b.status}${
            b.error ? ' ERR=' + b.error.code + ':' + String(b.error.message).slice(0, 70) : ''
        } ${JSON.stringify(b.value ?? {}).slice(0, 260)}`;
    }
    if (t === 'rallar.browser.alm.outbound_diagnostics' || t === 'rallar.browser.alm.inbound_diagnostics') {
        const d = b.data ?? {};
        const keep = [
            'kind',
            'origin',
            'outcome',
            'commitOutcome',
            'reason',
            'msgId',
            'typeId',
            'durationMs',
            'readDurationMs',
            'readOperationCount',
            'commitDurationMs',
            'cause',
            'readyAtMs',
            'claimedCount',
            'completedCount',
            'rescheduledCount',
            'rejectedCount',
            'payloadKind',
            'attempts',
            'queueWaitMs',
            'retained',
            'duplicate',
            'willRetry',
            'submissionAttempted',
            'carrier',
            'state',
            'queued',
            'queuedBehindOrigin',
            'lockName',
            'available'
        ];
        return keep.filter((k) => d[k] !== undefined && d[k] !== null).map((k) =>
            `${k}=${typeof d[k] === 'string' ? d[k].slice(0, 44) : JSON.stringify(d[k])}`
        ).join(' ');
    }
    if (t === 'rallar.browser.messages.rtc.message' || t === 'rallar.browser.messages.ws.message') {
        return `payload=${JSON.stringify(b.data?.payload ?? b.payload ?? b.data ?? {}).slice(0, 170)} msgId=${
            b.msgId ?? b.data?.msgId ?? '?'
        } typeId=${b.typeId ?? b.data?.typeId ?? '?'}`;
    }
    if (t === 'rallar.browser.rtc.lifecycle' || t === 'rallar.browser.ws.lifecycle') {
        const d = b.data ?? b;
        return ['phase', 'stage', 'state', 'event', 'reason', 'peerId', 'laneId', 'status', 'roomId'].filter((k) =>
            d[k] !== undefined
        ).map((k) => `${k}=${String(d[k]).slice(0, 48)}`).join(' ') || JSON.stringify(d).slice(0, 220);
    }
    return JSON.stringify(b).slice(0, 300);
};

console.log('\n## EVENTS');
for (const e of snap.events) {
    if (!showAll && (e.atEpochMs < t0 - 2000 || e.atEpochMs > tEnd + 2000)) {
        continue;
    }
    const p = e.payload ?? {};
    if (!wanted.includes(p.topic)) {
        continue;
    }
    console.log(`${rel(e.atEpochMs)} ${roleOf(e.agentId)} ${String(p.topic).replace('rallar.', '')} | ${short(p)}`);
}
