import OpenAI from "openai";
import { toFile } from "openai/uploads";
import type { SpeechAlignment } from "@/lib/types";

const MIN_ALIGNMENT_SPAN_MS = 24;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function reachesThreshold(count: number, total: number, fraction: number) {
  if (count <= 0 || total <= 0) {
    return false;
  }

  return count >= Math.max(1, Math.floor(total * fraction));
}

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  return new OpenAI({ apiKey });
}

type JsonResponseParams = {
  instructions: string;
  schemaName: string;
  schema: Record<string, unknown>;
  input: Array<Record<string, unknown>>;
};

type SpeechParams = {
  input: string;
};

export async function uploadPdf(pdf: File) {
  const client = getClient();
  const arrayBuffer = await pdf.arrayBuffer();
  const file = await toFile(Buffer.from(arrayBuffer), pdf.name, {
    type: pdf.type || "application/pdf",
  });

  return client.files.create({
    file,
    purpose: "user_data",
  });
}

export async function createJsonResponse<T>({
  instructions,
  schemaName,
  schema,
  input,
}: JsonResponseParams): Promise<T> {
  const client = getClient();
  const response = await client.responses.create(
    {
      model: "gpt-5-mini",
      instructions,
      input,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
    } as never,
  );

  const rawText = response.output_text;

  if (!rawText) {
    throw new Error("Model returned no structured output.");
  }

  return JSON.parse(rawText) as T;
}

export async function createSpeechAudio({ input }: SpeechParams) {
  const client = getClient();

  return client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: process.env.OPENAI_TTS_VOICE ?? "shimmer",
    input,
    instructions:
      "Speak with a young, bright, high-pitched anime tutor voice. Sound gentle, curious, playful, and energetic, like a preteen schoolgirl character, while staying clear and easy to understand.",
  });
}

export async function createSpeechAlignment(
  audioBuffer: Buffer,
  filename = "speech.mp3",
): Promise<SpeechAlignment> {
  const client = getClient();
  const file = await toFile(audioBuffer, filename, {
    type: "audio/mpeg",
  });

  const response = (await client.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  })) as {
    duration?: number;
    words?: Array<{
      word?: string;
      start?: number;
      end?: number;
    }>;
  };

  const rawWords = (response.words ?? [])
    .map((word) => ({
      text: word.word?.trim() ?? "",
      startMs: Math.max(0, Math.round((word.start ?? 0) * 1000)),
      endMs: Math.max(0, Math.round((word.end ?? 0) * 1000)),
    }))
    .filter((word) => word.text.length > 0 && word.endMs >= word.startMs);

  let zeroStartCount = 0;
  let zeroDurationCount = 0;
  let nonMonotonicCount = 0;
  let previousStartMs = -1;

  for (const word of rawWords) {
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
  }

  const responseDurationMs = Math.max(0, Math.round((response.duration ?? 0) * 1000));
  const wordEndDurationMs = rawWords.at(-1)?.endMs ?? 0;
  const durationMs = Math.max(responseDurationMs, wordEndDurationMs);
  const observedSpanMs =
    rawWords.length > 0 ? Math.max(0, rawWords[rawWords.length - 1].endMs - rawWords[0].startMs) : 0;
  const compressedSpanRatio =
    durationMs > 0 ? clamp(observedSpanMs / durationMs, 0, 1) : observedSpanMs > 0 ? 1 : 0;
  const isReliable =
    rawWords.length <= 1 ||
    !(
      compressedSpanRatio < 0.35 ||
      reachesThreshold(zeroDurationCount, rawWords.length, 0.25) ||
      reachesThreshold(zeroStartCount, rawWords.length, 1 / 3) ||
      reachesThreshold(nonMonotonicCount, rawWords.length, 1 / 3) ||
      reachesThreshold(
        rawWords.filter((word) => word.endMs - word.startMs < MIN_ALIGNMENT_SPAN_MS).length,
        rawWords.length,
        0.5,
      )
    );

  return {
    durationMs,
    mode: isReliable ? "word" : "chunk",
    health: {
      zeroStartCount,
      zeroDurationCount,
      nonMonotonicCount,
      compressedSpanRatio,
      isReliable,
    },
    words: rawWords,
  };
}
