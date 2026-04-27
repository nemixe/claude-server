import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
    resolveAskUserQuestionData,
} from "./chat-ui-utils";

/**
 * Compose a final answer string from per-step answers (chip selections or custom text).
 * Each step produces a line like "Header: Option1, Option2" or "Header: custom text".
 * Ends with "continue".
 */
const composeStepAnswers = (questions, answersByStep) => {
    const lines = [];
    for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        const answer = answersByStep[i];
        if (!answer) continue;

        const lineLabel =
            typeof q?.header === "string" && q.header.trim()
                ? q.header.trim()
                : typeof q?.question === "string" && q.question.trim()
                    ? q.question.trim()
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
};

const AskUserQuestionFooter = forwardRef(
    ({ questionData, questionMessageId, senderValue, onSelectionChange }, ref) => {
        const resolvedData = useMemo(
            () => resolveAskUserQuestionData(questionData),
            [questionData],
        );
        const normalizedQuestions = resolvedData?.questions ?? [];
        const questionCount = normalizedQuestions.length;

        const [stepIndex, setStepIndex] = useState(0);
        // Per-step: either string[] (chip selections) or string (custom text)
        const [answersByStep, setAnswersByStep] = useState(() =>
            normalizedQuestions.map(() => []),
        );
        // Track latest answers for imperative handle (avoids stale closure)
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
            [normalizedQuestions, stepHasAnswer],
        );

        const notifySelectionChange = useCallback(
            (nextAnswers) => {
                if (typeof onSelectionChange !== "function") return;
                onSelectionChange(getAllStepsAnswered(nextAnswers));
            },
            [getAllStepsAnswered, onSelectionChange],
        );

        useImperativeHandle(
            ref,
            () => ({
                /**
                 * Called when user presses Enter/Send with custom text (or empty for chip-only).
                 * - Stores the answer for the current step
                 * - If not on last step → advances and returns { advanced: true, ready: false }
                 * - If on last step → returns { advanced: false, ready: true }
                 * - If nothing to store → returns { advanced: false, ready: false }
                 */
                submitCurrentStep(customText) {
                    const current = answersRef.current;
                    const safeStep = Math.min(stepIndex, questionCount - 1);
                    const trimmed = typeof customText === "string" ? customText.trim() : "";
                    const chipAnswer = Array.isArray(current[safeStep]) ? current[safeStep] : [];
                    const hasCustom = trimmed.length > 0;
                    const hasChips = chipAnswer.length > 0;

                    if (!hasCustom && !hasChips) {
                        return { advanced: false, ready: false };
                    }

                    // Store the answer for this step
                    const next = current.map((a, i) => {
                        if (i !== safeStep) return a;
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

                    // Last step — check if all steps are answered
                    if (getAllStepsAnswered(next)) {
                        return { advanced: false, ready: true };
                    }
                    return { advanced: false, ready: false };
                },

                getComposedAnswer() {
                    const current = answersRef.current;
                    if (!getAllStepsAnswered(current)) return "";
                    return composeStepAnswers(normalizedQuestions, current);
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
                },
            }),
            [stepIndex, questionCount, normalizedQuestions, getAllStepsAnswered, notifySelectionChange],
        );

        if (questionCount === 0) return null;

        const safeStepIndex = Math.min(stepIndex, questionCount - 1);
        const currentQuestion = normalizedQuestions[safeStepIndex];
        const currentAnswer = answersByStep[safeStepIndex];
        const currentChipSelections = Array.isArray(currentAnswer) ? currentAnswer : [];
        const currentCustomText = typeof currentAnswer === "string" ? currentAnswer : "";
        const hasSenderText = typeof senderValue === "string" && senderValue.trim().length > 0;

        const handleChipClick = (label) => {
            setAnswersByStep((previous) => {
                const next = previous.map((a, i) => {
                    if (i !== safeStepIndex) return a;
                    // If there was a custom text answer, switch back to chip mode
                    const prev = Array.isArray(a) ? [...a] : [];
                    const idx = prev.indexOf(label);

                    if (currentQuestion?.multiSelect) {
                        if (idx === -1) prev.push(label);
                        else prev.splice(idx, 1);
                        return prev;
                    }
                    return idx === -1 ? [label] : [];
                });

                notifySelectionChange(next);
                return next;
            });
        };

        // Show a badge if a step already has an answer
        const answeredStepCount = answersByStep.filter((a) => stepHasAnswer(a)).length;

        return (
            <div className="ai-chat-footer-question">
                <div className="ai-chat-footer-question-header">
                    {questionCount > 1 ? (
                        <button
                            type="button"
                            className="ai-chat-footer-question-nav"
                            disabled={safeStepIndex === 0}
                            onClick={() => setStepIndex((p) => Math.max(0, p - 1))}
                            aria-label="Previous question"
                        >
                            <LeftOutlined />
                        </button>
                    ) : null}
                    {questionCount > 1 ? (
                        <span
                            className="ai-chat-footer-question-step"
                            aria-label={`Question ${safeStepIndex + 1} of ${questionCount}`}
                        >
                            {safeStepIndex + 1}/{questionCount}
                            {answeredStepCount > 0 ? (
                                <span className="ai-chat-footer-question-answered">
                                    {" "}&middot; {answeredStepCount} answered
                                </span>
                            ) : null}
                        </span>
                    ) : null}
                    {questionCount > 1 ? (
                        <button
                            type="button"
                            className="ai-chat-footer-question-nav"
                            disabled={safeStepIndex === questionCount - 1}
                            onClick={() => setStepIndex((p) => Math.min(questionCount - 1, p + 1))}
                            aria-label="Next question"
                        >
                            <RightOutlined />
                        </button>
                    ) : null}
                    <span className="ai-chat-footer-question-text">
                        {currentQuestion?.question}
                    </span>
                </div>
                <div
                    className="ai-chat-footer-question-chips"
                    role="group"
                    aria-label="Question options"
                >
                    {currentQuestion?.options?.map((option) => {
                        const isSelected = currentChipSelections.includes(option.label);
                        return (
                            <Tooltip key={option.label} title={option.description || undefined}>
                                <button
                                    type="button"
                                    className={[
                                        "ai-chat-footer-chip",
                                        isSelected ? "is-selected" : "",
                                        hasSenderText ? "is-dimmed" : "",
                                    ]
                                        .filter(Boolean)
                                        .join(" ")}
                                    onClick={() => handleChipClick(option.label)}
                                    aria-pressed={isSelected}
                                >
                                    {option.label}
                                </button>
                            </Tooltip>
                        );
                    })}
                    {currentCustomText ? (
                        <span className="ai-chat-footer-chip is-custom">
                            &ldquo;{currentCustomText}&rdquo;
                        </span>
                    ) : null}
                </div>
            </div>
        );
    },
);

AskUserQuestionFooter.displayName = "AskUserQuestionFooter";

export default AskUserQuestionFooter;
