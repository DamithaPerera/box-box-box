#!/usr/bin/env node
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

function stratKey(strat) {
    const stops = (strat.pit_stops||[]).slice().sort((a,b)=>a.lap-b.lap).map(p=>`${p.lap}:${p.from_tire}->${p.to_tire}`).join('|');
    return `${strat.starting_tire}|${stops}`;
}

function compoundDist(strat, totalLaps) {
    const pits = (strat.pit_stops||[]).slice().sort((a,b)=>a.lap-b.lap);
    const stints = [];
    let prev=0, tire=strat.starting_tire;
    for (const p of pits) { stints.push({tire,n:p.lap-prev}); tire=p.to_tire; prev=p.lap; }
    stints.push({tire,n:totalLaps-prev});
    const dist = {SOFT:0,MEDIUM:0,HARD:0};
    for (const s of stints) dist[s.tire] += s.n;
    return dist;
}

// Find pairs with same compound distribution but different ORDER
function findOrderPairs(races) {
    const results = [];
    for (const race of races) {
        const cfg = race.race_config;
        const finishIdx = {};
        race.finishing_positions.forEach((d,i) => finishIdx[d]=i);

        const drivers = Object.entries(race.strategies).map(([pos,strat]) => ({
            pos: parseInt(pos.replace('pos','')),
            driver: strat.driver_id,
            key: stratKey(strat),
            dist: compoundDist(strat, cfg.total_laps),
            stints: (() => {
                const pits = (strat.pit_stops||[]).slice().sort((a,b)=>a.lap-b.lap);
                const stints = []; let prev=0, tire=strat.starting_tire;
                for (const p of pits) { stints.push({tire,n:p.lap-prev}); tire=p.to_tire; prev=p.lap; }
                stints.push({tire,n:cfg.total_laps-prev});
                return stints;
            })(),
            rank: finishIdx[strat.driver_id],
        }));

        // Find pairs with same compound distribution but different order
        for (let i=0; i<drivers.length; i++) {
            for (let j=i+1; j<drivers.length; j++) {
                const a = drivers[i], b = drivers[j];
                const da = a.dist, db = b.dist;
                if (da.SOFT===db.SOFT && da.MEDIUM===db.MEDIUM && da.HARD===db.HARD && a.key!==b.key) {
                    // Same distribution, different order!
                    results.push({
                        race_id: race.race_id, cfg,
                        a: { ...a, nPits: (race.strategies[`pos${a.pos}`].pit_stops||[]).length },
                        b: { ...b, nPits: (race.strategies[`pos${b.pos}`].pit_stops||[]).length },
                        aWins: a.rank < b.rank,
                    });
                }
            }
        }
        if (results.length > 2000) break;
    }
    return results;
}

// Analyze: when compound dist is same but order differs, what predicts winner?
function analyzeOrderEffect(pairs) {
    // Group by (compound dist, number of pits)
    // First, let's just look at 2-stint (1 pit) cases with HARD and MEDIUM
    const twoStint = pairs.filter(p =>
        p.a.stints.length === 2 && p.b.stints.length === 2 &&
        p.a.nPits === 1 && p.b.nPits === 1
    );
    console.log(`\nTotal order-pairs found: ${pairs.length}`);
    console.log(`2-stint pairs: ${twoStint.length}`);

    // For each 2-stint pair, categorize by compound combo
    const comboCounts = {};
    for (const p of twoStint) {
        const comboA = `${p.a.stints[0].tire}(${p.a.stints[0].n})->${p.a.stints[1].tire}(${p.a.stints[1].n})`;
        const comboB = `${p.b.stints[0].tire}(${p.b.stints[0].n})->${p.b.stints[1].tire}(${p.b.stints[1].n})`;
        // Which tire is first in each?
        const tA = p.a.stints[0].tire;
        const tB = p.b.stints[0].tire;
        if (tA === tB) continue; // same first tire — different split points
        const key = `${tA}first vs ${tB}first`;
        if (!comboCounts[key]) comboCounts[key] = {aWins:0,bWins:0,examples:[]};
        if (p.aWins) comboCounts[key].aWins++;
        else comboCounts[key].bWins++;
        if (comboCounts[key].examples.length < 3) comboCounts[key].examples.push(p);
    }

    console.log('\n=== 2-stint order effect ===');
    for (const [key, v] of Object.entries(comboCounts)) {
        const total = v.aWins + v.bWins;
        // a is always listed first in key (e.g. "HARDfirst vs MEDfirst means a=HARDfirst)
        console.log(`${key}: first-mentioned wins ${v.aWins}/${total} (${(100*v.aWins/total).toFixed(1)}%)`);
    }

    return comboCounts;
}

// Now: for a simple HARD-only vs MEDIUM-only race (no pits needed, but we need same compound)
// Actually let's find 1-stint drivers (no pits) and compare SOFT vs HARD vs MED raw speeds

function analyzeSingleStint(races) {
    const data = []; // {tire, n, finishRank, others}
    for (const race of races) {
        const cfg = race.race_config;
        const finishIdx = {};
        race.finishing_positions.forEach((d,i) => finishIdx[d]=i);

        for (const [pos, strat] of Object.entries(race.strategies)) {
            if ((strat.pit_stops||[]).length === 0) {
                // No pits — single compound the whole race
                data.push({
                    tire: strat.starting_tire,
                    n: cfg.total_laps,
                    rank: finishIdx[strat.driver_id],
                    pos: parseInt(pos.replace('pos','')),
                    cfg,
                    driver: strat.driver_id,
                });
            }
        }
        if (data.length > 5000) break;
    }

    console.log(`\n=== Single-stint drivers (no pits): ${data.length} ===`);
    const byCmp = {SOFT:[], MEDIUM:[], HARD:[]};
    for (const d of data) byCmp[d.tire].push(d.rank);
    for (const [t, ranks] of Object.entries(byCmp)) {
        if (ranks.length === 0) continue;
        const avg = ranks.reduce((a,b)=>a+b,0)/ranks.length;
        console.log(`${t}: ${ranks.length} drivers, avg rank=${avg.toFixed(2)}`);
    }
}

// Find races where we can derive model params from constraints
// Key insight: find a race where driver A has ALL SOFT and driver B has ALL HARD
// Their score difference = oS*nS + oH*nH (no degradation since... wait that would need long stints)

// Better: find races with simple 2-driver comparisons
// Driver with SOFT(n)->HARD(m) vs HARD(n)->SOFT(m)
// This directly gives: (oS-oH)*n + (dS-dH)*qStint(n)*tm vs same but swapped
// Per stint: sum is same. But we observe different results → model is NOT per-stint only.

// Let's find races where single-stint drivers of different compounds compete
function findDirectComparisons(races) {
    console.log('\n=== Direct compound comparisons (same race, no-pit drivers) ===');
    let softvmed=0, softvmedWins=0;
    let softvhard=0, softvhardWins=0;
    let medvhard=0, medvhardWins=0;

    for (const race of races) {
        const cfg = race.race_config;
        const finishIdx = {};
        race.finishing_positions.forEach((d,i) => finishIdx[d]=i);

        const noPit = Object.entries(race.strategies)
            .filter(([,s]) => (s.pit_stops||[]).length === 0)
            .map(([pos,s]) => ({tire:s.starting_tire, rank:finishIdx[s.driver_id]}));

        for (let i=0; i<noPit.length; i++) for (let j=i+1; j<noPit.length; j++) {
            const a=noPit[i], b=noPit[j];
            if (a.tire === b.tire) continue;
            const pair = [a,b].sort((x,y)=>x.rank-y.rank);
            const winTire = pair[0].tire;
            const [t1,t2] = [a.tire,b.tire].sort();
            if (t1==='MEDIUM'&&t2==='SOFT') { softvmed++; if(winTire==='SOFT') softvmedWins++; }
            else if (t1==='HARD'&&t2==='SOFT') { softvhard++; if(winTire==='SOFT') softvhardWins++; }
            else if (t1==='HARD'&&t2==='MEDIUM') { medvhard++; if(winTire==='MEDIUM') medvhardWins++; }
        }
    }
    console.log(`SOFT vs MEDIUM: SOFT wins ${softvmedWins}/${softvmed} (${(100*softvmedWins/softvmed).toFixed(1)}%)`);
    console.log(`SOFT vs HARD:   SOFT wins ${softvhardWins}/${softvhard} (${(100*softvhardWins/softvhard).toFixed(1)}%)`);
    console.log(`MEDIUM vs HARD: MED  wins ${medvhardWins}/${medvhard} (${(100*medvhardWins/medvhard).toFixed(1)}%)`);
}

// KEY ANALYSIS: For pairs with same compound dist different order,
// look at the STINT LENGTHS to understand what predicts winner
function analyzeStintLengths(pairs) {
    const twoStint = pairs.filter(p => p.a.stints.length === 2 && p.b.stints.length === 2);

    // Focus on HARD vs MED (2 compounds, 1 pit each)
    const hm = twoStint.filter(p => {
        const tA0=p.a.stints[0].tire, tA1=p.a.stints[1].tire;
        const tB0=p.b.stints[0].tire, tB1=p.b.stints[1].tire;
        const setA = new Set([tA0,tA1]), setB = new Set([tB0,tB1]);
        return setA.has('HARD') && setA.has('MEDIUM') &&
               setB.has('HARD') && setB.has('MEDIUM') &&
               !setA.has('SOFT') && !setB.has('SOFT');
    });

    console.log(`\n=== HARD/MED 2-stint pairs: ${hm.length} ===`);

    // Count: when A=HARD-first vs B=MED-first, who wins?
    let hFirstWins=0, mFirstWins=0;
    for (const p of hm) {
        const aIsHardFirst = p.a.stints[0].tire === 'HARD';
        if (aIsHardFirst && p.aWins) hFirstWins++;
        else if (!aIsHardFirst && !p.aWins) hFirstWins++;
        else mFirstWins++;
    }
    console.log(`HARD-first wins: ${hFirstWins}/${hm.length} (${(100*hFirstWins/hm.length).toFixed(1)}%)`);

    // Now look at examples
    for (const p of hm.slice(0,5)) {
        const aIsHardFirst = p.a.stints[0].tire === 'HARD';
        const winner = p.aWins ? (aIsHardFirst ? 'HARD-first' : 'MED-first') : (aIsHardFirst ? 'MED-first' : 'HARD-first');
        console.log(`Race ${p.race_id}: ${p.a.stints[0].tire}(${p.a.stints[0].n})->${p.a.stints[1].tire}(${p.a.stints[1].n}) [rank${p.a.rank+1}] vs ${p.b.stints[0].tire}(${p.b.stints[0].n})->${p.b.stints[1].tire}(${p.b.stints[1].n}) [rank${p.b.rank+1}] → ${winner} wins`);
    }

    // CRUCIAL: Does pit timing matter when BOTH are HARD-first?
    // E.g., HARD(10)->MED(20) vs HARD(20)->MED(10) — same compounds, different split
    const sameFirstTire = twoStint.filter(p => p.a.stints[0].tire === p.b.stints[0].tire);
    console.log(`\nSame first tire, different split: ${sameFirstTire.length}`);

    // Find cases where first tire is HARD, second is MED, but different split point
    const hardMedSplit = sameFirstTire.filter(p => p.a.stints[0].tire === 'HARD' && p.a.stints[1].tire === 'MEDIUM');
    console.log(`HARD->MED with different split: ${hardMedSplit.length}`);

    // For these: longer first stint vs shorter first stint - who wins?
    let longerFirstWins=0, total=0;
    for (const p of hardMedSplit) {
        total++;
        if (p.a.stints[0].n > p.b.stints[0].n && p.aWins) longerFirstWins++;
        else if (p.a.stints[0].n < p.b.stints[0].n && !p.aWins) longerFirstWins++;
    }
    if (total > 0) console.log(`Longer HARD stint wins: ${longerFirstWins}/${total} (${(100*longerFirstWins/total).toFixed(1)}%)`);

    for (const p of hardMedSplit.slice(0,5)) {
        const winner = p.aWins ? 'A' : 'B';
        console.log(`  A: HARD(${p.a.stints[0].n})->MED(${p.a.stints[1].n}) rank${p.a.rank+1} | B: HARD(${p.b.stints[0].n})->MED(${p.b.stints[1].n}) rank${p.b.rank+1} → ${winner} wins (laps=${p.cfg.total_laps})`);
    }
}

// Derive exact formula from analytical cases
// Look for: Driver A (SOFT, no pit) vs Driver B (HARD, no pit) in same race
// Their time difference = (oS - oH)*N + (dS - dH)*q(N,cliff)*tm
// where both use N total laps, q is quadratic accumulator
// If we have many such pairs with different N, temp, we can fit all params
function deriveSingleStintParams(races) {
    const pairs = [];

    for (const race of races) {
        const cfg = race.race_config;
        const finishIdx = {};
        race.finishing_positions.forEach((d,i) => finishIdx[d]=i);

        const noPit = Object.entries(race.strategies)
            .filter(([,s]) => (s.pit_stops||[]).length === 0)
            .map(([pos,s]) => ({
                tire:s.starting_tire,
                rank:finishIdx[s.driver_id],
                driver:s.driver_id,
                pos:parseInt(pos.replace('pos','')),
                n:cfg.total_laps
            }));

        // Find pairs of different compound no-pit drivers in same race
        for (let i=0; i<noPit.length; i++) for (let j=i+1; j<noPit.length; j++) {
            const a=noPit[i], b=noPit[j];
            if (a.tire === b.tire) continue;
            pairs.push({ a, b, cfg, aFirst: a.rank < b.rank });
        }
        if (pairs.length > 2000) break;
    }

    console.log(`\n=== Single-stint cross-compound pairs: ${pairs.length} ===`);

    // For each pair, the ranking is determined by:
    // score(a) - score(b) = (oA - oB)*N + (dA-dB)*q(N,0)*tm
    // where q(N,0) = N*(N+1)/2
    // If a wins: (oA-oB)*N + (dA-dB)*N*(N+1)/2*tm < 0

    // Show SOFT vs HARD examples with different N
    const sh = pairs.filter(p =>
        (p.a.tire==='SOFT'&&p.b.tire==='HARD') || (p.a.tire==='HARD'&&p.b.tire==='SOFT')
    ).slice(0, 10);

    for (const p of sh) {
        const soft = p.a.tire==='SOFT' ? p.a : p.b;
        const hard = p.a.tire==='HARD' ? p.a : p.b;
        const winner = soft.rank < hard.rank ? 'SOFT' : 'HARD';
        console.log(`N=${p.cfg.total_laps} temp=${p.cfg.track_temp} SOFT(rank${soft.rank+1}) vs HARD(rank${hard.rank+1}) → ${winner} wins`);
    }

    return pairs;
}

// KEY: Look at 2-driver subsets where A has 1 stint and B has 2 stints
// and B's first stint overlaps with A's strategy
// This can isolate degradation parameters

function main() {
    console.log('Loading races...');
    const races = loadRaces(5); // 5000 races
    console.log(`Loaded ${races.length} races`);

    // Direct compound comparisons
    findDirectComparisons(races);

    // Single-stint analysis
    analyzeSingleStint(races);

    // Derive params from single-stint pairs
    const singlePairs = deriveSingleStintParams(races);

    // Order effect analysis
    console.log('\nFinding order pairs...');
    const orderPairs = findOrderPairs(races);
    analyzeOrderEffect(orderPairs);
    analyzeStintLengths(orderPairs);
}

main();
