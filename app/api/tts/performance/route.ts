import { NextResponse } from "next/server";
import { createSpeechPerformance } from "@/lib/speech-performance";

type TtsPerformanceRequest = {
  text?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TtsPerformanceRequest;
    const text = body.text?.trim();

    if (!text) {
      return NextResponse.json({ error: "Text is required." }, { status: 400 });
    }

    return NextResponse.json(createSpeechPerformance(text), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate speech performance.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
