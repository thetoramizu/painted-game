import {
  deriveMotusKeyboardFeedback,
  formatMotusWordCount,
  parseMotusState,
  type MotusAttempt,
} from './motus';

describe('MOTUS state parsing', () => {
  it('accepts a private playing state without exposing later words', () => {
    const state = parseMotusState({
      roomCode: 'ABC123',
      mySeat: 1,
      phase: 'playing',
      startedAt: '2026-11-28T10:00:00Z',
      deadline: '2026-11-28T10:02:00Z',
      serverNow: '2026-11-28T10:00:05Z',
      wordIndex: 2,
      wordsFound: 1,
      wordLength: 6,
      firstLetter: 'é',
      attempts: [{
        wordIndex: 2,
        guess: 'ÉCOLES',
        feedback: ['correct', 'present', 'absent', 'absent', 'correct', 'absent'],
        found: false,
        submittedAt: '2026-11-28T10:00:04Z',
      }],
      scores: [{ seat: 1, pseudo: 'Camille', wordsFound: 1 }],
      recapWords: [],
    });

    expect(state?.wordIndex).toBe(2);
    expect(state?.firstLetter).toBe('é');
    expect(state?.recapWords).toEqual([]);
    expect(state?.attempts[0].feedback).toContain('present');
  });

  it('rejects a playing state that reveals the full sequence', () => {
    const state = parseMotusState({
      roomCode: 'ABC123',
      mySeat: 0,
      phase: 'playing',
      startedAt: '2026-11-28T10:00:00Z',
      deadline: '2026-11-28T10:02:00Z',
      serverNow: '2026-11-28T10:00:05Z',
      wordIndex: 1,
      wordsFound: 0,
      wordLength: 5,
      firstLetter: 'é',
      attempts: [],
      scores: [],
      recapWords: ['école', 'maison'],
    });

    expect(state).toBeNull();
  });

  it('accepts progress that includes skipped words', () => {
    const state = parseMotusState({
      roomCode: 'ABC123',
      mySeat: 0,
      phase: 'playing',
      startedAt: '2026-11-28T10:00:00Z',
      deadline: '2026-11-28T10:02:00Z',
      serverNow: '2026-11-28T10:00:05Z',
      wordIndex: 3,
      wordsFound: 1,
      wordLength: 5,
      firstLetter: 'é',
      attempts: [],
      scores: [{ seat: 0, pseudo: 'Camille', wordsFound: 1 }],
      recapWords: [],
    });

    expect(state?.wordIndex).toBe(3);
    expect(state?.wordsFound).toBe(1);
  });

  it('requires a finished recap and score data to have valid shapes', () => {
    const state = parseMotusState({
      roomCode: 'ABC123',
      mySeat: 0,
      phase: 'finished',
      startedAt: '2026-11-28T10:00:00Z',
      deadline: '2026-11-28T10:02:00Z',
      serverNow: '2026-11-28T10:02:01Z',
      wordIndex: 1,
      wordsFound: 0,
      wordLength: null,
      firstLetter: null,
      attempts: [],
      scores: [{ seat: 0, pseudo: 'Camille', wordsFound: 16 }],
      recapWords: ['école'],
    });

    expect(state).toBeNull();
  });
});

describe('MOTUS display helpers', () => {
  it('keeps the strongest keyboard feedback for each letter', () => {
    const attempts: MotusAttempt[] = [
      {
        wordIndex: 1,
        guess: 'ABACA',
        feedback: ['present', 'absent', 'correct', 'absent', 'absent'],
        found: false,
        submittedAt: '2026-11-28T10:00:00Z',
      },
      {
        wordIndex: 1,
        guess: 'BZZZZ',
        feedback: ['correct', 'absent', 'absent', 'absent', 'absent'],
        found: false,
        submittedAt: '2026-11-28T10:00:01Z',
      },
      {
        wordIndex: 1,
        guess: 'CABBA',
        feedback: ['present', 'absent', 'absent', 'absent', 'absent'],
        found: false,
        submittedAt: '2026-11-28T10:00:02Z',
      },
    ];

    const keyboard = deriveMotusKeyboardFeedback(attempts);

    expect(keyboard.get('A')).toBe('correct');
    expect(keyboard.get('B')).toBe('correct');
    expect(keyboard.get('C')).toBe('present');
    expect(keyboard.get('Z')).toBe('absent');
  });

  it('uses singular only for exactly one found word', () => {
    expect(formatMotusWordCount(0)).toBe('0 mots trouvés');
    expect(formatMotusWordCount(1)).toBe('1 mot trouvé');
    expect(formatMotusWordCount(2)).toBe('2 mots trouvés');
  });
});
