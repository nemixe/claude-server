import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import { resolveAskUserQuestionData } from "./chat-ui-utils.js";

function composeStepAnswers(questions, answersByStep) {
  const lines = [];
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const answer = answersByStep[i];
    if (!answer) continue;

    const lineLabel =
      typeof question?.header === "string" && question.header.trim()
        ? question.header.trim()
        : typeof question?.question === "string" && question.question.trim()
          ? question.question.trim()
          : `Step ${i + 1}`;

    if (typeof answer === "string") {
      lines.push(`${lineLabel}: ${answer}`);
    } else if (Array.isArray(answer) && answer.length > 0) {
      lines.push(`${lineLabel}: ${answer.join(", ")}`);
    }
  }

  if (lines.length === 0) return "";
  lines.push("continue");
  return lines.join("\n").trim();
}

function composeToolResultContent(questions, answersByStep) {
  const answers = {};
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const answer = answersByStep[i];
    const questionText = typeof question?.question === "string" ? question.question.trim() : "";
    if (!questionText) continue;

    if (typeof answer === "string" && answer.trim()) {
      answers[questionText] = answer.trim();
    } else if (Array.isArray(answer) && answer.length > 0) {
      answers[questionText] = question?.multiSelect ? answer : answer[0];
    }
  }

  return JSON.stringify({
    questions,
    answers
  });
}

const AskUserQuestionFooter = forwardRef(
  ({ questionData, questionMessageId, senderValue, disabled, onSelectionChange }, ref) => {
    const resolvedData = useMemo(() => resolveAskUserQuestionData(questionData), [questionData]);
    const normalizedQuestions = resolvedData?.questions ?? [];
    const questionCount = normalizedQuestions.length;
    const [stepIndex, setStepIndex] = useState(0);
    const [answersByStep, setAnswersByStep] = useState(() => normalizedQuestions.map(() => []));
    const answersRef = useRef(answersByStep);
    answersRef.current = answersByStep;

    useEffect(() => {
      setStepIndex(0);
      const empty = normalizedQuestions.map(() => []);
      setAnswersByStep(empty);
      answersRef.current = empty;
    }, [questionMessageId]);

    const stepHasAnswer = useCallback((answer) => {
      if (typeof answer === "string") return answer.trim().length > 0;
      if (Array.isArray(answer)) return answer.length > 0;
      return false;
    }, []);

    const getAllStepsAnswered = useCallback(
      (answers) => normalizedQuestions.every((_, i) => stepHasAnswer(answers[i])),
      [normalizedQuestions, stepHasAnswer]
    );

    const notifySelectionChange = useCallback(
      (nextAnswers) => {
        if (typeof onSelectionChange !== "function") return;
        onSelectionChange(getAllStepsAnswered(nextAnswers));
      },
      [getAllStepsAnswered, onSelectionChange]
    );

    useImperativeHandle(
      ref,
      () => ({
        submitCurrentStep(customText) {
          if (disabled) return { advanced: false, ready: false };

          const current = answersRef.current;
          const safeStep = Math.min(stepIndex, questionCount - 1);
          const trimmed = typeof customText === "string" ? customText.trim() : "";
          const chipAnswer = Array.isArray(current[safeStep]) ? current[safeStep] : [];
          const hasCustom = trimmed.length > 0;
          const hasChips = chipAnswer.length > 0;

          if (!hasCustom && !hasChips) {
            return { advanced: false, ready: false };
          }

          const next = current.map((answer, index) => {
            if (index !== safeStep) return answer;
            return hasCustom ? trimmed : chipAnswer;
          });
          setAnswersByStep(next);
          answersRef.current = next;
          notifySelectionChange(next);

          const isLastStep = safeStep === questionCount - 1;
          if (!isLastStep) {
            setStepIndex(safeStep + 1);
            return { advanced: true, ready: false };
          }

          return { advanced: false, ready: getAllStepsAnswered(next) };
        },

        getComposedAnswer() {
          const current = answersRef.current;
          if (!getAllStepsAnswered(current)) return "";
          return composeStepAnswers(normalizedQuestions, current);
        },

        getComposedToolResultContent() {
          const current = answersRef.current;
          if (!getAllStepsAnswered(current)) return "";
          return composeToolResultContent(normalizedQuestions, current);
        },

        hasValidAnswer() {
          return getAllStepsAnswered(answersRef.current);
        },

        resetSelections() {
          setStepIndex(0);
          const empty = normalizedQuestions.map(() => []);
          setAnswersByStep(empty);
          answersRef.current = empty;
          notifySelectionChange(empty);
        }
      }),
      [disabled, stepIndex, questionCount, normalizedQuestions, getAllStepsAnswered, notifySelectionChange]
    );

    if (questionCount === 0) return null;

    const safeStepIndex = Math.min(stepIndex, questionCount - 1);
    const currentQuestion = normalizedQuestions[safeStepIndex];
    const currentAnswer = answersByStep[safeStepIndex];
    const currentChipSelections = Array.isArray(currentAnswer) ? currentAnswer : [];
    const currentCustomText = typeof currentAnswer === "string" ? currentAnswer : "";
    const hasSenderText = typeof senderValue === "string" && senderValue.trim().length > 0;
    const answeredStepCount = answersByStep.filter((answer) => stepHasAnswer(answer)).length;

    const handleChipClick = (label) => {
      if (disabled) return;

      setAnswersByStep((previous) => {
        const next = previous.map((answer, index) => {
          if (index !== safeStepIndex) return answer;
          const previousSelections = Array.isArray(answer) ? [...answer] : [];
          const selectedIndex = previousSelections.indexOf(label);

          if (currentQuestion?.multiSelect) {
            if (selectedIndex === -1) previousSelections.push(label);
            else previousSelections.splice(selectedIndex, 1);
            return previousSelections;
          }

          return selectedIndex === -1 ? [label] : [];
        });

        notifySelectionChange(next);
        return next;
      });
    };

    return (
      <div className="ai-chat-footer-question">
        <div className="ai-chat-footer-question-header">
          {questionCount > 1 ? (
            <button
              type="button"
              className="ai-chat-footer-question-nav"
              disabled={disabled || safeStepIndex === 0}
              onClick={() => setStepIndex((previous) => Math.max(0, previous - 1))}
              aria-label="Previous question"
            >
              <LeftOutlined />
            </button>
          ) : null}
          {questionCount > 1 ? (
            <span className="ai-chat-footer-question-step" aria-label={`Question ${safeStepIndex + 1} of ${questionCount}`}>
              {safeStepIndex + 1}/{questionCount}
              {answeredStepCount > 0 ? (
                <span className="ai-chat-footer-question-answered">
                  {" "}· {answeredStepCount} answered
                </span>
              ) : null}
            </span>
          ) : null}
          {questionCount > 1 ? (
            <button
              type="button"
              className="ai-chat-footer-question-nav"
              disabled={disabled || safeStepIndex === questionCount - 1}
              onClick={() => setStepIndex((previous) => Math.min(questionCount - 1, previous + 1))}
              aria-label="Next question"
            >
              <RightOutlined />
            </button>
          ) : null}
          <span className="ai-chat-footer-question-text">{currentQuestion?.question}</span>
        </div>
        <div className="ai-chat-footer-question-chips" role="group" aria-label="Question options">
          {currentQuestion?.options?.map((option) => {
            const isSelected = currentChipSelections.includes(option.label);
            return (
              <Tooltip
                key={option.label}
                title={option.description || undefined}
                classNames={{ root: "ai-chat-footer-chip-tooltip" }}
                mouseLeaveDelay={0}
                destroyOnHidden
              >
                <button
                  type="button"
                  className={[
                    "ai-chat-footer-chip",
                    isSelected ? "is-selected" : "",
                    hasSenderText ? "is-dimmed" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => handleChipClick(option.label)}
                  disabled={disabled}
                  aria-pressed={isSelected}
                >
                  {option.label}
                </button>
              </Tooltip>
            );
          })}
          {currentCustomText ? (
            <span className="ai-chat-footer-chip is-custom">"{currentCustomText}"</span>
          ) : null}
        </div>
      </div>
    );
  }
);

AskUserQuestionFooter.displayName = "AskUserQuestionFooter";

export default AskUserQuestionFooter;
