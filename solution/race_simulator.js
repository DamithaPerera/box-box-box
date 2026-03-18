#!/usr/bin/env node
'use strict';

const PARAMS = {
    tc: 0.06799999999999999,
    fuel: -0.0021999999999999993,
    SOFT:   {offset: 2.9499999999999975, deg: 0.5575000000000002,    cliff: 10},
    MEDIUM: {offset: 3.949999999999993,  deg: 0.2825534299633427,    cliff: 20},
    HARD:   {offset: 4.729999999999999,  deg: 0.14879166666666666,   cliff: 30},
};

function r3(x) { return Math.round(x * 1000) / 1000; }

function simRace(race, p) {
    const cfg = race.race_config;
    const base = cfg.base_lap_time, temp = cfg.track_temp, pit = cfg.pit_lane_time;
    const tc = p.tc, fuel = p.fuel;
    const times = {};
    for (const [, strat] of Object.entries(race.strategies)) {
        const drv = strat.driver_id;
        const pits = (strat.pit_stops || []).slice().sort((a, b) => a.lap - b.lap);
        let total = 0, cl = 1, ct = strat.starting_tire;
        for (const stop of pits) {
            const sl = stop.lap - cl + 1;
            const tp = p[ct], ad = tp.deg * (1 + temp * tc);
            for (let i = 0; i < sl; i++) {
                let lt = base + tp.offset + (cl + i - 1) * fuel;
                if (i + 1 > tp.cliff) lt += ad * (i + 1 - tp.cliff);
                total += r3(lt);
            }
            total += pit;
            cl = stop.lap + 1;
            ct = stop.to_tire;
        }
        const fl = cfg.total_laps - cl + 1;
        const tp = p[ct], ad = tp.deg * (1 + temp * tc);
        for (let i = 0; i < fl; i++) {
            let lt = base + tp.offset + (cl + i - 1) * fuel;
            if (i + 1 > tp.cliff) lt += ad * (i + 1 - tp.cliff);
            total += r3(lt);
        }
        times[drv] = total;
    }
    return times;
}

const chunks = [];
process.stdin.resume();
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
    const input = chunks.join('').trim();
    if (!input) process.exit(0);

    let testCase;
    try {
        testCase = JSON.parse(input);
    } catch (e) {
        process.exit(1);
    }

    const times = simRace(testCase, PARAMS);

    const finishing = Object.keys(times).sort((a, b) => {
        const d = times[a] - times[b];
        if (d === 0) return a < b ? -1 : 1;
        return d;
    });

    const output = {
        race_id: testCase.race_id,
        finishing_positions: finishing
    };

    console.log(JSON.stringify(output));
});
