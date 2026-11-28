export type MotusPhase = 'playing' | 'finished';
export type MotusLetterStatus = 'correct' | 'present' | 'absent';

export interface MotusAttempt {
  wordIndex: number;
  guess: string;
  feedback: MotusLetterStatus[];
  found: boolean;
  submittedAt: string;
}

export interface MotusScore {
  seat: number;
  pseudo: string;
  wordsFound: number;
}

export function deriveMotusKeyboardFeedback(
  attempts: readonly MotusAttempt[],
): ReadonlyMap<string, MotusLetterStatus> {
  const feedbackByLetter = new Map<string, MotusLetterStatus>();

  for (const attempt of attempts) {
    const letters = Array.from(
      attempt.guess.normalize('NFD').replace(/\p{M}/gu, '').toLocaleUpperCase('fr-FR'),
    );
    letters.forEach((letter, index) => {
      const status = attempt.feedback[index];
      const previous = feedbackByLetter.get(letter);
      if (
        status === 'correct' ||
        (status === 'present' && previous !== 'correct') ||
        (status === 'absent' && previous === undefined)
      ) {
        feedbackByLetter.set(letter, status);
      }
    });
  }

  return feedbackByLetter;
}

export function formatMotusWordCount(count: number): string {
  return `${count} ${count === 1 ? 'mot trouvé' : 'mots trouvés'}`;
}

export interface MotusState {
  roomCode: string;
  mySeat: number;
  phase: MotusPhase;
  startedAt: string;
  deadline: string;
  serverNow: string;
  wordIndex: number;
  wordsFound: number;
  wordLength: number | null;
  firstLetter: string | null;
  attempts: MotusAttempt[];
  scores: MotusScore[];
  recapWords: string[];
}

export function parseMotusState(value: unknown): MotusState | null {
  if (!isRecord(value)) return null;

  const phase = value['phase'];
  const wordIndex = value['wordIndex'];
  const wordsFound = value['wordsFound'];
  const wordLength = value['wordLength'];
  const firstLetter = value['firstLetter'];
  const attempts = value['attempts'];
  const scores = value['scores'];
  const recapWords = value['recapWords'];

  if (
    typeof value['roomCode'] !== 'string' ||
    !isInteger(value['mySeat'], 0, 3) ||
    (phase !== 'playing' && phase !== 'finished') ||
    !isDateString(value['startedAt']) ||
    !isDateString(value['deadline']) ||
    !isDateString(value['serverNow']) ||
    !isInteger(wordIndex, 1, 16) ||
    !isInteger(wordsFound, 0, 15) ||
    !(wordLength === null || isInteger(wordLength, 5, 7)) ||
    !(firstLetter === null || (typeof firstLetter === 'string' && Array.from(firstLetter).length === 1)) ||
    !Array.isArray(attempts) ||
    !Array.isArray(scores) ||
    !Array.isArray(recapWords)
  ) {
    return null;
  }

  const parsedAttempts = attempts.map(parseMotusAttempt);
  const parsedScores = scores.map(parseMotusScore);
  if (
    parsedAttempts.some((attempt) => attempt === null) ||
    parsedScores.some((score) => score === null) ||
    recapWords.some((word) => typeof word !== 'string')
  ) {
    return null;
  }

  if (
    phase === 'playing' &&
    (recapWords.length > 0 ||
      (wordIndex <= 15 && (wordLength === null || firstLetter === null)) ||
      (wordIndex === 16 && (wordLength !== null || firstLetter !== null)))
  ) {
    return null;
  }
  if (
    phase === 'finished' &&
    (wordLength !== null ||
      firstLetter !== null ||
      recapWords.length < 1 ||
      recapWords.length > 15 ||
      recapWords.some((word) => Array.from(word).length < 5 || Array.from(word).length > 7))
  ) {
    return null;
  }
  if (wordsFound > wordIndex - 1) return null;

  return {
    roomCode: value['roomCode'],
    mySeat: value['mySeat'],
    phase,
    startedAt: value['startedAt'],
    deadline: value['deadline'],
    serverNow: value['serverNow'],
    wordIndex,
    wordsFound,
    wordLength,
    firstLetter,
    attempts: parsedAttempts.filter((attempt): attempt is MotusAttempt => attempt !== null),
    scores: parsedScores.filter((score): score is MotusScore => score !== null),
    recapWords: recapWords as string[],
  };
}

function parseMotusAttempt(value: unknown): MotusAttempt | null {
  if (!isRecord(value)) return null;
  const feedback = value['feedback'];
  if (
    !isInteger(value['wordIndex'], 1, 15) ||
    typeof value['guess'] !== 'string' ||
    !Array.isArray(feedback) ||
    feedback.length !== Array.from(value['guess']).length ||
    feedback.some((status) => status !== 'correct' && status !== 'present' && status !== 'absent') ||
    typeof value['found'] !== 'boolean' ||
    typeof value['submittedAt'] !== 'string'
  ) {
    return null;
  }
  return {
    wordIndex: value['wordIndex'],
    guess: value['guess'],
    feedback: feedback as MotusLetterStatus[],
    found: value['found'],
    submittedAt: value['submittedAt'],
  };
}

function parseMotusScore(value: unknown): MotusScore | null {
  if (!isRecord(value)) return null;
  if (
    !isInteger(value['seat'], 0, 3) ||
    typeof value['pseudo'] !== 'string' ||
    !isInteger(value['wordsFound'], 0, 15)
  ) {
    return null;
  }
  return {
    seat: value['seat'],
    pseudo: value['pseudo'],
    wordsFound: value['wordsFound'],
  };
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
