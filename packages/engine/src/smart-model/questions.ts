// 问题和回答的校验。输入不合法时抛 SmartModelInputError，不调用任何后端。
// 后端的回答一律不信：每个回答都要对上问题的类型、选项和取值范围，否则抛 SmartModelBackendError。
import {
  SmartModelBackendError,
  SmartModelInputError,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type ScoreAnswer,
  type ScoreQuestion,
  type SmartAnswer,
  type SmartAnswers,
  type SmartQuestion,
  type SmartQuestionSet,
  type YesNoAnswer,
} from "./types.js";

export const SMART_MODEL_LIMITS = {
  maxStateChars: 32_000,
  maxQuestions: 16,
  maxPromptChars: 2_000,
  minOptions: 2,
  maxOptions: 255,
  maxOptionChars: 200,
  maxDescriptionChars: 1_000,
  minLevels: 2,
  maxLevels: 10,
  maxLevelChars: 500,
} as const;

// 问题名同时是 JSON 的键。限制成标识符，避开 __proto__ 这类特殊键。
const QUESTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// 概率之和允许的误差。后端返回的是四舍五入以后的小数。
const PROBABILITY_SUM_TOLERANCE = 0.02;

function fail(message: string): never {
  throw new SmartModelInputError(message);
}

function checkText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) fail(`${what} must be a non-empty string`);
  if (value.length > max) fail(`${what} is longer than ${max} characters`);
  return value;
}

function checkChoice(name: string, question: ChoiceQuestion): void {
  const limits = SMART_MODEL_LIMITS;
  if (!Array.isArray(question.options)) fail(`${name}: options must be an array`);
  const count = question.options.length;
  if (count < limits.minOptions || count > limits.maxOptions) {
    fail(`${name}: a choice needs ${limits.minOptions} to ${limits.maxOptions} options, got ${count}`);
  }
  const seen = new Set<string>();
  for (const option of question.options) {
    checkText(option, `${name}: option`, limits.maxOptionChars);
    if (option !== option.trim()) fail(`${name}: option ${JSON.stringify(option)} has surrounding spaces`);
    if (seen.has(option)) fail(`${name}: option ${JSON.stringify(option)} is repeated`);
    seen.add(option);
  }
  for (const [option, description] of Object.entries(question.descriptions ?? {})) {
    if (!seen.has(option)) fail(`${name}: description for unknown option ${JSON.stringify(option)}`);
    checkText(description, `${name}: description of ${option}`, limits.maxDescriptionChars);
  }
}

function checkScore(name: string, question: ScoreQuestion): void {
  const limits = SMART_MODEL_LIMITS;
  if (!Array.isArray(question.levels)) fail(`${name}: levels must be an array`);
  const count = question.levels.length;
  if (count < limits.minLevels || count > limits.maxLevels) {
    fail(`${name}: a score needs ${limits.minLevels} to ${limits.maxLevels} levels, got ${count}`);
  }
  for (const level of question.levels) checkText(level, `${name}: level`, limits.maxLevelChars);
}

/** 检查一次调用的输入。不合法时抛 SmartModelInputError。 */
export function validateSmartInput(state: unknown, questions: unknown): asserts questions is SmartQuestionSet {
  const limits = SMART_MODEL_LIMITS;
  checkText(state, "state", limits.maxStateChars);
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) fail("questions must be an object");
  const entries = Object.entries(questions as Record<string, unknown>);
  if (entries.length === 0) fail("at least one question is required");
  if (entries.length > limits.maxQuestions) fail(`at most ${limits.maxQuestions} questions per call`);
  for (const [name, raw] of entries) {
    if (!QUESTION_NAME.test(name)) fail(`question name ${JSON.stringify(name)} must be an identifier`);
    if (!raw || typeof raw !== "object") fail(`${name}: question must be an object`);
    const question = raw as SmartQuestion;
    checkText(question.prompt, `${name}: prompt`, limits.maxPromptChars);
    if (question.type === "choice") checkChoice(name, question);
    else if (question.type === "score") checkScore(name, question);
    else if (question.type === "yes_no") {
      // Jev 的 criteria 要同时给 true 和 false 两条说明，所以这里也要求两条一起给。
      if ((question.yes === undefined) !== (question.no === undefined)) fail(`${name}: give both yes and no, or neither`);
      if (question.yes !== undefined) checkText(question.yes, `${name}: yes`, limits.maxDescriptionChars);
      if (question.no !== undefined) checkText(question.no, `${name}: no`, limits.maxDescriptionChars);
    } else {
      fail(`${name}: unknown question type ${JSON.stringify((question as { type?: unknown }).type)}`);
    }
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sumsToOne(values: number[]): boolean {
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE;
}

function checkChoiceAnswer(name: string, question: ChoiceQuestion, answer: ChoiceAnswer): string | null {
  // 不回显后端给的值：它可能抄了 state 的原文，而错误会进决策日志。
  if (!question.options.includes(answer.choice)) return `${name}: choice is not one of the options`;
  if (!isProbability(answer.confidence)) return `${name}: confidence is not in [0, 1]`;
  const keys = Object.keys(answer.probabilities ?? {});
  if (keys.length !== question.options.length || !question.options.every((option) => Object.hasOwn(answer.probabilities, option))) {
    return `${name}: probabilities do not cover exactly the options`;
  }
  const values = question.options.map((option) => answer.probabilities[option]);
  if (!values.every(isProbability) || !sumsToOne(values as number[])) return `${name}: probabilities are not a distribution`;
  return null;
}

function checkScoreAnswer(name: string, question: ScoreQuestion, answer: ScoreAnswer): string | null {
  const count = question.levels.length;
  if (!Number.isInteger(answer.level) || answer.level < 0 || answer.level >= count) return `${name}: level is out of range`;
  if (answer.label !== question.levels[answer.level]) return `${name}: label does not match the level`;
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > count - 1) {
    return `${name}: score is out of range`;
  }
  if (!isProbability(answer.confidence)) return `${name}: confidence is not in [0, 1]`;
  if (!Array.isArray(answer.probabilities) || answer.probabilities.length !== count) {
    return `${name}: probabilities do not cover exactly the levels`;
  }
  if (!answer.probabilities.every(isProbability) || !sumsToOne(answer.probabilities)) {
    return `${name}: probabilities are not a distribution`;
  }
  return null;
}

function checkYesNoAnswer(name: string, answer: YesNoAnswer): string | null {
  return isProbability(answer.probability) ? null : `${name}: probability is not in [0, 1]`;
}

/**
 * 检查后端交回的回答：每个问题都有回答，类型对得上，取值在范围内。不合法时抛 SmartModelBackendError，
 * 调用方可以换后端。合法时只保留问题里有的键。
 */
export function validateSmartAnswers<Q extends SmartQuestionSet>(
  backend: string,
  questions: Q,
  answers: Record<string, SmartAnswer | undefined>,
): SmartAnswers<Q> {
  const out: Record<string, SmartAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(answers, name) ? answers[name] : undefined;
    let problem: string | null;
    if (!answer || typeof answer !== "object") problem = `${name}: no answer`;
    else if (answer.type !== question.type) problem = `${name}: answer type does not match ${question.type}`;
    else if (question.type === "choice") problem = checkChoiceAnswer(name, question, answer as ChoiceAnswer);
    else if (question.type === "score") problem = checkScoreAnswer(name, question, answer as ScoreAnswer);
    else problem = checkYesNoAnswer(name, answer as YesNoAnswer);
    if (problem) throw new SmartModelBackendError(backend, `${backend}: invalid answer: ${problem}`, "invalid_answer");
    out[name] = answer!;
  }
  return out as SmartAnswers<Q>;
}

/** 选择题的置信度：(p_max − 1/n) / (1 − 1/n)。TypeSafe 文档的定义。 */
export function choiceConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n < 2) return 1;
  const top = Math.max(...probabilities);
  return Math.min(1, Math.max(0, (top - 1 / n) / (1 - 1 / n)));
}

/** 最可能的下标。并列时取最前面的一个。 */
export function argmax(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! > values[best]!) best = index;
  }
  return best;
}
