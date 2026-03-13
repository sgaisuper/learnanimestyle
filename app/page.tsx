"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
  LessonBeat,
  SpeechAlignment,
  SessionPayload,
  SpeechPerformance,
  TranscriptEntry,
} from "@/lib/types";
import { VrmAvatar } from "@/components/vrm-avatar";
import { createAlignedSpeechPerformance } from "@/lib/speech-performance";

function getErrorMessage(data: SessionPayload | { error: string }, fallback: string) {
  return "error" in data ? data.error : fallback;
}

const defaultQuestion =
  "Why does this paper matter, and what should I pay attention to next?";

const MIN_WORD_SPAN_MS = 60;
const MIN_CHUNK_SPAN_MS = 70;
const PLAYBACK_JITTER_TOLERANCE_MS = 18;
const PLAYBACK_FORWARD_JUMP_CAP_MS = 220;
const FALLBACK_REVEAL_LAG_MS = 220;
const paywallEnabled = process.env.NEXT_PUBLIC_ENABLE_PAYWALL === "true";
const paywallTitle = process.env.NEXT_PUBLIC_PAYWALL_TITLE?.trim() || "Members Only";
const paywallMessage =
  process.env.NEXT_PUBLIC_PAYWALL_MESSAGE?.trim() ||
  "This deployment is reserved for paying users. Subscribe to unlock guided lessons, live transcript playback, and follow-up tutoring.";
const paywallCtaLabel = process.env.NEXT_PUBLIC_PAYWALL_CTA_LABEL?.trim() || "Join now";
const paywallCtaUrl = process.env.NEXT_PUBLIC_PAYWALL_CTA_URL?.trim() || "";

function scaleTime(value: number, ratio: number) {
  return Math.max(0, Math.round(value * ratio));
}

type ClauseRange = {
  start: number;
  end: number;
  startMs: number;
  endMs: number;
};

type WordTokenRange = {
  token: string;
  start: number;
  end: number;
  startMs: number;
  endMs: number;
};

type ActiveSpeechState = {
  entryId: string;
  fullText: string;
  durationMs: number;
  alignment: SpeechAlignment | null;
  performance: SpeechPerformance | null;
  alignmentStatus: AlignmentStatus;
  timelineSource: TimelineSource;
  transcriptStrategy: TranscriptStreamStrategy;
};

type AlignmentStatus = "pending" | "ready" | "degraded" | "unavailable";

type TimelineSource = "aligned" | "fallback";

type PlaybackSnapshot = {
  confirmedMs: number;
  predictedMs: number;
};

type TranscriptStreamStrategy = "pending" | "fallback" | "word" | "chunk";

type StreamingSnapshot = {
  strategy: TranscriptStreamStrategy;
  source: TimelineSource;
  visibleText: string;
  visibleLength: number;
  totalLength: number;
  alignmentLength: number | null;
  fallbackLength: number;
  confirmedMs: number;
  predictedMs: number;
  leadMs: number;
};

function normalizeSpeechPerformance(
  performance: SpeechPerformance,
  actualDurationMs: number,
): SpeechPerformance {
  const plannedDurationMs = Math.max(performance.durationMs, 1);
  const safeActualDurationMs = Math.max(actualDurationMs, 1);
  const ratio = safeActualDurationMs / plannedDurationMs;

  return {
    ...performance,
    durationMs: safeActualDurationMs,
    clauses: performance.clauses.map((clause) => ({
      ...clause,
      startMs: scaleTime(clause.startMs, ratio),
      endMs: scaleTime(clause.endMs, ratio),
    })),
    visemes: performance.visemes.map((cue) => ({
      ...cue,
      timeMs: scaleTime(cue.timeMs, ratio),
      durationMs: Math.max(45, scaleTime(cue.durationMs, ratio)),
    })),
    blinkHints: performance.blinkHints.map((hint) => ({
      ...hint,
      startMs: scaleTime(hint.startMs, ratio),
      endMs: scaleTime(hint.endMs, ratio),
    })),
    gazeHints: performance.gazeHints.map((hint) => ({
      ...hint,
      startMs: scaleTime(hint.startMs, ratio),
      endMs: scaleTime(hint.endMs, ratio),
    })),
    headNodHints: performance.headNodHints.map((hint) => ({
      ...hint,
      startMs: scaleTime(hint.startMs, ratio),
      endMs: scaleTime(hint.endMs, ratio),
    })),
    gestureHints: performance.gestureHints.map((hint) => ({
      ...hint,
      startMs: scaleTime(hint.startMs, ratio),
      endMs: scaleTime(hint.endMs, ratio),
    })),
  };
}

function reachesThreshold(count: number, total: number, fraction: number) {
  if (count <= 0 || total <= 0) {
    return false;
  }

  return count >= Math.max(1, Math.floor(total * fraction));
}

function createAlignmentHealth(words: SpeechAlignment["words"], durationMs: number) {
  let previousStartMs = -1;
  let zeroStartCount = 0;
  let zeroDurationCount = 0;
  let nonMonotonicCount = 0;

  words.forEach((word) => {
    if (word.startMs === 0) {
      zeroStartCount += 1;
    }
    if (word.endMs - word.startMs <= 0) {
      zeroDurationCount += 1;
    }
    if (word.startMs <= previousStartMs) {
      nonMonotonicCount += 1;
    }
    previousStartMs = Math.max(previousStartMs, word.startMs);
  });

  const observedSpanMs = words.length > 0 ? Math.max(0, words[words.length - 1].endMs - words[0].startMs) : 0;
  const compressedSpanRatio =
    durationMs > 0 ? clamp(observedSpanMs / durationMs, 0, 1) : observedSpanMs > 0 ? 1 : 0;
  const narrowSpanCount = words.filter((word) => word.endMs - word.startMs < MIN_WORD_SPAN_MS).length;
  const isReliable =
    words.length <= 1 ||
    !(
      compressedSpanRatio < 0.35 ||
      reachesThreshold(zeroDurationCount, words.length, 0.25) ||
      reachesThreshold(zeroStartCount, words.length, 1 / 3) ||
      reachesThreshold(nonMonotonicCount, words.length, 1 / 3) ||
      reachesThreshold(narrowSpanCount, words.length, 0.5)
    );

  return {
    zeroStartCount,
    zeroDurationCount,
    nonMonotonicCount,
    compressedSpanRatio,
    isReliable,
  };
}

function createWeightedSlices(words: SpeechAlignment["words"], startMs: number, endMs: number, minSpanMs: number) {
  const safeStartMs = Math.max(0, startMs);
  const safeEndMs = Math.max(safeStartMs + 1, endMs);
  const latestStartMs = Math.max(safeStartMs, safeEndMs - 1);
  const weightedWords = words.map((word) => ({
    word,
    weight: Math.max(normalizeToken(word.text).length, 1),
  }));
  const totalWeight = weightedWords.reduce((sum, entry) => sum + entry.weight, 0);
  let cursorMs = safeStartMs;

  return weightedWords.map(({ word, weight }, index) => {
    const remainingWords = weightedWords.length - index;
    const remainingMs = Math.max(safeEndMs - cursorMs, 1);
    const sliceMs =
      index === weightedWords.length - 1
        ? remainingMs
        : Math.max(
            minSpanMs,
            Math.min(
              remainingMs,
              Math.round((weight / Math.max(totalWeight, 1)) * (safeEndMs - safeStartMs)),
            ),
          );
    const nextEndMs = Math.min(safeEndMs, cursorMs + sliceMs);
    const start = Math.min(cursorMs, latestStartMs);
    const end =
      index === weightedWords.length - 1
        ? safeEndMs
        : clamp(Math.max(start + 1, nextEndMs), start + 1, safeEndMs);

    cursorMs =
      remainingWords > 1 ? Math.min(safeEndMs, Math.max(end, start + minSpanMs)) : safeEndMs;

    return {
      ...word,
      startMs: start,
      endMs: Math.max(end, start + 1),
    };
  });
}

function repairWordAlignment(words: SpeechAlignment["words"], durationMs: number) {
  if (!words.length) {
    return words;
  }

  const repairedWords = words.map((word) => ({
    ...word,
    startMs: clamp(word.startMs, 0, durationMs),
    endMs: clamp(Math.max(word.endMs, word.startMs), 0, durationMs),
  }));
  const reliable: boolean[] = repairedWords.map(
    (word, index) =>
      word.endMs - word.startMs >= MIN_WORD_SPAN_MS &&
      (index === 0 || word.startMs > repairedWords[index - 1].startMs),
  );

  let index = 0;
  while (index < repairedWords.length) {
    if (reliable[index]) {
      index += 1;
      continue;
    }

    const startIndex = index;
    while (index < repairedWords.length && !reliable[index]) {
      index += 1;
    }

    const endIndex = index - 1;
    const previousReliableIndex = startIndex > 0 ? startIndex - 1 : -1;
    const nextReliableIndex = index < repairedWords.length ? index : -1;
    const previousEndMs = previousReliableIndex >= 0 ? repairedWords[previousReliableIndex].endMs : 0;
    const nextStartMs = nextReliableIndex >= 0 ? repairedWords[nextReliableIndex].startMs : durationMs;
    const runWords = repairedWords.slice(startIndex, endIndex + 1);
    const availableEndMs = Math.max(previousEndMs + runWords.length, nextStartMs);
    const repairedRun = createWeightedSlices(runWords, previousEndMs, availableEndMs, MIN_WORD_SPAN_MS);

    repairedRun.forEach((word, offset) => {
      repairedWords[startIndex + offset] = word;
      reliable[startIndex + offset] = true;
    });
  }

  return repairedWords.map((word, wordIndex) => {
    const previousWord = repairedWords[wordIndex - 1];
    const nextWord = repairedWords[wordIndex + 1];
    const startMs =
      previousWord == null ? word.startMs : Math.max(word.startMs, previousWord.endMs);
    const maxEndMs = nextWord == null ? durationMs : Math.max(startMs + 1, nextWord.startMs);
    return {
      ...word,
      startMs: clamp(startMs, 0, durationMs),
      endMs: clamp(Math.max(startMs + 1, word.endMs), startMs + 1, Math.max(startMs + 1, maxEndMs)),
    };
  });
}

function normalizeSpeechAlignment(
  alignment: SpeechAlignment,
  actualDurationMs: number,
): SpeechAlignment {
  const plannedDurationMs = Math.max(alignment.durationMs, 1);
  const safeActualDurationMs = Math.max(actualDurationMs, 1);
  const ratio = safeActualDurationMs / plannedDurationMs;
  const scaledWords = alignment.words.map((word) => ({
    ...word,
    startMs: scaleTime(word.startMs, ratio),
    endMs: scaleTime(word.endMs, ratio),
  }));

  if (!scaledWords.length) {
    return {
      durationMs: safeActualDurationMs,
      mode: "chunk",
      health: {
        zeroStartCount: 0,
        zeroDurationCount: 0,
        nonMonotonicCount: 0,
        compressedSpanRatio: 0,
        isReliable: false,
      },
      words: [],
    };
  }

  const repairedWords = repairWordAlignment(scaledWords, safeActualDurationMs);
  const repairedHealth = createAlignmentHealth(repairedWords, safeActualDurationMs);
  const mode = repairedHealth.isReliable ? "word" : "chunk";
  const normalizedWords =
    mode === "word"
      ? repairedWords
      : createWeightedSlices(repairedWords, 0, safeActualDurationMs, MIN_CHUNK_SPAN_MS);

  return {
    durationMs: safeActualDurationMs,
    mode,
    health: createAlignmentHealth(normalizedWords, safeActualDurationMs),
    words: normalizedWords,
  };
}

function normalizeToken(value: string) {
  return value.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "").toLowerCase();
}

function buildWordTokenRanges(text: string, alignment: SpeechAlignment): WordTokenRange[] {
  const ranges: WordTokenRange[] = [];
  let searchStart = 0;

  alignment.words.forEach((word, index) => {
    const token = word.text.trim();
    const normalizedToken = normalizeToken(token);

    if (!normalizedToken) {
      return;
    }

    const exactStart = text.indexOf(token, searchStart);
    let start = exactStart;
    let end = exactStart === -1 ? -1 : exactStart + token.length;

    if (start === -1) {
      const lowerText = text.toLowerCase();
      for (let position = searchStart; position < text.length; position += 1) {
        const candidateEnd = Math.min(text.length, position + token.length + 8);
        const candidate = lowerText.slice(position, candidateEnd);
        if (candidate.includes(normalizedToken)) {
          const localIndex = normalizeToken(candidate).indexOf(normalizedToken);
          if (localIndex >= 0) {
            start = position;
            end = Math.min(text.length, position + token.length);
            break;
          }
        }
      }
    }

    if (start === -1 || end === -1) {
      const fallbackStart =
        index === 0
          ? 0
          : ranges[index - 1]?.end ?? Math.round((text.length * index) / alignment.words.length);
      const fallbackEnd =
        index === alignment.words.length - 1
          ? text.length
          : Math.round((text.length * (index + 1)) / alignment.words.length);

      ranges.push({
        token,
        start: fallbackStart,
        end: Math.max(fallbackStart, fallbackEnd),
        startMs: word.startMs,
        endMs: word.endMs,
      });
      searchStart = fallbackEnd;
      return;
    }

    while (start > 0 && /\s/.test(text[start - 1])) {
      start -= 1;
    }

    ranges.push({
      token,
      start,
      end,
      startMs: word.startMs,
      endMs: word.endMs,
    });
    searchStart = end;
  });

  return ranges;
}

function getStreamedTextFromAlignment(
  text: string,
  elapsedMs: number,
  alignment: SpeechAlignment | null,
) {
  if (!text || !alignment?.words.length) {
    return null;
  }

  const tokenRanges = buildWordTokenRanges(text, alignment);
  if (!tokenRanges.length) {
    return null;
  }

  if (elapsedMs >= alignment.durationMs) {
    return text;
  }

  let visibleLength = 0;

  for (const range of tokenRanges) {
    const revealThresholdMs = alignment.mode === "chunk" ? range.endMs : range.startMs;
    if (elapsedMs >= revealThresholdMs) {
      visibleLength = Math.max(visibleLength, range.end);
      continue;
    }
    break;
  }

  return text.slice(0, Math.max(0, visibleLength)).trimEnd();
}

function getFallbackStreamedText(text: string, elapsedMs: number, durationMs: number) {
  if (!text) {
    return "";
  }

  if (durationMs <= 0) {
    return "";
  }

  if (elapsedMs >= durationMs) {
    return text;
  }

  const progress = clamp(elapsedMs / durationMs, 0, 1);
  const easedProgress = 1 - Math.pow(1 - progress, 1.2);
  const targetLength = Math.max(1, Math.round(text.length * easedProgress));
  const sliced = text.slice(0, targetLength);
  const lastWhitespace = Math.max(sliced.lastIndexOf(" "), sliced.lastIndexOf("\n"));

  if (lastWhitespace > 24 && targetLength < text.length) {
    return sliced.slice(0, lastWhitespace).trimEnd();
  }

  return sliced.trimEnd();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function PaywallGate() {
  return (
    <main className="paywall-shell">
      <section className="paywall-card">
        <p className="eyebrow">Private Deployment</p>
        <h1>{paywallTitle}</h1>
        <p className="paywall-copy">{paywallMessage}</p>
        <div className="paywall-actions">
          {paywallCtaUrl ? (
            <a
              className="primary-button paywall-button"
              href={paywallCtaUrl}
              target="_blank"
              rel="noreferrer"
            >
              {paywallCtaLabel}
            </a>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export default function HomePage() {
  const [pdf, setPdf] = useState<File | null>(null);
  const [duration, setDuration] = useState(8);
  const [question, setQuestion] = useState(defaultQuestion);
  const [mouthOpen, setMouthOpen] = useState(0);
  const [speechEnergy, setSpeechEnergy] = useState(0);
  const [playbackSnapshot, setPlaybackSnapshot] = useState<PlaybackSnapshot>({
    confirmedMs: 0,
    predictedMs: 0,
  });
  const [gazeTarget, setGazeTarget] = useState({ x: 0, y: -0.02 });
  const [lipSyncLevel, setLipSyncLevel] = useState(0);
  const [activeSpeech, setActiveSpeech] = useState<ActiveSpeechState | null>(null);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [uiTranscript, setUiTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const playbackFrameRef = useRef<number | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioPrimedRef = useRef(false);
  const activeSpeechRef = useRef<ActiveSpeechState | null>(null);
  const playbackRequestRef = useRef<string | null>(null);
  const playbackClockRef = useRef({
    startedAtMs: 0,
    lastConfirmedMs: 0,
    lastPredictedMs: 0,
  });
  const streamingDebugRef = useRef<{
    entryId: string | null;
    visibleLength: number;
    confirmedMs: number;
    predictedMs: number;
    source: TimelineSource | null;
    alignmentStatus: AlignmentStatus | null;
  }>({
    entryId: null,
    visibleLength: 0,
    confirmedMs: 0,
    predictedMs: 0,
    source: null,
    alignmentStatus: null,
  });
  const playbackTimeMs = playbackSnapshot.confirmedMs;

  function buildClauseRanges(text: string, speechPlan: SpeechPerformance | null): ClauseRange[] {
    if (!speechPlan?.clauses.length) {
      return [];
    }

    const ranges: ClauseRange[] = [];
    let searchStart = 0;

    speechPlan.clauses.forEach((clause, index) => {
      const clauseText = clause.text.trim();
      let start = text.indexOf(clauseText, searchStart);

      if (start === -1) {
        const fallbackStart =
          index === 0
            ? 0
            : ranges[index - 1]?.end ?? Math.round((text.length * index) / speechPlan.clauses.length);
        const fallbackEnd =
          index === speechPlan.clauses.length - 1
            ? text.length
            : Math.round((text.length * (index + 1)) / speechPlan.clauses.length);

        start = fallbackStart;
        ranges.push({
          start,
          end: Math.max(start, fallbackEnd),
          startMs: clause.startMs,
          endMs: clause.endMs,
        });
        searchStart = fallbackEnd;
        return;
      }

      const end = start + clauseText.length;
      ranges.push({
        start,
        end,
        startMs: clause.startMs,
        endMs: clause.endMs,
      });
      searchStart = end;
    });

    return ranges;
  }

  function getConservativeFallbackText(
    text: string,
    confirmedMs: number,
    speechPlan: SpeechPerformance | null,
    durationMs: number,
  ) {
    if (!text) {
      return "";
    }

    const safeElapsedMs = Math.max(0, confirmedMs - FALLBACK_REVEAL_LAG_MS);
    if (durationMs > 0 && safeElapsedMs >= durationMs) {
      return text;
    }

    const clauseRanges = buildClauseRanges(text, speechPlan);
    if (clauseRanges.length) {
      let visibleLength = 0;

      for (const range of clauseRanges) {
        if (safeElapsedMs >= range.endMs) {
          visibleLength = Math.max(visibleLength, range.end);
          continue;
        }

        break;
      }

      return text.slice(0, Math.max(0, visibleLength)).trimEnd();
    }

    return getFallbackStreamedText(text, safeElapsedMs, durationMs);
  }

  function buildStreamingSnapshot(
    speechState: ActiveSpeechState,
    playback: PlaybackSnapshot,
  ): StreamingSnapshot {
    const alignmentText = speechState.alignment
      ? getStreamedTextFromAlignment(speechState.fullText, playback.confirmedMs, speechState.alignment)
      : null;
    const fallbackText = getConservativeFallbackText(
      speechState.fullText,
      playback.confirmedMs,
      speechState.performance,
      speechState.durationMs,
    );
    const visibleText =
      speechState.transcriptStrategy === "pending"
        ? ""
        : speechState.transcriptStrategy === "word" || speechState.transcriptStrategy === "chunk"
          ? alignmentText ?? fallbackText
          : fallbackText;
    return {
      strategy: speechState.transcriptStrategy,
      source: speechState.timelineSource,
      visibleText,
      visibleLength: visibleText.length,
      totalLength: speechState.fullText.length,
      alignmentLength: alignmentText?.length ?? null,
      fallbackLength: fallbackText.length,
      confirmedMs: playback.confirmedMs,
      predictedMs: playback.predictedMs,
      leadMs: Math.max(0, playback.predictedMs - playback.confirmedMs),
    };
  }

  function setAvatarSpeech(value: number, energy = value) {
    setMouthOpen(value);
    setLipSyncLevel(value);
    setSpeechEnergy(energy);
  }

  function scrollTranscriptToBottom(behavior: ScrollBehavior = "auto") {
    transcriptEndRef.current?.scrollIntoView({
      behavior,
      block: "end",
    });
  }

  function syncTranscriptFromSession(transcript: TranscriptEntry[]) {
    setUiTranscript(transcript);
  }

  function updateActiveSpeechState(
    entryId: string | undefined,
    updater: (current: ActiveSpeechState) => ActiveSpeechState,
  ) {
    setActiveSpeech((current) => {
      if (!current || (entryId && current.entryId !== entryId)) {
        return current;
      }

      const nextActiveSpeech = updater(current);
      activeSpeechRef.current = nextActiveSpeech;
      return nextActiveSpeech;
    });
  }

  function startStreamingEntry(entryId: string, fullText: string) {
    const nextActiveSpeech = {
      entryId,
      fullText,
      durationMs: 0,
      alignment: null,
      performance: null,
      alignmentStatus: "pending" as const,
      timelineSource: "fallback" as const,
      transcriptStrategy: "pending" as const,
    };

    activeSpeechRef.current = nextActiveSpeech;
    setActiveSpeech(nextActiveSpeech);
    setPlaybackSnapshot({
      confirmedMs: 0,
      predictedMs: 0,
    });
    streamingDebugRef.current = {
      entryId,
      visibleLength: 0,
      confirmedMs: 0,
      predictedMs: 0,
      source: null,
      alignmentStatus: "pending",
    };
    setUiTranscript((current) =>
      current.map((entry) =>
        entry.id === entryId && entry.speaker === "airi" ? { ...entry, text: "" } : entry,
      ),
    );
  }

  function patchStreamingEntry(entryId: string, nextVisibleText: string) {
    setUiTranscript((current) =>
      current.map((entry) => {
        if (entry.id !== entryId) {
          return entry;
        }

        return nextVisibleText.length > entry.text.length
          ? { ...entry, text: nextVisibleText }
          : entry;
      }),
    );
  }

  function finalizeStreamingEntry() {
    const currentActiveSpeech = activeSpeechRef.current;

    if (!currentActiveSpeech) {
      return;
    }

    setUiTranscript((current) =>
      current.map((entry) =>
        entry.id === currentActiveSpeech.entryId
          ? { ...entry, text: currentActiveSpeech.fullText }
          : entry,
      ),
    );
  }

  function stopPlayback() {
    playbackRequestRef.current = null;
    finalizeStreamingEntry();

    if (playbackFrameRef.current != null) {
      cancelAnimationFrame(playbackFrameRef.current);
      playbackFrameRef.current = null;
    }

    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute("src");
      audio.load();
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    setPlaybackSnapshot({
      confirmedMs: 0,
      predictedMs: 0,
    });
    playbackClockRef.current = {
      startedAtMs: 0,
      lastConfirmedMs: 0,
      lastPredictedMs: 0,
    };
    activeSpeechRef.current = null;
    streamingDebugRef.current = {
      entryId: null,
      visibleLength: 0,
      confirmedMs: 0,
      predictedMs: 0,
      source: null,
      alignmentStatus: null,
    };
    setActiveSpeech(null);
    setAvatarSpeech(0, 0);
  }

  async function ensureAudioPipeline() {
    if (typeof window === "undefined") {
      throw new Error("Audio playback is only available in the browser.");
    }

    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
      audioRef.current.crossOrigin = "anonymous";
      audioRef.current.setAttribute("playsinline", "true");
    }

    if (!audioContextRef.current) {
      const audioContext = new window.AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;

      const source = audioContext.createMediaElementSource(audioRef.current);
      source.connect(analyser);
      analyser.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      audioSourceRef.current = source;
      analyserRef.current = analyser;
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    if (!analyserRef.current) {
      throw new Error("Audio analyzer is unavailable.");
    }

    return {
      audio: audioRef.current,
      analyser: analyserRef.current,
    };
  }

  async function primeAudioPlayback() {
    if (audioPrimedRef.current || typeof window === "undefined") {
      return;
    }

    const { audio } = await ensureAudioPipeline();
    const originalMuted = audio.muted;
    const originalVolume = audio.volume;
    const silentAudioDataUri =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

    audio.muted = true;
    audio.volume = 0;
    audio.src = silentAudioDataUri;
    audio.load();

    try {
      await audio.play();
      audio.pause();
    } catch {
      return;
    } finally {
      audio.currentTime = 0;
      audio.removeAttribute("src");
      audio.load();
      audio.muted = originalMuted;
      audio.volume = originalVolume;
    }

    audioPrimedRef.current = true;
  }

  function trackLoudness(analyser: AnalyserNode, audio: HTMLAudioElement) {
    const samples = new Uint8Array(analyser.frequencyBinCount);
    let smoothedLevel = 0;
    let previousAverage = 0;

    const tick = () => {
      analyser.getByteFrequencyData(samples);

      let sum = 0;
      let peak = 0;
      for (const sample of samples) {
        sum += sample;
        peak = Math.max(peak, sample);
      }

      const average = sum / Math.max(samples.length, 1);
      const averageLevel = Math.max(0, (average - 6) / 36);
      const peakLevel = Math.max(0, (peak - 24) / 180);
      const cadence = Math.min(1, Math.abs(average - previousAverage) / 26);
      const targetLevel = Math.min(
        1,
        Math.pow(Math.max(averageLevel, peakLevel * 1.25), 0.72),
      );

      previousAverage = average;
      smoothedLevel = Math.max(targetLevel, smoothedLevel * 0.8);
      const expressive =
        smoothedLevel > 0.035
          ? Math.min(1, 0.16 + smoothedLevel * 0.78 + cadence * 0.18)
          : 0;

      const playbackClock = playbackClockRef.current;
      const mediaElapsedMs = audio.currentTime * 1000;
      if (playbackClock.startedAtMs <= 0) {
        playbackClock.startedAtMs = performance.now() - mediaElapsedMs;
      }
      const clockElapsedMs = Math.max(0, performance.now() - playbackClock.startedAtMs);
      let nextConfirmedMs = mediaElapsedMs;
      if (nextConfirmedMs < playbackClock.lastConfirmedMs) {
        nextConfirmedMs =
          playbackClock.lastConfirmedMs - nextConfirmedMs <= PLAYBACK_JITTER_TOLERANCE_MS
            ? playbackClock.lastConfirmedMs
            : nextConfirmedMs;
      }

      let nextPredictedMs = Math.max(nextConfirmedMs, clockElapsedMs - PLAYBACK_JITTER_TOLERANCE_MS);
      if (nextPredictedMs < playbackClock.lastPredictedMs) {
        nextPredictedMs =
          playbackClock.lastPredictedMs - nextPredictedMs <= PLAYBACK_JITTER_TOLERANCE_MS
            ? playbackClock.lastPredictedMs
            : nextPredictedMs;
      }

      if (nextPredictedMs - playbackClock.lastPredictedMs > PLAYBACK_FORWARD_JUMP_CAP_MS) {
        nextPredictedMs = playbackClock.lastPredictedMs + PLAYBACK_FORWARD_JUMP_CAP_MS;
      }

      playbackClock.lastConfirmedMs = nextConfirmedMs;
      playbackClock.lastPredictedMs = nextPredictedMs;
      setAvatarSpeech(expressive, smoothedLevel);
      setPlaybackSnapshot({
        confirmedMs: Math.round(nextConfirmedMs),
        predictedMs: Math.round(nextPredictedMs),
      });
      playbackFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  }

  async function fetchSpeechPerformance(text: string) {
    const response = await fetch("/api/tts/performance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      throw new Error(data.error ?? "Failed to generate speech performance.");
    }

    return (await response.json()) as SpeechPerformance;
  }

  async function fetchSpeechAlignment(blob: Blob) {
    const formData = new FormData();
    formData.append("audio", new File([blob], "speech.mp3", { type: "audio/mpeg" }));

    const response = await fetch("/api/tts/alignment", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      throw new Error(data.error ?? "Failed to align speech.");
    }

    return (await response.json()) as SpeechAlignment;
  }

  async function playSpeech(text: string, entryId?: string) {
    if (!text.trim()) {
      return;
    }

    stopPlayback();
    const playbackRequestId = crypto.randomUUID();
    playbackRequestRef.current = playbackRequestId;

    if (entryId) {
      startStreamingEntry(entryId, text);
    }

    try {
      const [response, heuristicPerformance] = await Promise.all([
        fetch("/api/tts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text }),
        }),
        fetchSpeechPerformance(text).catch(() => null),
      ]);

      if (playbackRequestRef.current !== playbackRequestId) {
        return;
      }

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to synthesize audio.");
      }

      const { audio, analyser } = await ensureAudioPipeline();
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      if (playbackRequestRef.current !== playbackRequestId) {
        URL.revokeObjectURL(objectUrl);
        return;
      }

      audioUrlRef.current = objectUrl;
      audio.muted = false;
      audio.volume = 1;
      audio.src = objectUrl;
      audio.load();
      audio.onended = () => {
        stopPlayback();
      };
      audio.onerror = () => {
        stopPlayback();
      };

      const metadataLoaded = new Promise<void>((resolve, reject) => {
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
          resolve();
          return;
        }

        const handleLoadedMetadata = () => {
          audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
          audio.removeEventListener("error", handleMetadataError);
          resolve();
        };
        const handleMetadataError = () => {
          audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
          audio.removeEventListener("error", handleMetadataError);
          reject(new Error("Failed to load speech audio metadata."));
        };

        audio.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
        audio.addEventListener("error", handleMetadataError, { once: true });
      });

      await metadataLoaded;

      if (playbackRequestRef.current !== playbackRequestId) {
        return;
      }

      const actualDurationMs = Number.isFinite(audio.duration)
        ? Math.round(audio.duration * 1000)
        : heuristicPerformance?.durationMs ?? 0;
      const normalizedPerformance = heuristicPerformance
        ? normalizeSpeechPerformance(heuristicPerformance, actualDurationMs)
        : null;

      updateActiveSpeechState(entryId, (current) => ({
        ...current,
        durationMs: actualDurationMs,
        performance: normalizedPerformance,
        alignmentStatus: "pending",
        timelineSource: "fallback",
        transcriptStrategy: "fallback",
      }));
      await audio.play();
      playbackClockRef.current = {
        startedAtMs: performance.now() - audio.currentTime * 1000,
        lastConfirmedMs: audio.currentTime * 1000,
        lastPredictedMs: audio.currentTime * 1000,
      };

      if (playbackRequestRef.current !== playbackRequestId) {
        return;
      }

      trackLoudness(analyser, audio);
      const alignmentResult = await fetchSpeechAlignment(blob).catch(() => null);

      if (playbackRequestRef.current !== playbackRequestId) {
        return;
      }

      if (!alignmentResult) {
        updateActiveSpeechState(entryId, (current) => ({
          ...current,
          alignmentStatus: "unavailable",
          timelineSource: "fallback",
          transcriptStrategy: "fallback",
        }));
        return;
      }

      const normalizedAlignment = normalizeSpeechAlignment(alignmentResult, actualDurationMs);
      const alignedPerformance = normalizeSpeechPerformance(
        createAlignedSpeechPerformance(text, normalizedAlignment),
        actualDurationMs,
      );
      const transcriptStrategy: TranscriptStreamStrategy = normalizedAlignment.mode;
      const alignmentStatus: AlignmentStatus =
        normalizedAlignment.mode === "word" ? "ready" : "degraded";

      updateActiveSpeechState(entryId, (current) => ({
        ...current,
        alignment: normalizedAlignment,
        performance: alignedPerformance,
        alignmentStatus,
        timelineSource: "aligned",
        transcriptStrategy,
      }));
    } catch (error) {
      if (playbackRequestRef.current === playbackRequestId) {
        stopPlayback();
      }

      throw error;
    }
  }

  useEffect(() => {
    return () => {
      stopPlayback();
      audioSourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  const remainingBeats = useMemo(() => {
    if (!session) return [];
    return session.studyPlan.beats.slice(session.nextBeatIndex);
  }, [session]);

  const streamingSnapshot = useMemo(
    () => (activeSpeech ? buildStreamingSnapshot(activeSpeech, playbackSnapshot) : null),
    [activeSpeech, playbackSnapshot],
  );

  const displayedActiveLength = useMemo(
    () => uiTranscript.find((entry) => entry.id === activeSpeech?.entryId)?.text.length ?? 0,
    [activeSpeech?.entryId, uiTranscript],
  );

  useEffect(() => {
    if (!activeSpeech || !streamingSnapshot) {
      return;
    }

    patchStreamingEntry(activeSpeech.entryId, streamingSnapshot.visibleText);
  }, [activeSpeech, playbackSnapshot.confirmedMs, streamingSnapshot]);

  useEffect(() => {
    if (!activeSpeech || !streamingSnapshot) {
      return;
    }

    const debugState = streamingDebugRef.current;
    const isNewEntry = debugState.entryId !== activeSpeech.entryId;

    if (isNewEntry) {
      streamingDebugRef.current = {
        entryId: activeSpeech.entryId,
        visibleLength: streamingSnapshot.visibleLength,
        confirmedMs: streamingSnapshot.confirmedMs,
        predictedMs: streamingSnapshot.predictedMs,
        source: streamingSnapshot.source,
        alignmentStatus: activeSpeech.alignmentStatus,
      };
      return;
    }

    debugState.visibleLength = streamingSnapshot.visibleLength;
    debugState.confirmedMs = streamingSnapshot.confirmedMs;
    debugState.predictedMs = streamingSnapshot.predictedMs;
    debugState.source = streamingSnapshot.source;
    debugState.alignmentStatus = activeSpeech.alignmentStatus;
  }, [activeSpeech, streamingSnapshot]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollTranscriptToBottom("auto");
    });

    return () => window.cancelAnimationFrame(frame);
  }, [uiTranscript.length]);

  useEffect(() => {
    if (!activeSpeech) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollTranscriptToBottom("auto");
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeSpeech, displayedActiveLength]);

  async function initializeSession() {
    if (!pdf) {
      setError("Choose an arXiv PDF first.");
      return;
    }

    await primeAudioPlayback().catch(() => undefined);

    const formData = new FormData();
    formData.append("pdf", pdf);
    formData.append("durationMinutes", String(duration));

    setError(null);

    startTransition(async () => {
      const response = await fetch("/api/study-plan", {
        method: "POST",
        body: formData,
      });

      const data = (await response.json()) as
        | SessionPayload
        | { error: string };

      if (!response.ok || "error" in data) {
        setError(getErrorMessage(data, "Failed to build the lesson."));
        return;
      }

      setSession(data);
      syncTranscriptFromSession(
        data.transcript[0]
          ? data.transcript.map((entry) =>
              entry.id === data.transcript[0].id && entry.speaker === "airi"
                ? { ...entry, text: "" }
                : entry,
            )
          : data.transcript,
      );
      if (data.transcript[0]) {
        try {
          await playSpeech(data.transcript[0].text, data.transcript[0].id);
        } catch (playbackError) {
          const message =
            playbackError instanceof Error
              ? playbackError.message
              : "Failed to play Airi's voice.";
          setError(message);
        }
      }
    });
  }

  async function continueLesson() {
    if (!session) return;

    setError(null);
    await primeAudioPlayback().catch(() => undefined);

    startTransition(async () => {
      const response = await fetch("/api/session/continue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(session),
      });

      const data = (await response.json()) as
        | SessionPayload
        | { error: string };

      if (!response.ok || "error" in data) {
        setError(getErrorMessage(data, "Failed to continue the lesson."));
        return;
      }

      const newestEntry = data.transcript[data.transcript.length - 1];
      setSession(data);
      syncTranscriptFromSession(
        newestEntry?.speaker === "airi"
          ? data.transcript.map((entry) =>
              entry.id === newestEntry.id && entry.speaker === "airi"
                ? { ...entry, text: "" }
                : entry,
            )
          : data.transcript,
      );
      if (newestEntry?.speaker === "airi") {
        try {
          await playSpeech(newestEntry.text, newestEntry.id);
        } catch (playbackError) {
          const message =
            playbackError instanceof Error
              ? playbackError.message
              : "Failed to play Airi's voice.";
          setError(message);
        }
      }
    });
  }

  async function askQuestion() {
    if (!session || !question.trim()) return;

    setError(null);
    await primeAudioPlayback().catch(() => undefined);

    const optimisticStudentLine: TranscriptEntry = {
      id: crypto.randomUUID(),
      speaker: "student",
      text: question.trim(),
      kind: "question",
    };

    const optimisticSession: SessionPayload = {
      ...session,
      transcript: [...session.transcript, optimisticStudentLine],
    };

    setSession(optimisticSession);
    syncTranscriptFromSession(optimisticSession.transcript);
    setQuestion("");

    startTransition(async () => {
      const response = await fetch("/api/session/question", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...optimisticSession,
          latestQuestion: optimisticStudentLine.text,
        }),
      });

      const data = (await response.json()) as
        | SessionPayload
        | { error: string };

      if (!response.ok || "error" in data) {
        setSession(session);
        syncTranscriptFromSession(session.transcript);
        setError(getErrorMessage(data, "Failed to answer the question."));
        return;
      }

      const newestEntry = data.transcript[data.transcript.length - 1];
      setSession(data);
      syncTranscriptFromSession(
        newestEntry?.speaker === "airi"
          ? data.transcript.map((entry) =>
              entry.id === newestEntry.id && entry.speaker === "airi"
                ? { ...entry, text: "" }
                : entry,
            )
          : data.transcript,
      );
      if (newestEntry?.speaker === "airi") {
        try {
          await playSpeech(newestEntry.text, newestEntry.id);
        } catch (playbackError) {
          const message =
            playbackError instanceof Error
              ? playbackError.message
              : "Failed to play Airi's voice.";
          setError(message);
        }
      }
    });
  }

  const progress = session
    ? Math.min(
        100,
        Math.round((session.nextBeatIndex / Math.max(session.studyPlan.beats.length, 1)) * 100),
      )
    : 0;

  if (paywallEnabled) {
    return <PaywallGate />;
  }

  return (
    <main className="shell">
      <section className="dashboard">
        <div className="content-column">
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">Anime Research Tutor</p>
              <p className="lede">
                Upload a PDF, pick how long the lesson should run, then let Airi teach
                through a live transcript. You can interrupt with typed questions or ask
                her to carry on.
              </p>
            </div>
          </section>

          <section className="workspace">
            <aside className="control-panel">
              <h2>Lesson Setup</h2>
              <label className="field">
                <span>Research PDF</span>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(event) => setPdf(event.target.files?.[0] ?? null)}
                />
              </label>

              <label className="field">
                <span>Session length: {duration} min</span>
                <input
                  type="range"
                  min={3}
                  max={30}
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                />
              </label>

              <button className="primary-button" onClick={initializeSession} disabled={isPending}>
                {isPending ? "Building lesson..." : "Start lesson"}
              </button>

              {session ? (
                <div className="lesson-meta">
                  <p className="meta-label">Paper</p>
                  <p className="meta-title">{session.studyPlan.paperTitle}</p>
                  <p className="meta-summary">{session.studyPlan.paperSummary}</p>

                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="progress-copy">{progress}% of the guided lesson covered</p>

                  <div className="up-next">
                    <p className="meta-label">Up next</p>
                    {remainingBeats.slice(0, 3).map((beat: LessonBeat) => (
                      <div key={beat.index} className="beat-chip">
                        <span>{beat.title}</span>
                        <small>{Math.round(beat.estimatedSeconds / 60)} min</small>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {error ? <p className="error-box">{error}</p> : null}
            </aside>
          </section>
        </div>

        <aside className="avatar-card avatar-rail">
          <div className="avatar-stage avatar-stage-vrm">
            <VrmAvatar
              alignment={activeSpeech?.alignment ?? null}
              performance={activeSpeech?.performance ?? null}
              playbackTimeMs={playbackTimeMs}
              speechEnergy={speechEnergy}
              gazeTarget={gazeTarget}
              modelFile={null}
            />
            <div className="lip-sync-meter" aria-hidden="true">
              <div
                className="lip-sync-meter-fill"
                style={{ transform: `scaleX(${lipSyncLevel.toFixed(3)})` }}
              />
            </div>
            <section className="transcript-overlay">
              <div className="transcript-header">
                <div>
                  <p className="eyebrow">Transcript</p>
                  <h2>{session ? "Live lesson" : "Waiting for a paper"}</h2>
                </div>
                <button
                  className="secondary-button"
                  onClick={continueLesson}
                  disabled={!session || isPending}
                >
                  {isPending ? "Thinking..." : "Carry on"}
                </button>
              </div>

              <div className="transcript-feed">
                {uiTranscript.length ? (
                  uiTranscript.map((entry) => (
                    <article
                      key={entry.id}
                      className={`bubble ${entry.speaker === "airi" ? "bubble-airi" : "bubble-student"}`}
                    >
                      <p className="bubble-speaker">
                        {entry.speaker === "airi" ? "Airi" : "You"}
                      </p>
                      <p>
                        {`${entry.text}${
                          entry.id === activeSpeech?.entryId &&
                          playbackTimeMs >= 0 &&
                          playbackTimeMs < (activeSpeech?.durationMs ?? 0)
                            ? " |"
                            : ""
                        }`}
                      </p>
                    </article>
                  ))
                ) : (
                  <div className="empty-state">
                    <p>How to start:</p>
                    <p>1. Choose an arXiv PDF in the lesson setup panel.</p>
                    <p>2. Pick how many minutes you want the guided lesson to run.</p>
                    <p>3. Click Start lesson to generate the opening explanation.</p>
                    <p>4. Use Carry on for the next beat, or type a question to interrupt.</p>
                  </div>
                )}
                <div ref={transcriptEndRef} />
              </div>

              <div className="question-bar">
                <textarea
                  value={question}
                  rows={3}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="Ask what a formula means, request a simpler explanation, or say what confused you."
                />
                <button className="primary-button" onClick={askQuestion} disabled={!session || isPending}>
                  Ask Airi
                </button>
              </div>
            </section>
          </div>
        </aside>
      </section>
    </main>
  );
}
