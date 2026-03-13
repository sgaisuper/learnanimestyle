import { NextResponse } from "next/server";
import { createJsonResponse } from "@/lib/openai";
import { continueLessonInstructions, continueLessonSchema } from "@/lib/prompts";
import type { ContinueLessonResponse, SessionPayload, TranscriptEntry } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const session = (await request.json()) as SessionPayload;
    const nextBeat = session.studyPlan.beats[session.nextBeatIndex];

    if (!nextBeat) {
      return NextResponse.json(
        { error: "The lesson is already complete." },
        { status: 400 },
      );
    }

    const response = await createJsonResponse<ContinueLessonResponse>({
      instructions: continueLessonInstructions(session.studyPlan, nextBeat, session.transcript),
      schemaName: "continue_lesson",
      schema: continueLessonSchema,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Continue teaching the next section of the paper.",
            },
            {
              type: "input_file",
              file_id: session.fileId,
            },
          ],
        },
      ],
    });

    const airiEntry: TranscriptEntry = {
      id: crypto.randomUUID(),
      speaker: "airi",
      kind: "lesson",
      text: response.spoken,
    };

    return NextResponse.json({
      ...session,
      nextBeatIndex: session.nextBeatIndex + 1,
      transcript: [...session.transcript, airiEntry],
    } satisfies SessionPayload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to continue lesson.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
