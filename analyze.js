#!/usr/bin/env node
/**
 * Improved analysis: includes position-based epsilon factor.
 *
 * Key findings from diagnose.js:
 *  1. Driver Dk is ALWAYS at starting position k
 *  2. Lower position always wins when strategies are identical (100% of 202 cases)
 *  3. Identical-strategy pairs CAN have different-strategy drivers between them
 *     → implies a continuous position penalty, not just a tiebreaker
 *
 * Model:
 *   total_score(k) = oS*nS + oH*nH
 *                  + (dS*qS + dM*qM + dH*qH) * tempMult
 *                  + (k-1) * epsilon              ← position penalty
 *                  + nPits * pit_lane_time
 *
 *   tempMult = 1 + tc * (trackTemp - 30)
 *   q(n, cliff) = Σ_{age=1}^{n} max(0, age - cliff) = (n-cliff)*(n-cliff+1)/2 for cliff < n, else 0
 *   offset_M = 0 (reference)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── Load ─────────────────────────────────────────────────────────────────────
function loadRaces(n) {
    const dir = 'data/historical_races';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().slice(0, n);
    let out = [];
    for (const f of files) out = out.concat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    return out;
}

// ── Feature computation ───────────────────────────────────────────────────────
function qStint(n, cliff) {
    if (cliff >= n) return 0;
    const r = n - cliff;
    return r * (r + 1) / 2;
}

function precompute(races, cliff) {
    return races.map(race => {
        const cfg = race.race_config;
        const drivers = Object.entries(race.strategies).map(([posStr, strat]) => {
            const k = parseInt(posStr.replace('pos', ''));  // driver number = pos number
            const pits = (strat.pit_stops || []).slice().sort((a, b) => a.lap - b.lap);
            const stints = [];
            let prev = 0, tire = strat.starting_tire;
            for (const p of pits) { stints.push({ tire, n: p.lap - prev }); tire = p.to_tire; prev = p.lap; }
            stints.push({ tire, n: cfg.total_laps - prev });

            let nS=0, nH=0, qS=0, qM=0, qH=0;
            for (const s of stints) {
                const q = qStint(s.n, cliff);
                if (s.tire === 'SOFT')   { nS += s.n; qS += q; }
                else if (s.tire === 'HARD') { nH += s.n; qH += q; }
                else { qM += q; }
            }
            return { k, driver: strat.driver_id, nS, nH, qS, qM, qH, pitCost: pits.length * cfg.pit_lane_time };
        });
        return { drivers, actual: race.finishing_positions, trackTemp: cfg.track_temp };
    });
}

// ── Score and rank ────────────────────────────────────────────────────────────
function scoreAll(features, oS, oH, dS, dM, dH, tc, epsilon) {
    let correct = 0;
    for (const { drivers, actual, trackTemp } of features) {
        const tm = 1 + tc * (trackTemp - 30);
        const times = {};
        for (const d of drivers) {
            times[d.driver] = oS*d.nS + oH*d.nH + (dS*d.qS + dM*d.qM + dH*d.qH)*tm + (d.k-1)*epsilon + d.pitCost;
        }
        const pred = Object.keys(times).sort((a, b) => times[a] - times[b]);
        let ok = true;
        for (let i = 0; i < pred.length; i++) if (pred[i] !== actual[i]) { ok = false; break; }
        if (ok) correct++;
    }
    return correct;
}

// ── Grid search ───────────────────────────────────────────────────────────────
function gridSearch(features, nRaces) {
    const oS_v  = [-0.5, -1.0, -1.5, -2.0, -2.5, -3.0, -3.5, -4.0];
    const oH_v  = [0.5,  1.0,  1.5,  2.0,  2.5,  3.0,  3.5,  4.0];
    const dS_v  = [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20];
    const dM_v  = [0.005,0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08];
    const dH_v  = [0.002,0.005,0.01, 0.015,0.02, 0.025,0.03];
    const tc_v  = [0, 0.002, 0.005, 0.008, 0.01, 0.015, 0.02];
    const eps_v = [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5];

    const total = oS_v.length * oH_v.length * dS_v.length * dM_v.length * dH_v.length * tc_v.length * eps_v.length;
    console.log(`Grid: ${total.toLocaleString()} combos × ${nRaces} races`);

    let best = -1, bestP = null, done = 0;
    for (const oS of oS_v)
    for (const oH of oH_v)
    for (const dS of dS_v)
    for (const dM of dM_v)
    for (const dH of dH_v)
    for (const tc of tc_v)
    for (const epsilon of eps_v) {
        const s = scoreAll(features, oS, oH, dS, dM, dH, tc, epsilon);
        if (s > best) {
            best = s; bestP = { oS, oH, dS, dM, dH, tc, epsilon };
            console.log(`  ${best}/${nRaces} (${(100*best/nRaces).toFixed(1)}%) ${JSON.stringify(bestP)}`);
        }
        done++;
        if (done % 500000 === 0) process.stdout.write(`  ${done.toLocaleString()}/${total.toLocaleString()}\r`);
    }
    return bestP;
}

// ── Gradient descent refinement ───────────────────────────────────────────────
// For violated pairs (A before B but score(A) >= score(B)), compute gradient and update.
function gradientDescent(features, initP, nRaces, iters = 20000, lr = 0.0001) {
    let { oS, oH, dS, dM, dH, tc, epsilon } = initP;

    for (let iter = 0; iter < iters; iter++) {
        let goS=0, goH=0, gdS=0, gdM=0, gdH=0, gtc=0, geps=0;

        for (const { drivers, actual, trackTemp } of features) {
            const tm = 1 + tc * (trackTemp - 30);
            const scores = {};
            for (const d of drivers)
                scores[d.driver] = oS*d.nS + oH*d.nH + (dS*d.qS + dM*d.qM + dH*d.qH)*tm + (d.k-1)*epsilon + d.pitCost;

            const byDriver = {};
            for (const d of drivers) byDriver[d.driver] = d;

            // For each adjacent pair in actual order, penalise if wrong
            for (let i = 0; i < actual.length - 1; i++) {
                const A = actual[i], B = actual[i+1];
                const margin = scores[A] - scores[B];
                if (margin >= 0) {  // A should be < B but isn't
                    const dA = byDriver[A], dB = byDriver[B];
                    // gradient of (score_A - score_B) w.r.t. params
                    goS  += (dA.nS - dB.nS);
                    goH  += (dA.nH - dB.nH);
                    gdS  += (dA.qS - dB.qS) * tm;
                    gdM  += (dA.qM - dB.qM) * tm;
                    gdH  += (dA.qH - dB.qH) * tm;
                    const degDiff = (dA.qS - dB.qS)*dS + (dA.qM - dB.qM)*dM + (dA.qH - dB.qH)*dH;
                    gtc  += degDiff * (trackTemp - 30);
                    geps += (dA.k - dB.k);
                }
            }
        }

        oS  -= lr * goS;
        oH  -= lr * goH;
        dS  -= lr * gdS;  if (dS < 0) dS = 0;
        dM  -= lr * gdM;  if (dM < 0) dM = 0;
        dH  -= lr * gdH;  if (dH < 0) dH = 0;
        tc  -= lr * gtc;
        epsilon -= lr * geps; if (epsilon < 0) epsilon = 0;

        if (iter % 2000 === 0) {
            const s = scoreAll(features, oS, oH, dS, dM, dH, tc, epsilon);
            console.log(`  iter=${iter} score=${s}/${nRaces} params=${JSON.stringify({ oS:+oS.toFixed(4), oH:+oH.toFixed(4), dS:+dS.toFixed(4), dM:+dM.toFixed(4), dH:+dH.toFixed(4), tc:+tc.toFixed(5), epsilon:+epsilon.toFixed(4) })}`);
        }
    }
    return { oS, oH, dS, dM, dH, tc, epsilon };
}

// ── Eval test cases ───────────────────────────────────────────────────────────
function evalTests(params, cliff) {
    const { oS, oH, dS, dM, dH, tc, epsilon } = params;
    let correct = 0, total = 0;
    for (let i = 1; i <= 100; i++) {
        const id = String(i).padStart(3,'0');
        const inF = `data/test_cases/inputs/test_${id}.json`;
        const outF = `data/test_cases/expected_outputs/test_${id}.json`;
        if (!fs.existsSync(inF)) continue;
        const tc_race = JSON.parse(fs.readFileSync(inF, 'utf8'));
        const expected = JSON.parse(fs.readFileSync(outF, 'utf8'));
        const cfg = tc_race.race_config;
        const tm = 1 + tc * (cfg.track_temp - 30);
        const times = {};
        for (const [posStr, strat] of Object.entries(tc_race.strategies)) {
            const k = parseInt(posStr.replace('pos',''));
            const pits = (strat.pit_stops||[]).slice().sort((a,b)=>a.lap-b.lap);
            const stints = [];
            let prev=0, tire=strat.starting_tire;
            for (const p of pits) { stints.push({tire,n:p.lap-prev}); tire=p.to_tire; prev=p.lap; }
            stints.push({tire,n:cfg.total_laps-prev});
            let nS=0,nH=0,qS=0,qM=0,qH=0;
            for (const s of stints) {
                const q = qStint(s.n, cliff);
                if (s.tire==='SOFT') { nS+=s.n; qS+=q; }
                else if (s.tire==='HARD') { nH+=s.n; qH+=q; }
                else { qM+=q; }
            }
            times[strat.driver_id] = oS*nS + oH*nH + (dS*qS+dM*qM+dH*qH)*tm + (k-1)*epsilon + pits.length*cfg.pit_lane_time;
        }
        const pred = Object.keys(times).sort((a,b)=>times[a]-times[b]);
        if (pred.join(',') === expected.finishing_positions.join(',')) correct++;
        total++;
    }
    console.log(`Test cases: ${correct}/${total} = ${(100*correct/total).toFixed(1)}%`);
    return correct;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
    const races = loadRaces(5);
    const shuffled = races.slice().sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, 500);

    let best = { score: -1, params: null, cliff: 0 };

    for (const cliff of [0, 1]) {
        console.log(`\n=== CLIFF=${cliff} ===`);
        const feat = precompute(sample, cliff);
        const p = gridSearch(feat, sample.length);
        const s = scoreAll(feat, p.oS, p.oH, p.dS, p.dM, p.dH, p.tc, p.epsilon);
        console.log(`\nGrid best cliff=${cliff}: ${s}/${sample.length} (${(100*s/sample.length).toFixed(1)}%)`);

        if (s > best.score) best = { score: s, params: p, cliff };
    }

    console.log('\n=== GRADIENT DESCENT REFINEMENT ===');
    const { params, cliff } = best;
    const largeFeatures = precompute(shuffled.slice(0, 2000), cliff);
    const refined = gradientDescent(largeFeatures, params, 2000, 30000, 0.00001);

    console.log('\n=== FINAL PARAMS ===');
    console.log({ cliff, ...refined });

    const allFeatures = precompute(races, cliff);
    const finalScore = scoreAll(allFeatures, refined.oS, refined.oH, refined.dS, refined.dM, refined.dH, refined.tc, refined.epsilon);
    console.log(`Full 5k score: ${finalScore}/${races.length} (${(100*finalScore/races.length).toFixed(1)}%)`);

    evalTests(refined, cliff);

    fs.writeFileSync('fitted_params.json', JSON.stringify({ cliff, ...refined }, null, 2));
    console.log('\nSaved to fitted_params.json');
}

main();
