#!/usr/bin/env node
/**
 * Diagnostic script:
 * 1. Find identical-strategy pairs in historical races → confirm position tiebreaker
 * 2. Figure out the position epsilon magnitude
 * 3. Figure out if model is additive or multiplicative w.r.t. base_lap_time
 */
'use strict';
const fs = require('fs');
const path = require('path');

function loadRaces(n) {
    const dir = 'data/historical_races';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().slice(0, n);
    let races = [];
    for (const f of files) races = races.concat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    return races;
}

function strategyKey(strat) {
    const stops = (strat.pit_stops || []).map(p => `${p.lap}:${p.from_tire}->${p.to_tire}`).join('|');
    return `${strat.starting_tire}|${stops}`;
}

// ── 1. Find identical-strategy pairs ─────────────────────────────────────────
function findIdenticalPairs(races) {
    let examples = [];
    for (const race of races) {
        const strats = Object.entries(race.strategies);
        const byKey = {};
        for (const [pos, strat] of strats) {
            const k = strategyKey(strat);
            if (!byKey[k]) byKey[k] = [];
            byKey[k].push({ pos: parseInt(pos.replace('pos', '')), driver: strat.driver_id });
        }
        for (const [key, group] of Object.entries(byKey)) {
            if (group.length >= 2) {
                // Find positions in finishing order
                const finishRanks = {};
                race.finishing_positions.forEach((d, i) => finishRanks[d] = i + 1);
                const ranked = group.map(g => ({
                    ...g,
                    rank: finishRanks[g.driver]
                })).sort((a, b) => a.rank - b.rank);
                // Check if lower pos always finishes first
                const sortedByPos = group.slice().sort((a, b) => a.pos - b.pos);
                const lowerPosFinishesFirst = ranked.every((r, i) => r.pos === sortedByPos[i].pos);
                examples.push({
                    raceId: race.race_id,
                    strategy: key,
                    group: ranked,
                    lowerPosFirst: lowerPosFinishesFirst
                });
            }
        }
        if (examples.length >= 200) break;
    }
    return examples;
}

// ── 2. For identical pairs, estimate position epsilon ─────────────────────────
// The position_epsilon is the time difference per starting position unit.
// When two drivers A (pos_a) and B (pos_b, pos_b > pos_a) have identical strategies,
// and another driver C with different strategy finishes between them:
//   score(A) = S + (pos_a - 1)*ε
//   score(C) = T + (pos_c - 1)*ε
//   score(B) = S + (pos_b - 1)*ε
// Then: T - S is bounded between (pos_a - pos_c)*ε and (pos_b - pos_a)*ε

// Alternative: just look at gaps between races with different strategies between identical pairs.

// ── 3. Check base_lap_time distribution ──────────────────────────────────────
function analyzeBaseTimes(races) {
    const bases = races.map(r => r.race_config.base_lap_time);
    const min = Math.min(...bases), max = Math.max(...bases);
    const mean = bases.reduce((a, b) => a + b, 0) / bases.length;
    console.log(`base_lap_time: min=${min}, max=${max}, mean=${mean.toFixed(2)}, range=${(max-min).toFixed(2)}`);
    const temps = races.map(r => r.race_config.track_temp);
    const tmin = Math.min(...temps), tmax = Math.max(...temps);
    console.log(`track_temp: min=${tmin}, max=${tmax}`);
    const laps = races.map(r => r.race_config.total_laps);
    const lmin = Math.min(...laps), lmax = Math.max(...laps);
    console.log(`total_laps: min=${lmin}, max=${lmax}`);
}

// ── 4. Compute score for a driver (parameterized model) ───────────────────────
// Model: lap_time = base + oS*nS + oH*nH + (dS*qS + dM*qM + dH*qH)*tempMult + (pos-1)*epsilon + pit_cost
// For RANKING within a race, the base*total_laps term cancels.
// tempMult = 1 + tc*(temp-30)
// q_T with cliff

function qStint(n, cliff) {
    if (cliff >= n) return 0;
    const r = n - cliff;
    return r * (r + 1) / 2;
}

function driverScore(strat, startPos, raceConfig, params) {
    const { oS, oH, dS, dM, dH, tc, cliff, epsilon } = params;
    const pitPenalty = raceConfig.pit_lane_time;
    const totalLaps = raceConfig.total_laps;
    const temp = raceConfig.track_temp;
    const tempMult = 1 + tc * (temp - 30);

    const pitStops = (strat.pit_stops || []).slice().sort((a, b) => a.lap - b.lap);
    const stints = [];
    let prev = 0, curTire = strat.starting_tire;
    for (const p of pitStops) {
        stints.push({ tire: curTire, n: p.lap - prev });
        curTire = p.to_tire;
        prev = p.lap;
    }
    stints.push({ tire: curTire, n: totalLaps - prev });

    let nS=0, nH=0, qS=0, qM=0, qH=0;
    for (const s of stints) {
        const q = qStint(s.n, cliff);
        if (s.tire==='SOFT') { nS+=s.n; qS+=q; }
        else if (s.tire==='HARD') { nH+=s.n; qH+=q; }
        else { qM+=q; }
    }

    return oS*nS + oH*nH + (dS*qS + dM*qM + dH*qH)*tempMult
        + (startPos - 1) * epsilon
        + pitStops.length * pitPenalty;
}

// ── 5. Try to determine epsilon by examining identical pairs ──────────────────
// If two drivers have identical strategies with positions p_a and p_b (p_a < p_b),
// and finish consecutively (ranks r and r+1), then their time difference is:
// (p_b - p_a) * epsilon
// Plus any 3rd driver with different strategy between them CANNOT exist (would need time between them).
// From races where an identical pair is CONSECUTIVE in ranking, epsilon must be > all
// strategy differences between any driver that could possibly have a time between them.
// But if they ARE consecutive, no info on strategy differences.
// From races where a different-strategy driver D falls BETWEEN an identical pair (pos_a, pos_b),
// we know: score(A) < score(D) < score(B), i.e., score(D) is within (p_b - p_a)*epsilon of score(A).

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
    console.log('=== Loading races ===');
    const races = loadRaces(5);
    console.log(`Loaded ${races.length} races`);

    console.log('\n=== Base time distribution ===');
    analyzeBaseTimes(races);

    console.log('\n=== Finding identical-strategy pairs ===');
    const pairs = findIdenticalPairs(races);
    console.log(`Found ${pairs.length} identical-strategy groups`);

    let alwaysLowerPosFirst = 0, counterExamples = 0;
    for (const p of pairs) {
        if (p.lowerPosFirst) alwaysLowerPosFirst++;
        else {
            counterExamples++;
            if (counterExamples <= 5) {
                console.log(`COUNTER-EXAMPLE in race ${p.raceId}:`);
                console.log(`  strategy: ${p.strategy}`);
                console.log(`  group: ${JSON.stringify(p.group)}`);
            }
        }
    }
    console.log(`Lower-pos-finishes-first: ${alwaysLowerPosFirst}/${pairs.length}`);
    console.log(`Counter-examples: ${counterExamples}`);

    // Show some examples of identical pairs with someone between them
    console.log('\n=== Examples of identical pairs with interloper ===');
    let shown = 0;
    for (const race of races) {
        if (shown >= 10) break;
        const strats = Object.entries(race.strategies);
        const byKey = {};
        for (const [pos, strat] of strats) {
            const k = strategyKey(strat);
            if (!byKey[k]) byKey[k] = [];
            byKey[k].push({ pos: parseInt(pos.replace('pos', '')), driver: strat.driver_id });
        }
        for (const [key, group] of Object.entries(byKey)) {
            if (group.length < 2) continue;
            const finishRanks = {};
            race.finishing_positions.forEach((d, i) => finishRanks[d] = i + 1);
            const ranked = group.map(g => ({ ...g, rank: finishRanks[g.driver] })).sort((a, b) => a.rank - b.rank);
            // Check if there's someone between the first and last of the group
            const minRank = ranked[0].rank, maxRank = ranked[ranked.length-1].rank;
            if (maxRank - minRank > group.length - 1) {
                // Someone is between them!
                const interlopers = race.finishing_positions.slice(minRank, maxRank-1);
                console.log(`Race ${race.raceId}, strategy: ${key.substring(0,40)}`);
                console.log(`  Identical pair: ${JSON.stringify(ranked)}`);
                console.log(`  Interlopers (ranks ${minRank+1}-${maxRank-1}): ${JSON.stringify(interlopers)}`);
                console.log(`  Config: ${JSON.stringify(race.race_config)}`);
                shown++;
                break;
            }
        }
    }

    // Show track-specific patterns
    console.log('\n=== Track distribution ===');
    const trackCounts = {};
    for (const r of races) {
        const t = r.race_config.track;
        trackCounts[t] = (trackCounts[t] || 0) + 1;
    }
    Object.entries(trackCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([t,c]) =>
        console.log(`  ${t}: ${c} races`));
}

main();
