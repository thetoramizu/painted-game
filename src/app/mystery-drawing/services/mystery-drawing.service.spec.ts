import { parseMysteryEvent, parseMysteryState } from './mystery-drawing.service';

describe('Dessin Mystère data contracts', () => {
  it('parses the private state shape returned for a drawing player', () => {
    const state = parseMysteryState({
      roomCode: 'ABC123',
      mySeat: 0,
      players: [{ seat: 0, pseudo: 'Camille' }, { seat: 1, pseudo: 'Noa' }],
      round: 1,
      totalRounds: 2,
      phase: 'drawing',
      drawerSeat: 0,
      deadline: '2026-11-27T18:00:00Z',
      revision: 3,
      guessedSeats: [],
      drawnSeats: [],
      wordLength: 7,
      secretWord: 'girafe',
      wordOptions: [],
      events: [],
    });

    expect(state?.secretWord).toBe('girafe');
    expect(state?.wordOptions).toEqual([]);
    expect(state?.players.map((player) => player.seat)).toEqual([0, 1]);
  });

  it('rejects invalid phases instead of accepting an unknown server state', () => {
    const state = parseMysteryState({
      roomCode: 'ABC123',
      mySeat: 1,
      players: [],
      round: 1,
      totalRounds: 2,
      phase: 'revealing',
      drawerSeat: 0,
      deadline: '2026-11-27T18:00:00Z',
      revision: 3,
      guessedSeats: [],
      drawnSeats: [],
      wordLength: null,
      secretWord: null,
      wordOptions: [],
      events: [],
    });

    expect(state).toBeNull();
  });

  it('accepts Postgres Realtime rows with snake-case column names', () => {
    const event = parseMysteryEvent({
      id: 12,
      round_index: 2,
      kind: 'drawing',
      actor_seat: 1,
      payload: { operation: 'clear', data: {} },
    });

    expect(event).toEqual({
      id: 12,
      roundIndex: 2,
      kind: 'drawing',
      actorSeat: 1,
      payload: { operation: 'clear', data: {} },
    });
  });

  it('parses drawing events with camel-case fields', () => {
    const event = parseMysteryEvent({
      id: 13,
      roundIndex: 2,
      kind: 'drawing',
      actorSeat: 0,
      payload: {
        operation: 'points',
        data: { points: [{ x: 0.2, y: 0.4 }], clientEventId: 'event-1' },
      },
    });

    expect(event?.actorSeat).toBe(0);
    expect(event?.payload['data']).toEqual({
      points: [{ x: 0.2, y: 0.4 }],
      clientEventId: 'event-1',
    });
  });
});
