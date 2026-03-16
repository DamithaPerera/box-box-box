#!/usr/bin/env node
/**
 * Model v2: lap_time = base + oT*(1 + alpha*L) + dT*tire_age*tm
 *
 * score = oS*(nS + alpha*QoS) + oH*(nH + alpha*QoH)
 *       + (dS*qS + dM*qM + dH*qH)*tm
 *       + pits*pit_lane_time
 *
 * QoT = sum of absolute lap numbers where compound T is used
 * qT  = per-stint quadratic accumulator (tire_age-based)
 * alpha = small positive → HARD early is cheaper (HARD-first wins over MED-first)
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

// Precompute per-driver features for a race
function precompute(races, cliff) {
    return races.map(race => {
        const cfg = race.race_config;
        const drivers = Object.entries(race.strategies).map(([posStr, strat]) => {
            const k = parseInt(posStr.replace('pos', ''));
            const pits = (strat.pit_stops || []).slice().sort((a, b) => a.lap - b.lap);
            // Build stints
            const stints = [];
            let prev = 0, tire = strat.starting_tire;
            for (const p of pits) { stints.push({ tire, n: p.lap - prev }); tire = p.to_tire; prev = p.lap; }
            stints.push({ tire, n: cfg.total_laps - prev });
            // Compute features
            let nS=0, nH=0, qS=0, qM=0, qH=0, QoS=0, QoH=0;
            let lap = 1;
            for (const s of stints) {
                const qq = qStint(s.n, cliff);
                // Absolute lap sum for this stint
                const lapStart = lap;
                const lapEnd = lap + s.n - 1;
                const QoStint = s.n * (lapStart + lapEnd) / 2; // sum(lapStart..lapEnd)
                if (s.tire === 'SOFT')       { nS += s.n; qS += qq; QoS += QoStint; }
                else if (s.tire === 'HARD')  { nH += s.n; qH += qq; QoH += QoStint; }
                else                          { qM += qq; } // MEDIUM: oM=0 so QoM doesn't matter
                lap += s.n;
            }
            return { k, driver: strat.driver_id, nS, nH, qS, qM, qH, QoS, QoH, pitCost: pits.length * cfg.pit_lane_time };
        });
        return { drivers, actual: race.finishing_positions, trackTemp: cfg.track_temp };
    });
}

function scoreAll(features, oS, oH, dS, dM, dH, tc, alpha) {
    let correct = 0;
    for (const { drivers, actual, trackTemp } of features) {
        const tm = 1 + tc * (trackTemp - 30);
        const times = {};
        for (const d of drivers) {
            times[d.driver] = oS*(d.nS + alpha*d.QoS) + oH*(d.nH + alpha*d.QoH)
                + (dS*d.qS + dM*d.qM + dH*d.qH)*tm + d.pitCost;
        }
        const pred = Object.keys(times).sort((a, b) => {
            const diff = times[a] - times[b];
            if (Math.abs(diff) < 1e-9) {
                // tiebreaker: lower starting position (driver number) wins
                const ka = features[0]?.drivers?.find(x=>x.driver===a)?.k ?? 99;
                const kb = features[0]?.drivers?.find(x=>x.driver===b)?.k ?? 99;
                return ka - kb;
            }
            return diff;
        });
        // Fix tiebreaker — redo properly
        let ok = true;
        for (let i = 0; i < pred.length; i++) if (pred[i] !== actual[i]) { ok = false; break; }
        if (ok) correct++;
    }
    return correct;
}

function scoreAllFast(features, oS, oH, dS, dM, dH, tc, alpha) {
    let correct = 0;
    for (const { drivers, actual, trackTemp } of features) {
        const tm = 1 + tc * (trackTemp - 30);
        const times = {};
        for (const d of drivers) {
            times[d.driver] = { score: oS*(d.nS + alpha*d.QoS) + oH*(d.nH + alpha*d.QoH)
                + (dS*d.qS + dM*d.qM + dH*d.qH)*tm + d.pitCost, k: d.k };
        }
        const pred = Object.keys(times).sort((a, b) => {
            const diff = times[a].score - times[b].score;
            if (Math.abs(diff) < 1e-9) return times[a].k - times[b].k;
            return diff;
        });
        let ok = true;
        for (let i = 0; i < pred.length; i++) if (pred[i] !== actual[i]) { ok = false; break; }
        if (ok) correct++;
    }
    return correct;
}

function evalTests(oS, oH, dS, dM, dH, tc, alpha, cliff) {
    let correct = 0, total = 0;
    for (let i = 1; i <= 100; i++) {
        const id = String(i).padStart(3, '0');
        const inF = `data/test_cases/inputs/test_${id}.json`;
        const outF = `data/test_cases/expected_outputs/test_${id}.json`;
        if (!fs.existsSync(inF)) continue;
        const tc_race = JSON.parse(fs.readFileSync(inF, 'utf8'));
        const expected = JSON.parse(fs.readFileSync(outF, 'utf8'));
        const cfg = tc_race.race_config;
        const tm = 1 + tc * (cfg.track_temp - 30);
        const times = {};
        for (const [posStr, strat] of Object.entries(tc_race.strategies)) {
            const k = parseInt(posStr.replace('pos', ''));
            const pits = (strat.pit_stops||[]).slice().sort((a,b)=>a.lap-b.lap);
            const stints = []; let prev=0, tire=strat.starting_tire;
            for (const p of pits) { stints.push({tire, n:p.lap-prev}); tire=p.to_tire; prev=p.lap; }
            stints.push({tire, n:cfg.total_laps-prev});
            let nS=0,nH=0,qS=0,qM=0,qH=0,QoS=0,QoH=0;
            let lap=1;
            for (const s of stints) {
                const qq=qStint(s.n,cliff);
                const lapEnd=lap+s.n-1;
                const QoStint=s.n*(lap+lapEnd)/2;
                if(s.tire==='SOFT'){nS+=s.n;qS+=qq;QoS+=QoStint;}
                else if(s.tire==='HARD'){nH+=s.n;qH+=qq;QoH+=QoStint;}
                else{qM+=qq;}
                lap+=s.n;
            }
            const pitCost=pits.length*cfg.pit_lane_time;
            times[strat.driver_id] = { score: oS*(nS+alpha*QoS) + oH*(nH+alpha*QoH)
                + (dS*qS+dM*qM+dH*qH)*tm + pitCost, k };
        }
        const pred = Object.keys(times).sort((a,b)=>{
            const d=times[a].score-times[b].score;
            if(Math.abs(d)<1e-9)return times[a].k-times[b].k;
            return d;
        });
        if(pred.join(',')===expected.finishing_positions.join(','))correct++;
        total++;
    }
    return {correct, total};
}

function gridSearch(features, nRaces) {
    // Per-stint params: oS, oH, dS, dM, dH, tc
    // Plus new alpha (small positive)
    const oS_v  = [-1.0, -1.5, -2.0, -2.5, -3.0, -3.5, -4.0];
    const oH_v  = [0.5,  1.0,  1.5,  2.0,  2.5,  3.0];
    const dS_v  = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
    const dM_v  = [0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.09, 0.12];
    const dH_v  = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03];
    const tc_v  = [0, 0.005, 0.01, 0.015, 0.02];
    const alpha_v = [0, 0.0005, 0.001, 0.002, 0.003, 0.005, 0.008, 0.01];

    const total = oS_v.length*oH_v.length*dS_v.length*dM_v.length*dH_v.length*tc_v.length*alpha_v.length;
    console.log(`Grid: ${total.toLocaleString()} combos × ${nRaces} races`);

    let best = -1, bestP = null, done = 0;
    for (const oS of oS_v)
    for (const oH of oH_v)
    for (const dS of dS_v)
    for (const dM of dM_v)
    for (const dH of dH_v)
    for (const tc of tc_v)
    for (const alpha of alpha_v) {
        const s = scoreAllFast(features, oS, oH, dS, dM, dH, tc, alpha);
        if (s > best) {
            best = s; bestP = { oS, oH, dS, dM, dH, tc, alpha };
            console.log(`  ${best}/${nRaces} (${(100*best/nRaces).toFixed(1)}%) ${JSON.stringify(bestP)}`);
        }
        done++;
        if (done % 500000 === 0) process.stdout.write(`  ${done.toLocaleString()}/${total.toLocaleString()}\r`);
    }
    return bestP;
}

function main() {
    console.log('Loading races...');
    const races = loadRaces(5);
    const shuffled = races.slice().sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, 500);

    let best = { score: -1, params: null, cliff: 0 };

    for (const cliff of [0, 1, 2]) {
        console.log(`\n=== CLIFF=${cliff} ===`);
        const feat = precompute(sample, cliff);
        const p = gridSearch(feat, sample.length);
        const s = scoreAllFast(feat, p.oS, p.oH, p.dS, p.dM, p.dH, p.tc, p.alpha);
        console.log(`\nGrid best cliff=${cliff}: ${s}/${sample.length} (${(100*s/sample.length).toFixed(1)}%)`);
        if (s > best.score) best = { score: s, params: p, cliff };
    }

    const { params: p, cliff } = best;
    console.log('\n=== FINAL PARAMS ===');
    console.log({ cliff, ...p });

    // Full historical score
    const allFeat = precompute(races, cliff);
    const histScore = scoreAllFast(allFeat, p.oS, p.oH, p.dS, p.dM, p.dH, p.tc, p.alpha);
    console.log(`Full 5k historical: ${histScore}/${races.length} (${(100*histScore/races.length).toFixed(1)}%)`);

    // Test cases
    const testResult = evalTests(p.oS, p.oH, p.dS, p.dM, p.dH, p.tc, p.alpha, cliff);
    console.log(`Test cases: ${testResult.correct}/${testResult.total}`);

    const out = { cliff, ...p };
    fs.writeFileSync('fitted_params.json', JSON.stringify(out, null, 2));
    console.log('\nSaved to fitted_params.json');
    console.log(out);
}

main();
