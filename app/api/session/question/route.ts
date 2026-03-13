import { NextResponse } from "next/server";
import { createJsonResponse } from "@/lib/openai";
import { answerQuestionInstructions, answerQuestionSchema } from "@/lib/prompts";
import type { AnswerQuestionResponse, SessionPayload, TranscriptEntry } from "@/lib/types";

type QuestionRequest = SessionPayload & {
  latestQuestion: string;
};

export async function POST(request: Request) {
  try {
    const session = (await request.json()) as QuestionRequest;

    const response = await createJsonResponse<AnswerQuestionResponse>({
      instructions: answerQuestionInstructions(
        session.studyPlan,
        session.transcript,
        session.latestQuestion,
      ),
      schemaName: "answer_question",
      schema: answerQuestionSchema,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Answer this student question about the paper: ${session.latestQuestion}`,
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
      kind: "answer",
      text: response.answer,
    };

    return NextResponse.json({
      ...session,
      transcript: [...session.transcript, airiEntry],
    } satisfies SessionPayload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to answer question.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
