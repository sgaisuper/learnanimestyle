import { NextResponse } from "next/server";
import { uploadPdf, createJsonResponse } from "@/lib/openai";
import {
  buildOpeningLine,
  studyPlanInstructions,
  studyPlanSchema,
} from "@/lib/prompts";
import { normalizeStudyPlan } from "@/lib/session";
import type { SessionPayload, StudyPlanResponse, TranscriptEntry } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const pdf = formData.get("pdf");
    const durationMinutes = Number(formData.get("durationMinutes") ?? 8);

    if (!(pdf instanceof File)) {
      return NextResponse.json({ error: "PDF upload is required." }, { status: 400 });
    }

    const uploadedFile = await uploadPdf(pdf);
    const rawStudyPlan = await createJsonResponse<StudyPlanResponse>({
      instructions: studyPlanInstructions(durationMinutes),
      schemaName: "study_plan",
      schema: studyPlanSchema,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Create a guided lesson from this paper that lasts around ${durationMinutes} minutes.`,
            },
            {
              type: "input_file",
              file_id: uploadedFile.id,
            },
          ],
        },
      ],
    });

    const studyPlan = normalizeStudyPlan(rawStudyPlan);

    const openingLine: TranscriptEntry = {
      id: crypto.randomUUID(),
      speaker: "airi",
      kind: "lesson",
      text: buildOpeningLine(studyPlan),
    };

    const session: SessionPayload = {
      fileId: uploadedFile.id,
      studyPlan,
      nextBeatIndex: 0,
      transcript: [openingLine],
    };

    return NextResponse.json(session);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to build study plan.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
