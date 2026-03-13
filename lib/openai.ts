import OpenAI from "openai";
import { toFile } from "openai/uploads";
import type { SpeechAlignment } from "@/lib/types";

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

  const words = (response.words ?? [])
    .map((word) => ({
      text: word.word?.trim() ?? "",
      startMs: Math.max(0, Math.round((word.start ?? 0) * 1000)),
      endMs: Math.max(0, Math.round((word.end ?? 0) * 1000)),
    }))
    .filter((word) => word.text.length > 0 && word.endMs >= word.startMs);

  const durationMs =
    words.at(-1)?.endMs ??
    Math.max(0, Math.round((response.duration ?? 0) * 1000));

  return {
    durationMs,
    words,
  };
}
