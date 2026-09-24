#!/usr/bin/env node
// One row per cell: delivery latency of the lifecycle submission, plus the drain/commit load.
import { readFileSync } from 'node:fs';
const roleOf = (a) => a?.startsWith('alm-sender') ? 'S' : a?.startsWith('alm-receiver') ? 'R' : '?';
const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;

for (const file of process.argv.slice(2)) {
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    const life = snap.commands.filter((c) => /delivery-lifecycle-(sender|receiver)-run$/.test(c.envelope.commandId));
    const t0 = Math.min(...life.map((c) => c.queuedAtEpochMs));
    const tEnd = Math.max(...life.map((c) => c.completedAtEpochMs ?? snap.updatedAtEpochMs));
    const rel = (ms) => +((ms - t0) / 1000).toFixed(2);
    let commit = null, adm = null, page = null;
    const outByType = {}, claimByKind = {}, holds = [], drains = [];
    for (const e of snap.events) {
        const p = e.payload ?? {};
        const b = p.payload ?? {};
        const d = b.data ?? {};
        const r = roleOf(e.agentId);
        const inWin = e.atEpochMs >= t0 && e.atEpochMs <= tEnd;
        if (!inWin) {
            continue;
        }
        if (p.topic === 'rallar.browser.alm.outbound_diagnostics') {
            if (d.kind === 'commit-phases') {
                const t = String(d.typeId).replace(/^alm\.conformance\..*\./, 'ALM.');
                (outByType[`${r} ${t}`] ??= []).push(d.commitDurationMs + d.readDurationMs);
                if (
                    r === 'S' && /delivery-lifecycle/.test(String(d.typeId)) && d.origin === 'send' && commit === null
                ) {
                    commit = rel(e.atEpochMs);
                }
            }
            if (d.kind === 'browser-lock-hold') {
                holds.push([r, d.durationMs]);
            }
        }
        if (p.topic === 'rallar.browser.alm.inbound_diagnostics') {
            if (
                d.kind === 'admission-outcome' && /delivery-lifecycle/.test(String(d.typeId)) && r === 'R' &&
                adm === null
            ) {
                adm = rel(e.atEpochMs);
            }
            if (d.kind === 'claim-settled' && r === 'R') {
                (claimByKind[`${d.payloadKind}${/al\.control/.test(String(d.typeId)) ? ':control' : ''}`] ??= []).push(
                    d.durationMs
                );
            }
            if (d.kind === 'effect-drain' && r === 'R') {
                drains.push({ t: rel(e.atEpochMs), dur: d.durationMs, n: d.claimedCount });
            }
        }
        if (
            /messages\.(rtc|ws)\.message$|browser\.(ws|rtc)\.message$/.test(String(p.topic)) && r === 'R' &&
            page === null
        ) {
            const pay = JSON.stringify(d.payload ?? b.payload ?? {});
            if (/delivery-lifecycle/.test(pay)) {
                page = rel(e.atEpochMs);
            }
        }
    }
    const gaps = drains.slice(1).map((x, i) => +(x.t - drains[i].t).toFixed(1));
    console.log(
        `${file.split('/')[0].padEnd(20)} ${file.split('/').pop().replace('-smoke-snapshot.json', '').padEnd(21)}` +
            ` Scommit=${String(commit).padStart(6)} Radm=${String(adm).padStart(6)} Rpage=${String(page).padStart(6)}` +
            ` commit->page=${
                String(page !== null && commit !== null ? +(page - commit).toFixed(1) : 'NEVER').padStart(6)
            }s` +
            ` adm->page=${String(page !== null && adm !== null ? +(page - adm).toFixed(1) : 'NEVER').padStart(6)}s`
    );
    console.log(
        `   R drains n=${drains.length} dur(med)=${med(drains.map((x) => x.dur))} gaps=${JSON.stringify(gaps)}`
    );
    console.log(
        `   R claim-settled medians: ${
            Object.entries(claimByKind).map(([k, v]) => `${k}=${med(v)}ms x${v.length}`).join(' ')
        }`
    );
    console.log(
        `   commit read+write medians: ${
            Object.entries(outByType).map(([k, v]) => `${k}=${med(v)}ms x${v.length}`).join('  ')
        }`
    );
    console.log(
        `   lock holds: S med=${med(holds.filter((h) => h[0] === 'S').map((h) => h[1]))} n=${
            holds.filter((h) => h[0] === 'S').length
        }  R med=${med(holds.filter((h) => h[0] === 'R').map((h) => h[1]))} n=${
            holds.filter((h) => h[0] === 'R').length
        }`
    );
}
