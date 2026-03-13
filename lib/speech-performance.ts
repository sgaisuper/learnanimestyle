import type {
  AlignedWord,
  BlinkHint,
  ClauseCue,
  EmotionState,
  GazeHint,
  GestureHint,
  GestureName,
  HeadNodHint,
  SpeechAlignment,
  SpeechPerformance,
  VisemeCue,
  VisemeWeights,
} from "@/lib/types";

const BASE_WORD_MS = 295;
const CLAUSE_PADDING_MS = 120;
const MIN_DURATION_MS = 1400;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createWeights(overrides: Partial<VisemeWeights>): VisemeWeights {
  return {
    aa: overrides.aa ?? 0,
    ih: overrides.ih ?? 0,
    ou: overrides.ou ?? 0,
    ee: overrides.ee ?? 0,
    oh: overrides.oh ?? 0,
  };
}

function getEmotionState(text: string): EmotionState {
  const normalized = text.toLowerCase();

  if (/[!?]/.test(normalized) || /\b(amazing|exciting|important|big|huge|key|crucial)\b/.test(normalized)) {
    return "excited";
  }

  if (/\b(think|intuition|consider|suppose|notice|look at|why)\b/.test(normalized)) {
    return "thoughtful";
  }

  if (/\b(don't worry|okay|gently|simple|just|we can|let's)\b/.test(normalized)) {
    return "reassuring";
  }

  if (/\?/.test(normalized) || /\b(what|why|how|imagine)\b/.test(normalized)) {
    return "curious";
  }

  return "neutral";
}

function splitClauses(text: string) {
  return text
    .split(/(?<=[.!?;:])\s+|(?<=,)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function estimateDuration(text: string, clauseCount: number) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const punctuationPauses = (text.match(/[,:;]/g) ?? []).length * 110 + (text.match(/[.!?]/g) ?? []).length * 180;
  const longFormPadding = words > 45 ? words * 18 : 0;
  return Math.max(
    MIN_DURATION_MS,
    words * BASE_WORD_MS + clauseCount * CLAUSE_PADDING_MS + punctuationPauses + longFormPadding,
  );
}

function getClauseEmphasis(text: string) {
  const punctuationBoost = /[!?]/.test(text) ? 0.18 : /[:,;]/.test(text) ? 0.1 : 0.04;
  const capitalBoost = /[A-Z]{2,}/.test(text) ? 0.1 : 0;
  const lengthBoost = Math.min(text.length / 240, 0.08);
  return clamp(0.3 + punctuationBoost + capitalBoost + lengthBoost, 0.24, 0.82);
}

function getSpeakingState(emphasis: number): ClauseCue["speakingState"] {
  return emphasis > 0.68 ? "speaking_active" : "speaking_soft";
}

function getVisemeForToken(token: string, emphasis: number): VisemeWeights {
  const normalized = token.toLowerCase();

  if (/[ou]/.test(normalized)) {
    return createWeights({ ou: 0.62 + emphasis * 0.18, oh: 0.3 });
  }

  if (/[iey]/.test(normalized)) {
    return createWeights({ ee: 0.56 + emphasis * 0.14, ih: 0.36 });
  }

  if (/[oa]/.test(normalized)) {
    return createWeights({ aa: 0.5 + emphasis * 0.16, oh: 0.3 + emphasis * 0.08 });
  }

  if (/[uh]/.test(normalized)) {
    return createWeights({ oh: 0.52, ou: 0.28 });
  }

  return createWeights({ aa: 0.34 + emphasis * 0.1, ih: 0.18, oh: 0.22 });
}

function createClauseCues(clauses: string[], totalDurationMs: number): ClauseCue[] {
  const weights = clauses.map((clause) => Math.max(clause.trim().split(/\s+/).length, 1));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);

  let cursorMs = 0;
  return clauses.map((clause, index) => {
    const sliceMs = Math.round((weights[index] / totalWeight) * totalDurationMs);
    const startMs = cursorMs;
    const endMs = Math.min(totalDurationMs, startMs + sliceMs);
    const emphasis = getClauseEmphasis(clause);
    cursorMs = endMs;

    return {
      id: `clause-${index + 1}`,
      text: clause,
      startMs,
      endMs,
      emphasis,
      speakingState: getSpeakingState(emphasis),
    };
  });
}

function createVisemeCues(clauses: ClauseCue[]): VisemeCue[] {
  const cues: VisemeCue[] = [];

  for (const clause of clauses) {
    const tokens = clause.text.split(/\s+/).map((token) => token.trim()).filter(Boolean);
    const tokenCount = Math.max(tokens.length, 1);
    const tokenDurationMs = Math.max(75, (clause.endMs - clause.startMs) / tokenCount);

    tokens.forEach((token, index) => {
      const tokenStart = Math.round(clause.startMs + index * tokenDurationMs);
      const emphasis = clause.emphasis * (/[!?]/.test(token) ? 1.08 : 1);
      cues.push({
        timeMs: tokenStart,
        durationMs: Math.round(tokenDurationMs * 0.88),
        weights: getVisemeForToken(token, emphasis),
        jawOpen: clamp(0.26 + emphasis * 0.36 + (/[aeiou]/i.test(token) ? 0.1 : 0), 0.22, 0.78),
        emphasis: clamp(emphasis, 0.2, 1),
      });
    });
  }

  return cues;
}

function normalizeWordToken(word: string) {
  return word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "").toLowerCase();
}

function countSyllables(word: string) {
  const normalized = normalizeWordToken(word);
  if (!normalized) {
    return 1;
  }

  const matches = normalized.match(/[aeiouy]+/g);
  return Math.max(1, matches?.length ?? 1);
}

function getWordEmphasis(word: string) {
  const syllables = countSyllables(word);
  const vowelBoost = clamp((word.match(/[aeiou]/gi) ?? []).length * 0.05, 0, 0.18);
  const punctuationBoost = /[!?]/.test(word) ? 0.12 : /[,;:]/.test(word) ? 0.06 : 0;
  return clamp(0.28 + syllables * 0.06 + vowelBoost + punctuationBoost, 0.26, 0.82);
}

function createAlignedVisemeCues(words: AlignedWord[]): VisemeCue[] {
  const cues: VisemeCue[] = [];

  for (const word of words) {
    const normalized = normalizeWordToken(word.text);
    if (!normalized) {
      continue;
    }

    const durationMs = Math.max(1, word.endMs - word.startMs);
    const slices = clamp(countSyllables(normalized), 1, 4);
    const sliceDurationMs = durationMs / slices;
    const emphasis = getWordEmphasis(word.text);

    for (let index = 0; index < slices; index += 1) {
      const segmentStart = Math.round(word.startMs + sliceDurationMs * index);
      const segmentEnd = Math.round(word.startMs + sliceDurationMs * (index + 1));
      const segmentText = normalized.slice(
        Math.floor((normalized.length * index) / slices),
        Math.max(
          Math.floor((normalized.length * (index + 1)) / slices),
          Math.floor((normalized.length * index) / slices) + 1,
        ),
      );
      const segmentEmphasis = clamp(
        emphasis + (index === 0 ? 0.04 : 0) + (index === slices - 1 ? 0.02 : 0),
        0.24,
        0.9,
      );

      cues.push({
        timeMs: segmentStart,
        durationMs: Math.max(55, segmentEnd - segmentStart),
        weights: getVisemeForToken(segmentText || normalized, segmentEmphasis),
        jawOpen: clamp(
          0.24 + segmentEmphasis * 0.34 + (/[aeiou]/i.test(segmentText || normalized) ? 0.08 : 0),
          0.2,
          0.82,
        ),
        emphasis: segmentEmphasis,
      });
    }
  }

  return cues;
}

function createBlinkHints(clauses: ClauseCue[], emotionState: EmotionState): BlinkHint[] {
  return clauses.slice(0, -1).map((clause, index) => {
    const windowStart = Math.max(clause.endMs - 70, clause.startMs);
    const nextClause = clauses[index + 1];
    const quietGap = Math.max(90, Math.min((nextClause.startMs - clause.endMs) || 130, 170));

    return {
      startMs: windowStart,
      endMs: windowStart + quietGap,
      strength: emotionState === "reassuring" ? 0.68 : emotionState === "thoughtful" ? 0.58 : 0.5,
      suppress: clause.emphasis > 0.72,
    };
  });
}

function createGazeHints(clauses: ClauseCue[], emotionState: EmotionState): GazeHint[] {
  return clauses.map((clause) => {
    const thoughtfulBias = emotionState === "thoughtful" ? 0.05 : 0;
    const curiousBias = emotionState === "curious" ? 0.03 : 0;
    const reassuringBias = emotionState === "reassuring" ? -0.01 : 0;

    return {
      startMs: clause.startMs,
      endMs: clause.endMs,
      x: 0,
      y: clamp(-0.01 + thoughtfulBias + curiousBias + reassuringBias, -0.05, 0.08),
      weight: clamp(0.08 + clause.emphasis * 0.08, 0.06, 0.16),
    };
  });
}

function createHeadNodHints(clauses: ClauseCue[], emotionState: EmotionState): HeadNodHint[] {
  return clauses.map((clause) => ({
    startMs: clause.startMs,
    endMs: clause.endMs,
    amount: clamp(
      (emotionState === "excited" ? 0.14 : emotionState === "thoughtful" ? 0.05 : 0.08) +
        clause.emphasis * 0.1,
      0.05,
      0.2,
    ),
  }));
}

function createGestureHints(clauses: ClauseCue[], emotionState: EmotionState): GestureHint[] {
  const gestures: GestureName[] = clauses.map((clause, index) => {
    if (emotionState === "thoughtful") {
      return "think";
    }
    if (emotionState === "excited" && clause.emphasis > 0.58) {
      return "emphasize";
    }
    if (clause.emphasis > 0.52) {
      return index % 2 === 0 ? "open" : "present";
    }
    return "neutral";
  });

  return clauses.map((clause, index) => ({
    startMs: clause.startMs,
    endMs: clause.endMs,
    gesture: gestures[index],
    strength: clamp(0.38 + clause.emphasis * 0.62, 0.35, 1.0),
  }));
}

export function createSpeechPerformance(text: string): SpeechPerformance {
  const normalized = text.trim();
  const clauses = splitClauses(normalized);
  const durationMs = estimateDuration(normalized, clauses.length);
  const emotionState = getEmotionState(normalized);
  const clauseCues = createClauseCues(clauses, durationMs);

  return {
    durationMs,
    emotionState,
    clauses: clauseCues,
    visemes: createVisemeCues(clauseCues),
    blinkHints: createBlinkHints(clauseCues, emotionState),
    gazeHints: createGazeHints(clauseCues, emotionState),
    headNodHints: createHeadNodHints(clauseCues, emotionState),
    gestureHints: createGestureHints(clauseCues, emotionState),
  };
}

export function createAlignedSpeechPerformance(
  text: string,
  alignment: SpeechAlignment,
): SpeechPerformance {
  const normalized = text.trim();
  const clauses = splitClauses(normalized);
  const fallbackDurationMs = estimateDuration(normalized, clauses.length);
  const durationMs = Math.max(alignment.durationMs, fallbackDurationMs);
  const emotionState = getEmotionState(normalized);
  const clauseCues = createClauseCues(clauses, durationMs);

  return {
    durationMs,
    emotionState,
    clauses: clauseCues,
    visemes: createAlignedVisemeCues(alignment.words),
    blinkHints: createBlinkHints(clauseCues, emotionState),
    gazeHints: createGazeHints(clauseCues, emotionState),
    headNodHints: createHeadNodHints(clauseCues, emotionState),
    gestureHints: createGestureHints(clauseCues, emotionState),
  };
}
