#!/usr/bin/env node
/**
 * Smarter analysis: precompute per-driver feature vectors, then grid-search parameters.
 *
 * Model:
 *   rel_score(d) = offset_S*n_S + offset_H*n_H
 *                + (deg_S*q_S + deg_M*q_M + deg_H*q_H) * tempMult
 *                + n_pits * pit_lane_time
 *
 *   lap_time(T, age) = base + offset[T] + deg[T] * max(0, age - cliff)
 *   tempMult = 1 + tempCoeff * (trackTemp - 30)
 *
 *   n_T  = total laps on tire T
 *   q_T  = Σ_stints_of_T max(0, age - cliff) for each lap
 *        = Σ_stint max(0, (k - cliff)) summed for k=1..stint_laps
 *
 * For ranking, base_lap_time * total_laps cancels (same for all in race).
 * offset_M is implicitly captured: n_S+n_M+n_H = total_laps (constant), so
 * offset_M doesn't affect ranking → set offset_M = 0 (reference).
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ── Load races ───────────────────────────────────────────────────────────────

function loadRaces(nFiles) {
    const dir = 'data/historical_races';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().slice(0, nFiles);
    let races = [];
    for (const f of files) races = races.concat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    console.log(`Loaded ${races.length} races`);
    return races;
}

// ── Compute q_T for a stint of n laps with given cliff ───────────────────────

// q(n, cliff) = sum_{age=1}^{n} max(0, age - cliff)
// = sum_{k=max(0,1-cliff)}^{n-cliff} k  (let k = age - cliff)
// For cliff >= n: 0
// For cliff < n:
//   first positive at age = cliff+1
//   = sum_{k=1}^{n-cliff} k = (n-cliff)*(n-cliff+1)/2
function qStint(n, cliff) {
    if (cliff >= n) return 0;
    const r = n - cliff;
    return r * (r + 1) / 2;
}

// ── Precompute feature vectors for all drivers in a race ─────────────────────

function precomputeFeatures(races, cliff) {
    // Returns array of { race_idx, drivers: [{ driver_id, nS, nM, nH, qS, qM, qH, pitCost }], actual, trackTemp }
    return races.map((race, race_idx) => {
        const cfg = race.race_config;
        const pitPenalty = cfg.pit_lane_time;
        const totalLaps = cfg.total_laps;
        const trackTemp = cfg.track_temp;

        const drivers = Object.values(race.strategies).map(strat => {
            const pitStops = (strat.pit_stops || []).slice().sort((a, b) => a.lap - b.lap);

            // Build stints
            const stints = [];
            let prevLap = 0;
            let curTire = strat.starting_tire;
            for (const pit of pitStops) {
                stints.push({ tire: curTire, n: pit.lap - prevLap });
                curTire = pit.to_tire;
                prevLap = pit.lap;
            }
            stints.push({ tire: curTire, n: totalLaps - prevLap });

            let nS = 0, nM = 0, nH = 0;
            let qS = 0, qM = 0, qH = 0;
            for (const s of stints) {
                const q = qStint(s.n, cliff);
                if (s.tire === 'SOFT')   { nS += s.n; qS += q; }
                else if (s.tire === 'MEDIUM') { nM += s.n; qM += q; }
                else                    { nH += s.n; qH += q; }
            }
            const pitCost = pitStops.length * pitPenalty;

            return { driver_id: strat.driver_id, nS, nM, nH, qS, qM, qH, pitCost };
        });

        return { race_idx, drivers, actual: race.finishing_positions, trackTemp };
    });
}

// ── Score all races with given params ────────────────────────────────────────

function scoreAll(features, oS, oH, dS, dM, dH, tempCoeff) {
    let correct = 0;
    for (const { drivers, actual, trackTemp } of features) {
        const tempMult = 1 + tempCoeff * (trackTemp - 30);
        const times = {};
        for (const d of drivers) {
            times[d.driver_id] = oS * d.nS + oH * d.nH
                + (dS * d.qS + dM * d.qM + dH * d.qH) * tempMult
                + d.pitCost;
        }
        const predicted = Object.keys(times).sort((a, b) => times[a] - times[b]);
        let ok = true;
        for (let i = 0; i < predicted.length; i++) if (predicted[i] !== actual[i]) { ok = false; break; }
        if (ok) correct++;
    }
    return correct;
}

// ── Grid search ───────────────────────────────────────────────────────────────

function gridSearch(features, nRaces) {
    // offset_S values (SOFT faster = more negative)
    const oS_vals  = [-0.5, -1.0, -1.5, -2.0, -2.5, -3.0, -3.5];
    // offset_H values (HARD slower = more positive)
    const oH_vals  = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
    // deg_S (SOFT degrades fastest)
    const dS_vals  = [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20];
    // deg_M
    const dM_vals  = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10];
    // deg_H
    const dH_vals  = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04];
    // temp coefficient (scales all degradation)
    const tc_vals  = [0, 0.002, 0.005, 0.008, 0.01, 0.015, 0.02];

    let bestScore = -1, bestParams = null;
    let total = oS_vals.length * oH_vals.length * dS_vals.length * dM_vals.length * dH_vals.length * tc_vals.length;
    console.log(`Grid search: ${total.toLocaleString()} combinations × ${nRaces} races`);

    let done = 0;
    for (const oS of oS_vals)
    for (const oH of oH_vals)
    for (const dS of dS_vals)
    for (const dM of dM_vals)
    for (const dH of dH_vals)
    for (const tc of tc_vals) {
        const s = scoreAll(features, oS, oH, dS, dM, dH, tc);
        if (s > bestScore) {
            bestScore = s;
            bestParams = { oS, oH, dS, dM, dH, tc };
            process.stdout.write(`  New best: ${s}/${nRaces} (${(100*s/nRaces).toFixed(1)}%) params=${JSON.stringify(bestParams)}\n`);
        }
        done++;
        if (done % 100000 === 0) process.stdout.write(`  ${done.toLocaleString()}/${total.toLocaleString()} done...\r`);
    }

    return bestParams;
}

// ── Fine-tune around best params ─────────────────────────────────────────────

function fineTune(features, nRaces, best) {
    console.log('\n--- Fine-tuning ---');
    const step = 0.01;
    const ranges = {
        oS: [best.oS - 0.5, best.oS + 0.5],
        oH: [best.oH - 0.5, best.oH + 0.5],
        dS: [Math.max(0, best.dS - 0.04), best.dS + 0.04],
        dM: [Math.max(0, best.dM - 0.02), best.dM + 0.02],
        dH: [Math.max(0, best.dH - 0.01), best.dH + 0.01],
        tc: [Math.max(0, best.tc - 0.005), best.tc + 0.005],
    };

    let bestScore = scoreAll(features, best.oS, best.oH, best.dS, best.dM, best.dH, best.tc);
    let bestP = { ...best };

    const arange = (lo, hi, step) => {
        const arr = [];
        for (let v = lo; v <= hi + 1e-9; v += step) arr.push(Math.round(v * 1000) / 1000);
        return arr;
    };

    const oS_v = arange(ranges.oS[0], ranges.oS[1], step);
    const oH_v = arange(ranges.oH[0], ranges.oH[1], step);
    const dS_v = arange(ranges.dS[0], ranges.dS[1], step / 2);
    const dM_v = arange(ranges.dM[0], ranges.dM[1], step / 2);
    const dH_v = arange(ranges.dH[0], ranges.dH[1], step / 4);
    const tc_v = arange(ranges.tc[0], ranges.tc[1], 0.001);

    let cnt = 0, tot = oS_v.length * oH_v.length * dS_v.length * dM_v.length * dH_v.length * tc_v.length;
    console.log(`Fine-tune: ${tot.toLocaleString()} combinations`);

    for (const oS of oS_v)
    for (const oH of oH_v)
    for (const dS of dS_v)
    for (const dM of dM_v)
    for (const dH of dH_v)
    for (const tc of tc_v) {
        const s = scoreAll(features, oS, oH, dS, dM, dH, tc);
        if (s > bestScore) {
            bestScore = s;
            bestP = { oS, oH, dS, dM, dH, tc };
            console.log(`  Fine-tune best: ${s}/${nRaces} params=${JSON.stringify(bestP)}`);
        }
        cnt++;
    }
    return bestP;
}

// ── Evaluate on test cases ────────────────────────────────────────────────────

function evalTestCases(params, cliff) {
    const { oS, oH, dS, dM, dH, tc } = params;
    let correct = 0, total = 0;
    for (let i = 1; i <= 100; i++) {
        const id = String(i).padStart(3, '0');
        const inF = `data/test_cases/inputs/test_${id}.json`;
        const outF = `data/test_cases/expected_outputs/test_${id}.json`;
        if (!fs.existsSync(inF)) continue;
        const tc_race = JSON.parse(fs.readFileSync(inF, 'utf8'));
        const expected = JSON.parse(fs.readFileSync(outF, 'utf8'));

        // Compute features
        const cfg = tc_race.race_config;
        const pitPenalty = cfg.pit_lane_time;
        const totalLaps = cfg.total_laps;
        const trackTemp = cfg.track_temp;
        const tempMult = 1 + tc * (trackTemp - 30);

        const times = {};
        for (const strat of Object.values(tc_race.strategies)) {
            const pitStops = (strat.pit_stops || []).slice().sort((a, b) => a.lap - b.lap);
            const stints = [];
            let prevLap = 0, curTire = strat.starting_tire;
            for (const pit of pitStops) {
                stints.push({ tire: curTire, n: pit.lap - prevLap });
                curTire = pit.to_tire;
                prevLap = pit.lap;
            }
            stints.push({ tire: curTire, n: totalLaps - prevLap });

            let nS=0, nH=0, qS=0, qM=0, qH=0;
            for (const s of stints) {
                const q = qStint(s.n, cliff);
                if (s.tire === 'SOFT')   { nS += s.n; qS += q; }
                else if (s.tire === 'HARD') { nH += s.n; qH += q; }
                else { qM += q; }
            }
            times[strat.driver_id] = oS*nS + oH*nH + (dS*qS + dM*qM + dH*qH)*tempMult + pitStops.length*pitPenalty;
        }
        const predicted = Object.keys(times).sort((a, b) => times[a] - times[b]);
        if (predicted.join(',') === expected.finishing_positions.join(',')) correct++;
        total++;
    }
    console.log(`Test cases: ${correct}/${total} = ${(100*correct/Math.max(1,total)).toFixed(1)}%`);
    return correct;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
    const races = loadRaces(5); // 5000 races

    // Use 500 random races for search
    const shuffled = races.slice().sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, 500);

    let bestOverall = { score: -1, params: null, cliff: 0 };

    for (const cliff of [0, 1, 2]) {
        console.log(`\n=== CLIFF = ${cliff} ===`);
        const features = precomputeFeatures(sample, cliff);

        const best = gridSearch(features, sample.length);
        const score = scoreAll(features, best.oS, best.oH, best.dS, best.dM, best.dH, best.tc);
        console.log(`\nGrid best for cliff=${cliff}: ${score}/${sample.length} = ${(100*score/sample.length).toFixed(1)}%`);
        console.log(best);

        if (score > bestOverall.score) {
            bestOverall = { score, params: best, cliff };
        }
    }

    console.log('\n=== OVERALL BEST ===');
    console.log(bestOverall);

    // Fine-tune best params on larger dataset (2000 races)
    const largerSample = shuffled.slice(0, 2000);
    console.log('\n--- Validating on 2000 races ---');
    const { params, cliff } = bestOverall;
    const featLarge = precomputeFeatures(largerSample, cliff);
    const largeScore = scoreAll(featLarge, params.oS, params.oH, params.dS, params.dM, params.dH, params.tc);
    console.log(`Large sample: ${largeScore}/2000 = ${(100*largeScore/2000).toFixed(1)}%`);

    // Eval test cases
    console.log('\n--- Test cases ---');
    evalTestCases(params, cliff);

    // Save
    const result = { cliff, ...params };
    fs.writeFileSync('fitted_params.json', JSON.stringify(result, null, 2));
    console.log('\nSaved to fitted_params.json');
    console.log(result);
}

main();
