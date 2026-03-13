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
  transcriptStrategy: TranscriptStreamStrategy;
};

type TranscriptStreamStrategy = "pending" | "fallback" | "performance" | "alignment";

type StreamingSnapshot = {
  strategy: TranscriptStreamStrategy;
  visibleText: string;
  visibleLength: number;
  totalLength: number;
  fallbackLength: number;
  performanceLength: number | null;
  alignmentLength: number | null;
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
  };
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
      words: [],
    };
  }

  const clampedWords = scaledWords.map((word) => ({
    ...word,
    startMs: clamp(word.startMs, 0, safeActualDurationMs),
    endMs: clamp(Math.max(word.endMs, word.startMs), 0, safeActualDurationMs),
  }));

  let previousStartMs = -1;
  let duplicateStartCount = 0;
  let narrowSpanCount = 0;

  clampedWords.forEach((word) => {
    if (word.startMs <= previousStartMs) {
      duplicateStartCount += 1;
    }

    if (word.endMs - word.startMs < 24) {
      narrowSpanCount += 1;
    }

    previousStartMs = Math.max(previousStartMs, word.startMs);
  });

  const observedSpanMs =
    clampedWords.at(-1) != null ? clampedWords[clampedWords.length - 1].endMs - clampedWords[0].startMs : 0;
  const needsRedistribution =
    clampedWords.length > 1 &&
    (observedSpanMs < safeActualDurationMs * 0.35 ||
      duplicateStartCount >= Math.floor(clampedWords.length / 3) ||
      narrowSpanCount >= Math.floor(clampedWords.length / 2));

  if (needsRedistribution) {
    const weightedWords = clampedWords.map((word) => {
      const normalized = normalizeToken(word.text);
      const weight = Math.max(normalized.length, 1);
      return { word, weight };
    });
    const totalWeight = weightedWords.reduce((sum, entry) => sum + entry.weight, 0);
    let cursorMs = 0;

    return {
      durationMs: safeActualDurationMs,
      words: weightedWords.map(({ word, weight }, index) => {
        const remainingWords = weightedWords.length - index;
        const remainingMs = Math.max(safeActualDurationMs - cursorMs, 1);
        const sliceMs =
          index === weightedWords.length - 1
            ? remainingMs
            : Math.max(
                70,
                Math.min(
                  remainingMs,
                  Math.round((weight / Math.max(totalWeight, 1)) * safeActualDurationMs),
                ),
              );
        const startMs = cursorMs;
        const endMs = Math.min(safeActualDurationMs, startMs + sliceMs);

        cursorMs =
          remainingWords > 1 ? Math.min(safeActualDurationMs, Math.max(endMs, startMs + 70)) : safeActualDurationMs;

        return {
          ...word,
          startMs,
          endMs: Math.max(endMs, startMs + 1),
        };
      }),
    };
  }

  return {
    durationMs: safeActualDurationMs,
    words: clampedWords.map((word, index) => {
      const previousWord = clampedWords[index - 1];
      const startMs =
        previousWord == null ? word.startMs : Math.max(word.startMs, previousWord.startMs + 1);
      const endMs = Math.max(startMs + 1, word.endMs);

      return {
        ...word,
        startMs: clamp(startMs, 0, safeActualDurationMs),
        endMs: clamp(endMs, 0, safeActualDurationMs),
      };
    }),
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
    if (elapsedMs >= range.startMs) {
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

export default function HomePage() {
  const [pdf, setPdf] = useState<File | null>(null);
  const [duration, setDuration] = useState(8);
  const [question, setQuestion] = useState(defaultQuestion);
  const [mouthOpen, setMouthOpen] = useState(0);
  const [speechEnergy, setSpeechEnergy] = useState(0);
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0);
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
  const streamingDebugRef = useRef<{
    entryId: string | null;
    visibleLength: number;
    elapsedMs: number;
    alignmentLogged: boolean;
  }>({
    entryId: null,
    visibleLength: 0,
    elapsedMs: 0,
    alignmentLogged: false,
  });

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

  function getStreamedText(text: string, elapsedMs: number, speechPlan: SpeechPerformance | null) {
    if (!text) {
      return "";
    }

    if (!speechPlan || speechPlan.durationMs <= 0 || !speechPlan.clauses.length) {
      return text;
    }

    const clauseRanges = buildClauseRanges(text, speechPlan);
    if (!clauseRanges.length) {
      return text;
    }

    let visibleLength = 0;

    for (const range of clauseRanges) {
      if (elapsedMs >= range.endMs) {
        visibleLength = Math.max(visibleLength, range.end);
        continue;
      }

      if (elapsedMs < range.startMs) {
        break;
      }

      const clauseDuration = Math.max(range.endMs - range.startMs, 1);
      const clauseProgress = Math.min(1, Math.max(0, (elapsedMs - range.startMs) / clauseDuration));
      const easedProgress = 1 - Math.pow(1 - clauseProgress, 1.28);
      const targetLength = range.start + Math.round((range.end - range.start) * easedProgress);
      visibleLength = Math.max(visibleLength, targetLength);
      break;
    }

    if (elapsedMs >= speechPlan.durationMs) {
      return text;
    }

    const safeLength = Math.max(1, visibleLength);
    const sliced = text.slice(0, safeLength);
    const activeRange =
      clauseRanges.find((range) => elapsedMs >= range.startMs && elapsedMs < range.endMs) ?? null;

    if (!activeRange) {
      return sliced;
    }

    const localSlice = text.slice(activeRange.start, safeLength);
    const lastWhitespace = localSlice.lastIndexOf(" ");
    if (lastWhitespace > 0 && safeLength < activeRange.end) {
      return text.slice(0, activeRange.start + lastWhitespace);
    }

    return sliced;
  }

  function buildStreamingSnapshot(
    speechState: ActiveSpeechState,
    elapsedMs: number,
  ): StreamingSnapshot {
    const alignmentText = speechState.alignment
      ? getStreamedTextFromAlignment(speechState.fullText, elapsedMs, speechState.alignment)
      : null;
    const visibleText = speechState.transcriptStrategy === "alignment" ? alignmentText ?? "" : "";

    return {
      strategy: speechState.transcriptStrategy,
      visibleText,
      visibleLength: visibleText.length,
      totalLength: speechState.fullText.length,
      fallbackLength: 0,
      performanceLength: null,
      alignmentLength: alignmentText?.length ?? null,
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

  function startStreamingEntry(entryId: string, fullText: string) {
    const nextActiveSpeech = {
      entryId,
      fullText,
      durationMs: 0,
      alignment: null,
      performance: null,
      transcriptStrategy: "pending" as const,
    };

    activeSpeechRef.current = nextActiveSpeech;
    setActiveSpeech(nextActiveSpeech);
    setPlaybackTimeMs(0);
    streamingDebugRef.current = {
      entryId,
      visibleLength: 0,
      elapsedMs: 0,
      alignmentLogged: false,
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

    setPlaybackTimeMs(0);
    activeSpeechRef.current = null;
    streamingDebugRef.current = {
      entryId: null,
      visibleLength: 0,
      elapsedMs: 0,
      alignmentLogged: false,
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

      setAvatarSpeech(expressive, smoothedLevel);
      setPlaybackTimeMs(audio.currentTime * 1000);
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
      const alignmentResult = await fetchSpeechAlignment(blob).catch(() => null);

      if (!alignmentResult) {
        throw new Error("Failed to align speech before playback.");
      }

      if (playbackRequestRef.current !== playbackRequestId) {
        return;
      }

      const normalizedAlignment = normalizeSpeechAlignment(alignmentResult, actualDurationMs);
      const alignedPerformance = normalizeSpeechPerformance(
        createAlignedSpeechPerformance(text, normalizedAlignment),
        actualDurationMs,
      );
      const transcriptStrategy: TranscriptStreamStrategy = "alignment";

      setActiveSpeech((current) => {
        if (!current || current.entryId !== entryId) {
          return current;
        }

        const nextActiveSpeech = {
          ...current,
          durationMs: actualDurationMs,
          alignment: normalizedAlignment,
          performance: alignedPerformance,
          transcriptStrategy,
        };

        activeSpeechRef.current = nextActiveSpeech;
        return nextActiveSpeech;
      });
      await audio.play();

      if (playbackRequestRef.current !== playbackRequestId) {
        return;
      }

      trackLoudness(analyser, audio);
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
    () => (activeSpeech ? buildStreamingSnapshot(activeSpeech, playbackTimeMs) : null),
    [activeSpeech, playbackTimeMs],
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
  }, [
    activeSpeech,
    playbackTimeMs,
    streamingSnapshot,
  ]);

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
        elapsedMs: playbackTimeMs,
        alignmentLogged: false,
      };
      return;
    }

    const charDelta = streamingSnapshot.visibleLength - debugState.visibleLength;
    const timeDelta = playbackTimeMs - debugState.elapsedMs;
    const alignmentDelta =
      streamingSnapshot.alignmentLength != null
        ? Math.abs(streamingSnapshot.alignmentLength - streamingSnapshot.visibleLength)
        : 0;

    if (!debugState.alignmentLogged && streamingSnapshot.alignmentLength != null) {
      debugState.alignmentLogged = true;
    }

    debugState.visibleLength = streamingSnapshot.visibleLength;
    debugState.elapsedMs = playbackTimeMs;
  }, [activeSpeech, playbackTimeMs, streamingSnapshot]);

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
