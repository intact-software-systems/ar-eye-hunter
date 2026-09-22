#!/usr/bin/env node
// Per-message loss-stage trace of the delivery-lifecycle scenario.
// usage: node lifecycle-trace.mjs <snapshot.json>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const snap = JSON.parse(readFileSync(file, 'utf8'));
const roleOf = (a) => a?.startsWith('alm-sender') ? 'S' : a?.startsWith('alm-receiver') ? 'R' : '?';
const life = snap.commands.filter((c) => /delivery-lifecycle-(sender|receiver)-run$/.test(c.envelope.commandId));
const t0 = Math.min(...life.map((c) => c.queuedAtEpochMs));
const rel = (ms) => ((ms - t0) / 1000).toFixed(2);

console.log(`### ${file}`);

// 1. Recipe step outcomes per role.
for (const res of snap.results.filter((r) => /delivery-lifecycle/.test(r.commandId))) {
    const v = res.result;
    console.log(`\n-- ${roleOf(res.agentId)} ${res.commandId} ok=${res.ok} dur=${v.durationMs}ms`);
    for (const o of v.value?.results ?? []) {
        const name = o.commandId.replace(/^alm-.*?delivery-lifecycle-(sender|receiver)-/, '');
        const err = o.error ? `  << ${o.error.code}` : '';
        const val = JSON.stringify(o.value ?? {});
        console.log(
            `   ${rel(o.startedAtEpochMs).padStart(6)} ${String(o.status).padEnd(7)} ${name.padEnd(28)} ${
                String(o.durationMs).padStart(6)
            }ms ${val.slice(0, 150)}${err}`
        );
    }
}

// 2. Follow every lifecycle-typed msgId end to end.
const typeRe = /delivery-lifecycle/;
const rows = new Map(); // msgId -> events
const push = (id, line) => {
    if (!rows.has(id)) {
        rows.set(id, []);
    }
    rows.get(id).push(line);
};
const sends = [];
for (const e of snap.events) {
    const p = e.payload ?? {};
    const b = p.payload ?? {};
    const d = b.data ?? {};
    const r = roleOf(e.agentId);
    const t = rel(e.atEpochMs);
    if (p.topic === 'rallar.bb.messages.sent' && typeRe.test(b.commandId ?? '')) {
        sends.push({ t, msgId: b.msgId, handleId: b.handleId, status: b.status, carrier: b.carrier });
        push(b.msgId, `${t} ${r} bb.sent handle=${b.handleId} status=${b.status}`);
    }
    if (
        p.topic === 'rallar.browser.alm.outbound_diagnostics' && d.kind === 'commit-phases' &&
        typeRe.test(d.typeId ?? '')
    ) {
        push(
            d.msgId,
            `${t} ${r} OUT commit origin=${d.origin} outcome=${d.commitOutcome} read=${d.readDurationMs}/${d.readOperationCount} commit=${d.commitDurationMs}`
        );
    }
    if (
        p.topic === 'rallar.browser.alm.inbound_diagnostics' && d.kind === 'admission-outcome' &&
        typeRe.test(d.typeId ?? '')
    ) {
        push(d.msgId, `${t} ${r} IN  admission outcome=${d.outcome} reason=${d.reason}`);
    }
    if (
        p.topic === 'rallar.browser.alm.inbound_diagnostics' && d.kind === 'claim-settled' &&
        typeRe.test(d.typeId ?? '')
    ) {
        push(
            d.msgId,
            `${t} ${r} IN  claim-settled outcome=${d.outcome} payloadKind=${d.payloadKind} attempts=${d.attempts} queueWait=${d.queueWaitMs} dur=${d.durationMs}`
        );
    }
    if (
        (p.topic === 'rallar.browser.messages.rtc.message' || p.topic === 'rallar.browser.messages.ws.message' ||
            p.topic === 'rallar.browser.ws.message' || p.topic === 'rallar.browser.rtc.message') &&
        typeRe.test(b.typeId ?? d.typeId ?? '')
    ) {
        const pay = JSON.stringify(d.payload ?? b.payload ?? {});
        push(b.msgId ?? d.msgId ?? `page-${t}`, `${t} ${r} PAGE message payload=${pay.slice(0, 110)}`);
    }
    if (p.topic === 'rallar.bb.messages.observed' && typeRe.test(b.commandId ?? '')) {
        console.log(
            `\n@@ ${t} ${r} observe ${b.commandId.replace(/^alm-.*?sender-/, '')} -> ${
                b.code ?? JSON.stringify(b).slice(0, 180)
            }`
        );
    }
    if (p.topic === 'rallar.bb.fault.injected' && typeRe.test(b.commandId ?? '')) {
        console.log(
            `\n@@ ${t} ${r} FAULT ${b.commandId.replace(/^alm-.*?sender-/, '')} ${JSON.stringify(b).slice(0, 200)}`
        );
    }
}
console.log('\n-- per-message trace (lifecycle typeId only)');
for (const [id, lines] of rows) {
    console.log(` msgId=${id}`);
    for (const l of lines) {
        console.log(`   ${l}`);
    }
}

// 3. Receiver inbound drains across the window (does one run after the admission?).
console.log('\n-- receiver inbound drains in the window');
for (const e of snap.events) {
    const p = e.payload ?? {};
    const d = p.payload?.data ?? {};
    if (p.topic !== 'rallar.browser.alm.inbound_diagnostics' || d.kind !== 'effect-drain') {
        continue;
    }
    if (roleOf(e.agentId) !== 'R') {
        continue;
    }
    if (e.atEpochMs < t0) {
        continue;
    }
    console.log(
        `   ${
            rel(e.atEpochMs).padStart(6)
        } dur=${d.durationMs} claimed=${d.claimedCount} completed=${d.completedCount} resched=${d.rescheduledCount} rejected=${d.rejectedCount} queueWait=${d.queueWaitMs} sel=${d.selectionDurationMs} claim=${d.claimDurationMs} run=${d.runDurationMs} rel=${d.releaseDurationMs}`
    );
}
// 4. every pending / not-yet-in-sync anywhere in the cell
console.log('\n-- pending / not-yet-in-sync admission outcomes (whole cell)');
for (const e of snap.events) {
    const p = e.payload ?? {};
    const d = p.payload?.data ?? {};
    if (p.topic !== 'rallar.browser.alm.inbound_diagnostics' || d.kind !== 'admission-outcome') {
        continue;
    }
    if (d.outcome === 'committed' && !/sync/.test(String(d.reason))) {
        continue;
    }
    console.log(
        `   ${rel(e.atEpochMs).padStart(7)} ${
            roleOf(e.agentId)
        } outcome=${d.outcome} reason=${d.reason} typeId=${d.typeId} msgId=${String(d.msgId).slice(0, 44)}`
    );
}
