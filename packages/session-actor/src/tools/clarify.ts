/**
 * The clarify tool. It asks the user and then waits.
 *
 * Upstream blocks the turn until the user answers. The port cannot hold a
 * thread, so it writes a `clarify_question` row, sends the question to the
 * user and ends the turn. The next input of the user is the answer: it
 * completes the tool call and the loop goes on. The wait is a row, so it
 * survives a restart and a code update (guide 7.4, upgrade tests).
 */

export interface ClarifyQuestion {
  question: string;
  choices?: string[];
  multi_select?: boolean;
}

export function parseClarify(args: unknown): ClarifyQuestion[] | string {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const raw = a.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 5) return "questions must be an array of 1 to 5 entries";
  const out: ClarifyQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null || typeof (q as { question?: unknown }).question !== "string") {
      return "each question needs a `question` string";
    }
    const o = q as { question: string; choices?: unknown; multi_select?: unknown };
    const item: ClarifyQuestion = { question: o.question };
    if (o.choices !== undefined) {
      if (!Array.isArray(o.choices) || o.choices.length > 4 || o.choices.some((c) => typeof c !== "string")) {
        return "choices must be an array of at most 4 strings";
      }
      item.choices = o.choices as string[];
    }
    if (o.multi_select === true) item.multi_select = true;
    out.push(item);
  }
  return out;
}

/** The text that the user sees. */
export function renderQuestions(questions: ClarifyQuestion[]): string {
  return questions
    .map((q, i) => {
      const head = questions.length > 1 ? `${i + 1}. ${q.question}` : q.question;
      const choices = (q.choices ?? []).map((c, j) => `  ${j + 1}) ${c}`);
      return [head, ...choices].join("\n");
    })
    .join("\n");
}

/**
 * Turn the user's text into the tool result. One line per question when the
 * number of lines matches the number of questions. Otherwise the whole text
 * answers the first question and the others stay unanswered.
 */
export function answerResult(questions: ClarifyQuestion[], text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const perQuestion = questions.length > 1 && lines.length === questions.length;
  const responses = questions.map((q, i) => {
    const answer = perQuestion ? lines[i] : i === 0 ? text.trim() : undefined;
    return answer === undefined || answer === ""
      ? { question: q.question, status: "unanswered", user_response: null }
      : { question: q.question, status: "answered", user_response: answer };
  });
  return JSON.stringify({ responses, outcome: "submitted" });
}
