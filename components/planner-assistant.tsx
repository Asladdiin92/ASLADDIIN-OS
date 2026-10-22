"use client";

import { CalendarDays, Check, Clock3, LoaderCircle, Scissors, Send, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  BreakdownPlan,
  DatabaseDraftPlan,
  DayPlan,
  PlannerPlan,
  PlannerChange,
  ResearchSource,
  ScheduleBlock,
} from "@/lib/gemini";
import type { Task, TaskOptions } from "@/lib/types";
import { apiErrorMessage, readApiResponse } from "@/lib/api-response";
import {
  formatPlannerDate,
  plannerLocalTimeToIso,
  PLANNER_TIME_ZONE,
  todayInPlannerTimeZone,
} from "@/lib/planner-datetime";

type AssistantResponse = {
  answer?: string;
  plan?: PlannerPlan | BreakdownPlan | DayPlan | DatabaseDraftPlan;
  sources?: ResearchSource[];
  error?: string;
};
type TaskMutationResponse = { ok: boolean; task?: Task; error?: string };
type ChangeField = keyof PlannerChange["fields"];
type AssistantMode = "suggest" | "ask" | "plan" | "breakdown" | "day" | "insights" | "research" | "writing" | "translate" | "analyze" | "autofill" | "secretary";
type PlannedTask = {
  title: string;
  area?: string;
  priority?: string;
  type?: string;
  status?: string;
  course?: string;
  nextAction?: string;
  dueDate?: string;
  courseCode?: string;
  estimatedHours?: number;
  assessment?: string;
  recurrence?: string;
  notes?: string;
  deliverable?: boolean;
  minutes?: number;
  checked: boolean;
};

const quickActions = [
  { id: "day", label: "Plan my day", icon: CalendarDays },
  { id: "breakdown", label: "Break down a task", icon: Scissors },
  { id: "urgent", label: "Urgent focus", icon: Clock3 },
  { id: "motivation", label: "Quick motivation", icon: Sparkles },
] as const;

function InlineMarkdown({ text }: { text: string }) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
}

function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="assistant-markdown">
      {text.split("\n").map((line, index) => {
        const trimmed = line.trim();
        const checkbox = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
        if (checkbox) return <div className="assistant-markdown-check" key={index}><input type="checkbox" checked={checkbox[1].toLowerCase() === "x"} readOnly /><span><InlineMarkdown text={checkbox[2]} /></span></div>;
        const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
        if (heading) return <h3 key={index}><InlineMarkdown text={heading[1]} /></h3>;
        const bullet = trimmed.match(/^[-*]\s+(.+)$/);
        if (bullet) return <div className="assistant-markdown-bullet" key={index}><span>•</span><span><InlineMarkdown text={bullet[1]} /></span></div>;
        const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
        if (numbered) return <div className="assistant-markdown-bullet" key={index}><span>{trimmed.match(/^\d+/)?.[0]}.</span><span><InlineMarkdown text={numbered[1]} /></span></div>;
        return trimmed ? <p key={index}><InlineMarkdown text={trimmed} /></p> : <div className="assistant-markdown-gap" key={index} />;
      })}
    </div>
  );
}

function minutesToTime(value: string, minutes: number): string {
  const total = (Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const fieldLabels: Record<ChangeField, string> = {
  title: "Title",
  type: "Type",
  status: "Status",
  priority: "Priority",
  area: "Area",
  course: "Course",
  dueDate: "Due date",
  nextAction: "Next action",
  recurrence: "Recurrence",
};

export function PlannerAssistant({
  disabled,
  tasks,
  options,
  googleConnected,
  taskToBreakDown,
  onBreakdownHandled,
  onTaskSaved,
  startDayPlan,
  onDayPlanStarted,
}: {
  disabled: boolean;
  tasks: Task[];
  options: TaskOptions | null;
  googleConnected: boolean;
  taskToBreakDown: Task | null;
  onBreakdownHandled: () => void;
  onTaskSaved: (task: Task) => void;
  startDayPlan: boolean;
  onDayPlanStarted: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [memorySaved, setMemorySaved] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [error, setError] = useState("");
  const [pendingChange, setPendingChange] = useState<PlannerChange | null>(null);
  const [breakdown, setBreakdown] = useState<BreakdownPlan | null>(null);
  const [dayPlan, setDayPlan] = useState<DayPlan | null>(null);
  const [databaseDraft, setDatabaseDraft] = useState<DatabaseDraftPlan | null>(null);
  const [plannedTasks, setPlannedTasks] = useState<PlannedTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AssistantMode>("plan");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [targetLanguage, setTargetLanguage] = useState("Afaan Oromo");
  const [sourceLanguage, setSourceLanguage] = useState("");
  const [planningDate, setPlanningDate] = useState(todayInPlannerTimeZone());
  const [availableHours, setAvailableHours] = useState(6);
  const [studyStart, setStudyStart] = useState("08:30");
  const [studyEnd, setStudyEnd] = useState("18:00");
  const [selectedAreas, setSelectedAreas] = useState<string[]>([]);
  const [selectedCourses, setSelectedCourses] = useState<string[]>([]);
  const [energyLevel, setEnergyLevel] = useState<"low" | "medium" | "high">("medium");
  const [planningInstructions, setPlanningInstructions] = useState("");

  const ask = useCallback(async (mode: AssistantMode, prompt = question, taskId?: string) => {
    setLoading(true);
    setError("");
    setAnswer("");
    setSources([]);
    setMemorySaved(false);
    setPendingChange(null);
    setBreakdown(null);
    setDayPlan(null);
    setDatabaseDraft(null);
    setPlannedTasks([]);
    // Clear stale file reference when switching to a mode that doesn't use uploads,
    // so a previously selected file never silently persists into a new request.
    if (mode !== "analyze" && mode !== "autofill") {
      setSelectedFile(null);
    }
    try {
      const timezone = PLANNER_TIME_ZONE;
      const date = mode === "day" ? planningDate : todayInPlannerTimeZone();
      const useUpload = (mode === "analyze" || mode === "autofill") && Boolean(selectedFile);
      const body: BodyInit = useUpload
        ? (() => {
            const form = new FormData();
            form.set("mode", mode);
            form.set("question", prompt);
            form.set("file", selectedFile!);
            return form;
          })()
        : JSON.stringify(mode === "secretary" ? { question: prompt } : {
            mode,
            question: prompt,
            ...(mode === "translate" ? { language: targetLanguage, sourceLanguage } : {}),
            ...(taskId ? { taskId } : {}),
            ...(mode === "day" || mode === "plan" ? { date, timezone } : {}),
            ...(mode === "day" ? {
              planning: {
                availableHours,
                studyStart,
                studyEnd,
                selectedAreas,
                selectedCourses,
                energyLevel,
                instructions: planningInstructions,
              },
            } : {}),
          });
      const response = await fetch(mode === "secretary" ? "/api/google/assistant" : "/api/assistant", {
        method: "POST",
        ...(!useUpload ? { headers: { "Content-Type": "application/json" } } : {}),
        body,
      });
      const result = await readApiResponse<AssistantResponse>(response);
      if (!response.ok) throw new Error(result.error ?? "The planner assistant could not respond.");
      if (mode === "research") {
        if (!result.answer) throw new Error("The research assistant returned no answer.");
        setAnswer(result.answer);
        setSources(result.sources ?? []);
      } else if (mode === "plan" || mode === "breakdown" || mode === "day" || mode === "autofill") {
        const plan = result.plan;
        if (!plan) throw new Error(result.error ?? "The planner assistant returned no proposal.");
        if (plan.action === "answer") {
          setAnswer(plan.answer);
        } else if (plan.action === "bulk_create") {
          setDatabaseDraft(plan);
          setPlannedTasks(plan.items.map((item) => ({ ...item, checked: true })));
        } else if (plan.action === "create" || plan.action === "update" || plan.action === "bulk_update") {
          setPendingChange(plan);
        } else if (plan.action === "breakdown") {
          setBreakdown(plan);
          const sourceTask = tasks.find((task) => task.id === plan.taskId);
          setPlannedTasks(plan.steps.map((step) => ({
            title: `${sourceTask?.title ?? "Task"} — ${step.title}`,
            area: sourceTask?.area,
            priority: sourceTask?.priority,
            type: sourceTask?.type,
            status: sourceTask?.status,
            course: sourceTask?.course,
            nextAction: step.nextAction,
            dueDate: sourceTask?.dueDate ?? undefined,
            minutes: step.minutes,
            checked: true,
          })));
        } else if (plan.action === "day_plan") {
          setDayPlan(plan);
          setPlannedTasks(plan.blocks.map((block) => scheduleTask(block, plan, tasks, options)));
        } else {
          throw new Error("The planner assistant returned an unsupported response.");
        }
      } else {
        if (!result.answer) throw new Error(result.error ?? "The planner assistant returned no answer.");
        setAnswer(result.answer);
      }
    } catch (requestError) {
      setError(apiErrorMessage(requestError, "The planner assistant could not respond."));
    } finally {
      setLoading(false);
    }
  }, [availableHours, energyLevel, options, planningDate, planningInstructions, question, selectedAreas, selectedCourses, selectedFile, sourceLanguage, studyEnd, studyStart, targetLanguage, tasks]);

  async function saveAnswerToMemory() {
    if (!answer || memorySaving || memorySaved ||
        (assistantMode !== "research" && assistantMode !== "analyze")) return;
    const memoryType = assistantMode === "research" ? "research_note" : "file_excerpt";
    const title = assistantMode === "research" ? question.trim() : selectedFile?.name;
    if (!title) {
      setError("The source title is unavailable, so this result cannot be saved.");
      return;
    }

    setMemorySaving(true);
    setError("");
    try {
      const memoryContent = assistantMode === "research" && sources.length > 0
        ? `${answer}\n\nSources:\n${sources.map((source, index) =>
            `[${index + 1}] ${source.title}\n${source.url}${source.snippet ? `\n${source.snippet}` : ""}`,
          ).join("\n\n")}`
        : answer;
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "save_memory",
          memoryType,
          title: title.slice(0, 200),
          content: memoryContent.slice(0, 20_000),
          metadata: {
            question: question.slice(0, 1_000),
            ...(assistantMode === "research" ? { source: "tavily" } : { fileName: title.slice(0, 250) }),
          },
        }),
      });
      const result = await readApiResponse<{ saved?: boolean; error?: string }>(response);
      if (!response.ok || !result.saved) {
        throw new Error(result.error ?? "AI memory could not be saved.");
      }
      setMemorySaved(true);
    } catch (saveError) {
      setError(apiErrorMessage(saveError, "AI memory could not be saved."));
    } finally {
      setMemorySaving(false);
    }
  }

  function submitInstruction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (assistantMode === "analyze" && !selectedFile) {
      setError("Choose a file to analyze.");
      return;
    }
    void ask(assistantMode);
  }

  function runQuickAction(action: typeof quickActions[number]["id"]) {
    if (action === "day") {
      setAssistantMode("day");
      void ask("day");
    } else if (action === "breakdown") {
      setAssistantMode("breakdown");
      void ask("breakdown", "Choose the hardest pending University or Coding Lab task and split it into 3–4 practical steps.");
    } else if (action === "urgent") {
      setAssistantMode("ask");
      void ask("ask", "What are the top two things in my planner that could cause problems if I don't finish them in the next three hours? Be concise and tell me the next physical action for each.");
    } else {
      setAssistantMode("ask");
      void ask("ask", "Give me one high-impact, encouraging sentence and tell me which specific task to start right now.");
    }
  }

  useEffect(() => {
    if (!startDayPlan || disabled || loading) return;
    if (pendingChange || plannedTasks.length > 0) {
      setError("Review or save the current assistant proposal before creating a day plan.");
      onDayPlanStarted();
      return;
    }
    setAssistantMode("day");
    void ask("day");
    onDayPlanStarted();
  }, [ask, disabled, loading, onDayPlanStarted, pendingChange, plannedTasks.length, startDayPlan]);

  function scheduleTask(block: ScheduleBlock, plan: DayPlan, allTasks: Task[], taskOptions: TaskOptions | null): PlannedTask {
    const linkedTask = allTasks.find((task) => task.id === block.taskId);
    // Return the value only if it exists in the available options list.
    // Never silently fall back to available[0] — that would tag the task
    // with a random Notion option the user didn't choose.
    const safeChoice = (existing: string | undefined, available: string[], preferred: string): string | undefined => {
      if (existing && available.includes(existing)) return existing;
      if (available.includes(preferred)) return preferred;
      return undefined; // leave unset rather than picking a wrong default
    };
    return {
      title: `${block.startTime}–${block.endTime} · ${block.title}`,
      area: taskOptions?.areas.includes(block.area) ? block.area : linkedTask?.area || undefined,
      priority: linkedTask?.priority || undefined,
      type: safeChoice(linkedTask?.type, taskOptions?.types ?? [], "Task"),
      status: safeChoice(linkedTask?.status, taskOptions?.statuses ?? [], "Planned"),
      course: linkedTask?.course || undefined,
      nextAction: `Scheduled ${block.startTime}–${block.endTime} (${plan.timezone}). ${block.nextAction}`,
      dueDate: plannerLocalTimeToIso(plan.date, block.startTime),
      checked: true,
    };
  }

  function updatePlannedTask(index: number, checked: boolean) {
    setPlannedTasks((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, checked } : item,
    ));
  }

  /**
   * Converts a planner-timezone "YYYY-MM-DDTHH:mm" string to a proper ISO timestamp.
   * Date-only strings (YYYY-MM-DD) and undefined/null are passed through unchanged.
   * Extracted here to avoid the identical regex+conversion being duplicated in
   * confirmChange (single), confirmChange (bulk_update), and saveSelectedTasks.
   */
  function toIsoDate(value: string | null | undefined): string | null | undefined {
    if (!value) return value;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      return plannerLocalTimeToIso(value.slice(0, 10), value.slice(11, 16));
    }
    return value;
  }

  useEffect(() => {
    if (!taskToBreakDown) return;
    void ask("breakdown", `Break this task into 3–4 practical steps: ${taskToBreakDown.title}`, taskToBreakDown.id);
    onBreakdownHandled();
  }, [ask, taskToBreakDown, onBreakdownHandled]);

  async function confirmChange() {
    if (!pendingChange || loading) return;
    const task = pendingChange.action === "update"
      ? tasks.find((item) => item.id === pendingChange.taskId)
      : undefined;
    if (pendingChange.action === "update" && !task) {
      setError("That task is no longer in the current planner list. Refresh and try again.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const fields = pendingChange.fields;
      if (pendingChange.action === "bulk_update") {
        const targets = pendingChange.taskIds.map((id) => tasks.find((item) => item.id === id));
        if (targets.some((item) => !item)) {
          throw new Error("One or more tasks are no longer in the current planner list. Refresh and try again.");
        }
        let saved = 0;
        for (const target of targets) {
          const targetTask = target!;
          const dueDate = toIsoDate(fields.dueDate);
          const response = await fetch(`/api/tasks/${encodeURIComponent(targetTask.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: fields.title ?? targetTask.title,
              type: fields.type ?? targetTask.type,
              status: fields.status ?? targetTask.status,
              priority: fields.priority ?? targetTask.priority,
              area: fields.area ?? targetTask.area,
              course: fields.course ?? targetTask.course,
              dueDate: dueDate ?? targetTask.dueDate ?? "",
              dateEnd: targetTask.dateEnd ?? "",
              nextAction: fields.nextAction ?? targetTask.nextAction,
              ...(fields.recurrence !== undefined ? { recurrence: fields.recurrence } : {}),
            }),
          });
          const result = await readApiResponse<TaskMutationResponse>(response);
          if (!response.ok || !result.ok || !result.task) {
            throw new Error(`Updated ${saved} of ${targets.length} tasks before an error: ${result.error ?? "Could not update the next task."}`);
          }
          onTaskSaved(result.task);
          saved += 1;
        }
        setPendingChange(null);
        setQuestion("");
        setAnswer(`Updated ${saved} tasks in your Notion planner.`);
        return;
      }
      const dueDate = toIsoDate(fields.dueDate);
      const body = pendingChange.action === "create"
        ? { ...fields, dueDate }
        : {
            title: fields.title ?? task!.title,
            type: fields.type ?? task!.type,
            status: fields.status ?? task!.status,
            priority: fields.priority ?? task!.priority,
            area: fields.area ?? task!.area,
            course: fields.course ?? task!.course,
            dueDate: dueDate ?? task!.dueDate ?? "",
            dateEnd: task!.dateEnd ?? "",
            nextAction: fields.nextAction ?? task!.nextAction,
            ...(fields.recurrence !== undefined ? { recurrence: fields.recurrence } : {}),
          };
      const response = await fetch(
        pendingChange.action === "create" ? "/api/tasks" : `/api/tasks/${encodeURIComponent(task!.id)}`,
        {
          method: pendingChange.action === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = await readApiResponse<TaskMutationResponse>(response);
      if (!response.ok || !result.ok || !result.task) {
        throw new Error(result.error ?? "Could not save the planner change.");
      }
      onTaskSaved(result.task);
      setPendingChange(null);
      setQuestion("");
      setAnswer(pendingChange.action === "create"
        ? `Created “${result.task.title}” in your Notion planner.`
        : `Updated “${result.task.title}” in your Notion planner.`);
    } catch (saveError) {
      setError(apiErrorMessage(saveError, "Could not save the planner change."));
    } finally {
      setLoading(false);
    }
  }

  async function saveSelectedTasks() {
    const selected = plannedTasks.flatMap((item, index) => item.checked ? [{ ...item, index }] : []);
    if (!selected.length || loading) return;
    setLoading(true);
    setError("");
    let saved = 0;
    try {
      for (const item of selected) {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: item.title,
            type: item.type,
            status: item.status,
            priority: item.priority,
            area: item.area,
            course: item.course,
            dueDate: toIsoDate(item.dueDate),
            nextAction: item.nextAction,
            courseCode: item.courseCode,
            estimatedHours: item.estimatedHours,
            assessment: item.assessment,
            recurrence: item.recurrence,
            notes: item.notes,
            deliverable: item.deliverable,
          }),
        });
        const result = await readApiResponse<TaskMutationResponse>(response);
        if (!response.ok || !result.ok || !result.task) {
          throw new Error(`Saved ${saved} of ${selected.length} tasks before an error: ${result.error ?? "Could not save the next task."}`);
        }
        onTaskSaved(result.task);
        saved += 1;
        setPlannedTasks((current) => current.map((entry, index) => index === item.index ? { ...entry, checked: false } : entry));
      }
      setAnswer(`Added ${saved} task${saved === 1 ? "" : "s"} to your Notion planner.`);
      setBreakdown(null);
      setDayPlan(null);
      setDatabaseDraft(null);
      setPlannedTasks([]);
    } catch (saveError) {
      setError(apiErrorMessage(saveError, "Could not save the selected tasks."));
    } finally {
      setLoading(false);
    }
  }

  const pendingTask = pendingChange?.action === "update"
    ? tasks.find((task) => task.id === pendingChange.taskId)
    : undefined;
  const pendingTasks = pendingChange?.action === "bulk_update"
    ? pendingChange.taskIds.flatMap((id) => {
        const task = tasks.find((item) => item.id === id);
        return task ? [task] : [];
      })
    : [];
  const modeDisabled = (disabled && ["plan", "insights", "autofill", "secretary"].includes(assistantMode)) ||
    (assistantMode === "secretary" && !googleConnected);

  return (
    <section className="panel assistant-panel" id="planner-assistant" aria-labelledby="assistant-title">
      <div className="panel-heading">
        <div>
          <h2 id="assistant-title">Planner assistant</h2>
          <p>Research, write, translate, analyze files, and work with your planner.</p>
        </div>
        <span className="chart-heading-icon tone-violet"><Sparkles size={15} /></span>
      </div>
      <details className="assistant-planning-preferences">
        <summary>Daily planning preferences</summary>
        <div className="assistant-planning-grid">
          <label><span>Planning date</span><input type="date" value={planningDate} onChange={(event) => setPlanningDate(event.target.value)} /></label>
          <label><span>Available work hours</span><input type="number" min="0.5" max="12" step="0.5" value={availableHours} onChange={(event) => setAvailableHours(Number(event.target.value))} /></label>
          <label><span>Study window starts</span><input type="time" min="08:30" max="17:45" value={studyStart} onChange={(event) => setStudyStart(event.target.value)} /></label>
          <label><span>Study window ends</span><input type="time" min="08:45" max="18:00" value={studyEnd} onChange={(event) => setStudyEnd(event.target.value)} /></label>
          <label><span>Energy level</span><select value={energyLevel} onChange={(event) => setEnergyLevel(event.target.value as "low" | "medium" | "high")}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <label><span>Areas (optional)</span><select multiple value={selectedAreas} onChange={(event) => setSelectedAreas(Array.from(event.target.selectedOptions, (option) => option.value))}>{(options?.areas ?? []).map((area) => <option value={area} key={area}>{area}</option>)}</select></label>
          <label><span>Courses (optional)</span><select multiple value={selectedCourses} onChange={(event) => setSelectedCourses(Array.from(event.target.selectedOptions, (option) => option.value))}>{(options?.courses ?? []).map((course) => <option value={course} key={course}>{course}</option>)}</select></label>
          <label className="assistant-planning-instructions"><span>Additional instructions</span><textarea maxLength={500} value={planningInstructions} onChange={(event) => setPlanningInstructions(event.target.value)} placeholder="Anything else the schedule should account for?" /></label>
        </div>
        <p>Calendar dates and study hours use {PLANNER_TIME_ZONE}.</p>
      </details>
      <div className="assistant-capability-controls">
        <label>
          <span>Assistant tool</span>
          <select value={assistantMode} onChange={(event) => {
            setAssistantMode(event.target.value as AssistantMode);
            setAnswer("");
            setSources([]);
            setMemorySaved(false);
            setError("");
          }}>
            <option value="plan">Planner: ask, create, or edit tasks</option>
            <option value="insights">Analyze my planner</option>
            <option value="secretary">Personal secretary: tasks, Gmail, Calendar, Drive</option>
            <option value="research">Web research (with sources)</option>
            <option value="writing">Writing assistant</option>
            <option value="autofill">Generate / autofill Notion items</option>
            <option value="analyze">Analyze an uploaded file</option>
            <option value="translate">Translate text</option>
          </select>
        </label>
        {assistantMode === "translate" && (
          <>
            <label><span>Translate to</span><input value={targetLanguage} maxLength={80} onChange={(event) => setTargetLanguage(event.target.value)} placeholder="Target language" /></label>
            <label><span>From (optional)</span><input value={sourceLanguage} maxLength={80} onChange={(event) => setSourceLanguage(event.target.value)} placeholder="Detect automatically" /></label>
          </>
        )}
        {(assistantMode === "analyze" || assistantMode === "autofill") && (
          <label className="assistant-file-picker">
            <span>{assistantMode === "analyze" ? "File to analyze" : "Source file (optional)"}</span>
            <input type="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.csv,.xlsx"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />
            <small>{selectedFile ? `${selectedFile.name} · ${(selectedFile.size / 1024).toFixed(0)} KB` : "PDF, DOCX, text, image, CSV, or XLSX · up to 3 MB"}</small>
          </label>
        )}
      </div>
      <div className="assistant-quick-actions">
        {quickActions.map(({ id, label, icon: Icon }) => (
          <button type="button" key={id} onClick={() => runQuickAction(id)} disabled={disabled || loading || Boolean(pendingChange) || Boolean(plannedTasks.length)}>
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>
      <div className="assistant-controls">
        <button className="assistant-suggest" type="button" onClick={() => void ask("suggest")} disabled={disabled || loading || Boolean(pendingChange) || Boolean(plannedTasks.length)}>
          {loading ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
          Suggest next actions
        </button>
        <form className="assistant-question" onSubmit={submitInstruction}>
          <label className="sr-only" htmlFor="assistant-question">Ask or instruct your planner assistant</label>
          <input id="assistant-question" value={question} onChange={(event) => setQuestion(event.target.value)}
            maxLength={assistantMode === "translate" ? 8000 : assistantMode === "writing" || assistantMode === "autofill" ? 2000 : 1000}
            placeholder={
              assistantMode === "research" ? "What would you like to research?" :
              assistantMode === "insights" ? "Ask about overdue work, workload, hours, areas, or courses..." :
              assistantMode === "secretary" ? "What should I work on, or what needs attention in email and calendar?" :
              assistantMode === "writing" ? "What would you like to draft, revise, or summarize?" :
              assistantMode === "translate" ? "Enter text to translate..." :
              assistantMode === "analyze" ? "What should I look for in the uploaded file?" :
              assistantMode === "autofill" ? "What records should I extract or create?" :
              "Ask, add a task, or change a deadline..."
            } required disabled={modeDisabled || loading || Boolean(pendingChange) || Boolean(plannedTasks.length)} />
          <button type="submit" aria-label="Send planner instruction" disabled={modeDisabled || loading || Boolean(pendingChange) || Boolean(plannedTasks.length) || !question.trim()}>
            {loading ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
          </button>
        </form>
      </div>
      {modeDisabled && <p className="assistant-hint">{assistantMode === "secretary" && !googleConnected
        ? "Connect Google Workspace above to use the personal secretary."
        : "Connect to Notion and load your tasks to plan or autofill database items."}</p>}
      {answer && <div className="assistant-response" role="status" aria-live="polite"><AssistantMarkdown text={answer} /></div>}
      {answer && (assistantMode === "research" || assistantMode === "analyze") && (
        <div className="assistant-proposal-actions">
          <button type="button" className="assistant-confirm" onClick={() => void saveAnswerToMemory()}
            disabled={memorySaving || memorySaved}>
            {memorySaving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
            {memorySaved ? "Saved to AI Memory" : "Save to AI Memory"}
          </button>
        </div>
      )}
      {sources.length > 0 && (
        <div className="assistant-sources" aria-label="Web research sources">
          <strong>Sources</strong>
          {sources.map((source, index) => (
            <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">
              <span>[{index + 1}] {source.title}</span>
              {source.snippet && <small>{source.snippet}</small>}
            </a>
          ))}
        </div>
      )}
      {pendingChange && (
        <div className="assistant-proposal" aria-live="polite">
          <div className="assistant-proposal-heading">
            <strong>
              {pendingChange.action === "create"
                ? "Review this new task"
                : pendingChange.action === "bulk_update"
                  ? `Review this update for ${pendingChange.taskIds.length} tasks`
                  : "Review this task update"}
            </strong>
            {pendingTask && <span>For: {pendingTask.title}</span>}
          </div>
          <p>{pendingChange.summary}</p>
          <dl className="assistant-change-list">
            {Object.entries(pendingChange.fields).map(([field, value]) => {
              const key = field as ChangeField;
              const previousValue = pendingTask && key !== "dueDate" ? pendingTask[key] : pendingTask?.dueDate;
              const dateLabel = (date: string) => date.includes("T")
                ? formatPlannerDate(date, { dateStyle: "medium" })
                : date;
              const displayedValue = value === "" ? "Clear this value" : key === "dueDate" ? dateLabel(value) : value;
              return (
                <div key={field}>
                  <dt>{fieldLabels[key]}</dt>
                  <dd>
                    {pendingTask && previousValue !== value && <><span className="assistant-old-value">{previousValue ? key === "dueDate" ? dateLabel(previousValue) : previousValue : "Empty"}</span><span aria-hidden="true"> → </span></>}
                    {displayedValue}
                  </dd>
                </div>
              );
            })}
          </dl>
          {pendingChange.action === "bulk_update" && (
            <>
              <ul className="assistant-bulk-targets">
                {pendingTasks.map((target) => (
                  <li key={target.id}>
                    <strong>{target.title}</strong>
                    <span>{target.area || target.type}{target.course ? ` · ${target.course}` : ""}</span>
                    {pendingChange.fields.recurrence !== undefined && (
                      <span>
                        Recurrence: {target.recurrence || "None"} → {pendingChange.fields.recurrence || "Cleared"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="assistant-bulk-warning">Tasks are saved one at a time, so a Notion error may leave some changes applied.</p>
            </>
          )}
          <div className="assistant-proposal-actions">
            <button className="assistant-cancel" type="button" onClick={() => setPendingChange(null)} disabled={loading}>
              <X size={13} /> Cancel
            </button>
            <button className="assistant-confirm" type="button" onClick={() => void confirmChange()} disabled={loading || (pendingChange.action === "update" && !pendingTask) || (pendingChange.action === "bulk_update" && pendingTasks.length !== pendingChange.taskIds.length)}>
              {loading ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
              Confirm and {pendingChange.action === "create" ? "create" : "save"}
            </button>
          </div>
        </div>
      )}
      {breakdown && (
        <div className="assistant-bulk-plan">
          <h3>{breakdown.summary}</h3>
          <p>Select the steps you want to add as separate Notion tasks.</p>
          {plannedTasks.map((item, index) => (
            <label className="assistant-step" key={`${item.title}-${index}`}>
              <input type="checkbox" checked={item.checked} onChange={(event) => updatePlannedTask(index, event.target.checked)} />
              <span>
                <strong>{item.title.split(" — ").at(-1)} <small>({item.minutes} min)</small></strong>
                <small>{item.nextAction}</small>
              </span>
            </label>
          ))}
          <PlanActions count={plannedTasks.filter((item) => item.checked).length} loading={loading}
            onCancel={() => { setBreakdown(null); setPlannedTasks([]); }}
            onSave={() => void saveSelectedTasks()} label="Add selected steps to Notion" />
        </div>
      )}
      {databaseDraft && (
        <div className="assistant-bulk-plan">
          <h3>{databaseDraft.summary}</h3>
          <p>Review each extracted Notion item. Only checked items are saved after you confirm.</p>
          {plannedTasks.map((item, index) => (
            <label className="assistant-step" key={`${item.title}-${index}`}>
              <input type="checkbox" checked={item.checked} onChange={(event) => updatePlannedTask(index, event.target.checked)} />
              <span>
                <strong>{item.title}</strong>
                <small>{[
                  item.courseCode,
                  item.course,
                  item.assessment,
                  item.estimatedHours !== undefined ? `${item.estimatedHours} hours` : undefined,
                  item.dueDate,
                  item.deliverable ? "Deliverable" : undefined,
                ].filter(Boolean).join(" · ") || "No additional fields inferred"}</small>
                {item.nextAction && <small>Next action: {item.nextAction}</small>}
                {item.recurrence && <small>Recurrence: {item.recurrence}</small>}
                {item.notes && <small>{item.notes}</small>}
              </span>
            </label>
          ))}
          <PlanActions count={plannedTasks.filter((item) => item.checked).length} loading={loading}
            onCancel={() => { setDatabaseDraft(null); setPlannedTasks([]); }}
            onSave={() => void saveSelectedTasks()} label="Add selected items to Notion" />
        </div>
      )}
      {dayPlan && (
        <div className="assistant-bulk-plan assistant-day-plan">
          <h3>{dayPlan.summary}</h3>
          <p>{dayPlan.date} · {dayPlan.timezone} · Prayer times for Harar</p>
          <div className="assistant-timeline">
            {([
              ...Object.entries(dayPlan.prayerTimes).map(([name, time]) => ({
                startTime: time,
                endTime: minutesToTime(time, 15),
                title: `${name} prayer`,
                area: "Worship",
                nextAction: "Prayer time",
                prayer: true,
              })),
              ...dayPlan.blocks.map((block) => ({ ...block, prayer: false })),
            ]).sort((a, b) => a.startTime.localeCompare(b.startTime)).map((block, index) => (
              <div className={`assistant-timeline-item ${block.prayer ? "area-worship" : `area-${block.area.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}`} key={`${block.startTime}-${index}`}>
                <time>{block.startTime}–{block.endTime}</time>
                <div><strong>{block.title}</strong><small>{block.area}{block.nextAction ? ` · ${block.nextAction}` : ""}</small></div>
              </div>
            ))}
          </div>
          {plannedTasks.length > 0 && <PlanActions count={plannedTasks.filter((item) => item.checked).length} loading={loading}
            onCancel={() => { setDayPlan(null); setPlannedTasks([]); }}
            onSave={() => void saveSelectedTasks()} label="Save selected schedule blocks to Notion" />}
        </div>
      )}
      {error && <div className="assistant-response assistant-error" role="alert">{error}</div>}
      <p className="assistant-privacy">
        Planner details go to Google Gemini only for planner actions. Research queries and search snippets go to Tavily and Gemini; uploaded files are processed temporarily and only an analysis summary is stored if you choose Save to AI Memory. Notion changes are previewed and require your confirmation.
      </p>
    </section>
  );
}

function PlanActions({
  count,
  loading,
  onCancel,
  onSave,
  label,
}: {
  count: number;
  loading: boolean;
  onCancel: () => void;
  onSave: () => void;
  label: string;
}) {
  return (
    <div className="assistant-proposal-actions">
      <button type="button" className="assistant-cancel" onClick={onCancel} disabled={loading}><X size={13} /> Cancel</button>
      <button type="button" className="assistant-confirm" onClick={onSave} disabled={loading || count === 0}>
        {loading ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} {label} ({count})
      </button>
    </div>
  );
}
