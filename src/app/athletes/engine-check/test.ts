import { RaceState, createRace, playTurn } from "./race-engine";

// const pos = (s: RaceState, seat: number) => s.racers.find((r) => r.seat === seat)!.position;

// let s = createRace([
//   { seat: 0, pseudo: 'A', athlete: 'genie' },
//   { seat: 1, pseudo: 'B', athlete: 'slime' },
// ]);
// s = playTurn(s, { seat: 0, roll: 6, useJog: false });
// assert.equal(pos(s, 0), 5);
// assert.equal(s.turnSeat, 1);

// s = playTurn(s, { seat: 1, roll: 4, useJog: false });
// assert.equal(pos(s, 1), 4);
// assert.equal(s.turnSeat, 0);

// s = playTurn(s, { seat: 0, roll: 2, useJog: true });
// assert.equal(pos(s, 0), 9);

// assert.throws(() => playTurn(s, { seat: 1, roll: 2, useJog: true }), /Seul le Génie/);
// assert.throws(() => playTurn(s, { seat: 0, roll: 2, useJog: false }), /pas votre tour/);

// let t = createRace([
//   { seat: 0, pseudo: 'A', athlete: 'genie' },
//   { seat: 1, pseudo: 'T', athlete: 'tremplin-devin' },
//   { seat: 2, pseudo: 'C', athlete: 'genie' },
// ]);
// t = { ...t, racers: t.racers.map((r) => (r.seat === 1 ? { ...r, position: 4 } : r)), turnSeat: 0 };
// t = playTurn(t, { seat: 0, roll: 4, useJog: false });
// assert.equal(pos(t, 0), 4);
// assert.equal(pos(t, 1), 6);

// let c = createRace([
//   { seat: 0, pseudo: 'A', athlete: 'genie' },
//   { seat: 1, pseudo: 'R', athlete: 'cinquieme-roue' },
// ]);
// c = { ...c, racers: c.racers.map((r) => (r.seat === 1 ? { ...r, position: 3 } : r)) };
// c = playTurn(c, { seat: 0, roll: 3, useJog: false });
// assert.equal(pos(c, 0), 4);

// let d = createRace([
//   { seat: 0, pseudo: 'D', athlete: 'docteur-fusee' },
//   { seat: 1, pseudo: 'X', athlete: 'genie' },
// ]);
// d = { ...d, racers: d.racers.map((r) => (r.seat === 1 ? { ...r, position: 5 } : r)) };
// d = playTurn(d, { seat: 0, roll: 2, useJog: false });
// assert.equal(d.racers.find((r) => r.seat === 0)!.bronze, 1);

// let f = createRace([
//   { seat: 0, pseudo: 'A', athlete: 'genie' },
//   { seat: 1, pseudo: 'B', athlete: 'genie' },
//   { seat: 2, pseudo: 'C', athlete: 'genie' },
// ]);
// f = { ...f, racers: f.racers.map((r) => ({ ...r, position: r.seat === 0 ? 28 : 27 })) };
// f = playTurn(f, { seat: 0, roll: 6, useJog: false });
// assert.equal(f.racers[0].finishRank, 1);
// assert.equal(f.phase, 'playing');
// f = playTurn(f, { seat: 1, roll: 6, useJog: false });
// assert.equal(f.racers[1].finishRank, 2);
// assert.equal(f.phase, 'finished');

// let solo = createRace([{ seat: 0, pseudo: 'Seul', athlete: 'genie' }]);
// for (let i = 0; i < 10 && solo.phase === 'playing'; i++) {
//   solo = playTurn(solo, { seat: 0, roll: 6, useJog: false });
// }
// assert.equal(solo.phase, 'finished');
// assert.equal(solo.racers[0].finishRank, 1);

// console.log('All engine checks passed');
