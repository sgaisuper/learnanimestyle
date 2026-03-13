import type { LessonBeat, StudyPlanResponse } from "@/lib/types";

function normalizeBeat(beat: LessonBeat, index: number): LessonBeat {
  return {
    index,
    title: beat.title?.trim() || `Lesson beat ${index + 1}`,
    focus: beat.focus?.trim() || "Explain this section of the paper clearly.",
    estimatedSeconds:
      Number.isFinite(beat.estimatedSeconds) && beat.estimatedSeconds > 0
        ? Math.round(beat.estimatedSeconds)
        : 75,
  };
}

export function normalizeStudyPlan(studyPlan: StudyPlanResponse): StudyPlanResponse {
  const beats = studyPlan.beats.map(normalizeBeat);

  return {
    paperTitle: studyPlan.paperTitle?.trim() || "Untitled paper",
    paperSummary:
      studyPlan.paperSummary?.trim() || "Airi will explain the paper step by step.",
    beats,
  };
}
