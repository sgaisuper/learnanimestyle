import { NextResponse } from "next/server";
import { createSpeechAudio } from "@/lib/openai";

type TtsRequest = {
  text?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TtsRequest;
    const text = body.text?.trim();

    if (!text) {
      return NextResponse.json({ error: "Text is required." }, { status: 400 });
    }

    const speech = await createSpeechAudio({ input: text });
    const arrayBuffer = await speech.arrayBuffer();

    return new NextResponse(Buffer.from(arrayBuffer), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to synthesize speech.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
