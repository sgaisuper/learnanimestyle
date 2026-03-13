export type TranscriptEntry = {
  id: string;
  speaker: "airi" | "student";
  kind: "lesson" | "question" | "answer";
  text: string;
};

export type EmotionState =
  | "neutral"
  | "curious"
  | "excited"
  | "thoughtful"
  | "reassuring";

export type SpeakingState =
  | "silent"
  | "listening"
  | "speaking_soft"
  | "speaking_active";

export type VisemeName = "aa" | "ih" | "ou" | "ee" | "oh";

export type VisemeWeights = Record<VisemeName, number>;

export type ClauseCue = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  emphasis: number;
  speakingState: Exclude<SpeakingState, "silent" | "listening">;
};

export type VisemeCue = {
  timeMs: number;
  durationMs: number;
  weights: VisemeWeights;
  jawOpen: number;
  emphasis: number;
};

export type AlignedWord = {
  text: string;
  startMs: number;
  endMs: number;
};

export type SpeechAlignmentMode = "word" | "chunk";

export type SpeechAlignmentHealth = {
  zeroStartCount: number;
  zeroDurationCount: number;
  nonMonotonicCount: number;
  compressedSpanRatio: number;
  isReliable: boolean;
};

export type SpeechAlignment = {
  durationMs: number;
  mode: SpeechAlignmentMode;
  health: SpeechAlignmentHealth;
  words: AlignedWord[];
};

export type BlinkHint = {
  startMs: number;
  endMs: number;
  strength: number;
  suppress: boolean;
};

export type GazeHint = {
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  weight: number;
};

export type HeadNodHint = {
  startMs: number;
  endMs: number;
  amount: number;
};

export type SpeechPerformance = {
  durationMs: number;
  emotionState: EmotionState;
  clauses: ClauseCue[];
  visemes: VisemeCue[];
  blinkHints: BlinkHint[];
  gazeHints: GazeHint[];
  headNodHints: HeadNodHint[];
};

export type LessonBeat = {
  index: number;
  title: string;
  focus: string;
  estimatedSeconds: number;
};

export type StudyPlanResponse = {
  paperTitle: string;
  paperSummary: string;
  beats: LessonBeat[];
};

export type ContinueLessonResponse = {
  spoken: string;
};

export type AnswerQuestionResponse = {
  answer: string;
};

export type SessionPayload = {
  fileId: string;
  studyPlan: StudyPlanResponse;
  nextBeatIndex: number;
  transcript: TranscriptEntry[];
};
