#!/usr/bin/env node
/**
 * Quick parameter test.
 * Analytically derived from race R21072 constraints:
 *   - dM needs to be ~0.09 (previous grid only went to 0.08)
 *   - dS needs to be ~0.30 (previous grid only went to 0.20)
 *   - oS=-1.5, oH=1.5, dH=0.02
 *   - cliff=0 (degradation from age=1)
 *   - epsilon: small position factor
 *
 * Driver Dk is always at pos k. Score = strategy_score + (k-1)*epsilon
 */
'use strict';
const fs = require('fs');
const path = require('path');

function loadRaces(n) {
    const dir = 'data/historical_races';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().slice(0, n);
    let out = [];
    for (const f of files) out = out.concat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    return out;
}

function qStint(n, cliff) {
    if (cliff >= n) return 0;
    const r = n - cliff;
    return r * (r + 1) / 2;
}

function driverScore(strat, k, cfg, params) {
    const { oS, oH, dS, dM, dH, tc, cliff, epsilon } = params;
    const pits = (strat.pit_stops || []).slice().sort((a, b) => a.lap - b.lap);
    const stints = [];
    let prev = 0, tire = strat.starting_tire;
    for (const p of pits) { stints.push({ tire, n: p.lap - prev }); tire = p.to_tire; prev = p.lap; }
    stints.push({ tire, n: cfg.total_laps - prev });

    const tm = 1 + tc * (cfg.track_temp - 30);
    let nS = 0, nH = 0, qS = 0, qM = 0, qH = 0;
    for (const s of stints) {
        const q = qStint(s.n, cliff);
        if (s.tire === 'SOFT')       { nS += s.n; qS += q; }
        else if (s.tire === 'HARD')  { nH += s.n; qH += q; }
        else                         { qM += q; }
    }
    return oS * nS + oH * nH + (dS * qS + dM * qM + dH * qH) * tm + (k - 1) * epsilon + pits.length * cfg.pit_lane_time;
}

function predictRace(race, params) {
    const cfg = race.race_config;
    const times = {};
    for (const [posStr, strat] of Object.entries(race.strategies)) {
        const k = parseInt(posStr.replace('pos', ''));
        times[strat.driver_id] = driverScore(strat, k, cfg, params);
    }
    return Object.keys(times).sort((a, b) => times[a] - times[b]);
}

function scoreRaces(races, params) {
    let correct = 0;
    for (const race of races) {
        const pred = predictRace(race, params);
        if (pred.join(',') === race.finishing_positions.join(',')) correct++;
    }
    return correct;
}

function evalTests(params) {
    let correct = 0, total = 0;
    for (let i = 1; i <= 100; i++) {
        const id = String(i).padStart(3, '0');
        const inF = `data/test_cases/inputs/test_${id}.json`;
        const outF = `data/test_cases/expected_outputs/test_${id}.json`;
        if (!fs.existsSync(inF)) continue;
        const tc = JSON.parse(fs.readFileSync(inF, 'utf8'));
        const exp = JSON.parse(fs.readFileSync(outF, 'utf8'));
        const pred = predictRace(tc, params);
        if (pred.join(',') === exp.finishing_positions.join(',')) correct++;
        total++;
    }
    return { correct, total };
}

// ── Run a focused grid search with wider dS and dM ranges ────────────────────
function focusedGrid(races) {
    // Based on analytical derivation from R21072:
    // dS ~ 0.25-0.40, dM ~ 0.07-0.12, oH ~ 1.2-1.8, oS ~ -1.2 to -2.0
    const oS_v  = [-1.0, -1.2, -1.5, -1.8, -2.0, -2.5];
    const oH_v  = [1.0, 1.2, 1.5, 1.8, 2.0, 2.5];
    const dS_v  = [0.20, 0.25, 0.28, 0.30, 0.32, 0.35, 0.38, 0.40];
    const dM_v  = [0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.15];
    const dH_v  = [0.01, 0.015, 0.02, 0.025, 0.03];
    const tc_v  = [0, 0.005, 0.01, 0.015, 0.02];
    const eps_v = [0, 0.05, 0.1, 0.2, 0.3];
    const cliff_v = [0, 1];

    const n = races.length;
    const total = oS_v.length * oH_v.length * dS_v.length * dM_v.length * dH_v.length * tc_v.length * eps_v.length * cliff_v.length;
    console.log(`Focused grid: ${total.toLocaleString()} combos × ${n} races`);

    let best = -1, bestP = null;
    let done = 0;

    for (const cliff of cliff_v)
    for (const oS of oS_v)
    for (const oH of oH_v)
    for (const dS of dS_v)
    for (const dM of dM_v)
    for (const dH of dH_v)
    for (const tc of tc_v)
    for (const epsilon of eps_v) {
        const params = { oS, oH, dS, dM, dH, tc, cliff, epsilon };
        const s = scoreRaces(races, params);
        if (s > best) {
            best = s;
            bestP = params;
            console.log(`  ${best}/${n} (${(100*best/n).toFixed(1)}%) ${JSON.stringify(bestP)}`);
        }
        done++;
        if (done % 200000 === 0) process.stdout.write(`  ${done.toLocaleString()}/${total.toLocaleString()}\r`);
    }
    return bestP;
}

function main() {
    // Quick manual test of analytically derived params
    const analyticalParams = {
        oS: -1.5, oH: 1.5,
        dS: 0.30, dM: 0.09, dH: 0.02,
        tc: 0, cliff: 0, epsilon: 0.1
    };

    console.log('=== Testing analytically derived params ===');
    console.log(analyticalParams);

    const races = loadRaces(5);
    const score = scoreRaces(races, analyticalParams);
    console.log(`Historical (5k races): ${score}/${races.length} = ${(100*score/races.length).toFixed(1)}%`);

    const testResult = evalTests(analyticalParams);
    console.log(`Test cases: ${testResult.correct}/${testResult.total} = ${(100*testResult.correct/testResult.total).toFixed(1)}%`);

    // Try a few variants
    const variants = [
        { oS: -1.5, oH: 1.5, dS: 0.30, dM: 0.09, dH: 0.02, tc: 0,     cliff: 0, epsilon: 0.1 },
        { oS: -1.5, oH: 1.5, dS: 0.30, dM: 0.09, dH: 0.02, tc: 0,     cliff: 0, epsilon: 0.2 },
        { oS: -1.5, oH: 1.5, dS: 0.30, dM: 0.09, dH: 0.02, tc: 0.01,  cliff: 0, epsilon: 0.1 },
        { oS: -1.5, oH: 1.5, dS: 0.30, dM: 0.09, dH: 0.02, tc: 0,     cliff: 1, epsilon: 0.1 },
        { oS: -1.5, oH: 1.5, dS: 0.35, dM: 0.09, dH: 0.02, tc: 0,     cliff: 0, epsilon: 0.1 },
        { oS: -1.5, oH: 1.5, dS: 0.25, dM: 0.09, dH: 0.02, tc: 0,     cliff: 0, epsilon: 0.1 },
        { oS: -2.0, oH: 2.0, dS: 0.30, dM: 0.09, dH: 0.02, tc: 0,     cliff: 0, epsilon: 0.1 },
        { oS: -2.0, oH: 2.0, dS: 0.40, dM: 0.12, dH: 0.02, tc: 0,     cliff: 0, epsilon: 0.1 },
        { oS: -1.5, oH: 1.5, dS: 0.30, dM: 0.10, dH: 0.02, tc: 0,     cliff: 0, epsilon: 0.1 },
        { oS: -1.5, oH: 1.5, dS: 0.30, dM: 0.09, dH: 0.015,tc: 0,     cliff: 0, epsilon: 0.1 },
    ];

    console.log('\n=== Testing variants ===');
    for (const p of variants) {
        const s = scoreRaces(races, p);
        const t = evalTests(p);
        console.log(`hist=${s}/${races.length}(${(100*s/races.length).toFixed(1)}%) test=${t.correct}/100 | ${JSON.stringify(p)}`);
    }

    // Run focused grid search
    console.log('\n=== Focused grid search ===');
    const sample = races.slice().sort(() => Math.random() - 0.5).slice(0, 500);
    const best = focusedGrid(sample);
    if (best) {
        const finalHist = scoreRaces(races, best);
        const finalTest = evalTests(best);
        console.log(`\nBest params: ${JSON.stringify(best)}`);
        console.log(`Historical 5k: ${finalHist}/${races.length} = ${(100*finalHist/races.length).toFixed(1)}%`);
        console.log(`Test cases: ${finalTest.correct}/100 = ${finalTest.correct}%`);

        fs.writeFileSync('fitted_params.json', JSON.stringify(best, null, 2));
        console.log('Saved to fitted_params.json');
    }
}

main();
