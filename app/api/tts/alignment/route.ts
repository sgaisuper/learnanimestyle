import { NextResponse } from "next/server";
import { createSpeechAlignment } from "@/lib/openai";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");

    if (!(audio instanceof File)) {
      return NextResponse.json({ error: "Audio file is required." }, { status: 400 });
    }

    const arrayBuffer = await audio.arrayBuffer();
    const alignment = await createSpeechAlignment(Buffer.from(arrayBuffer), audio.name);

    return NextResponse.json(alignment, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to align speech.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
