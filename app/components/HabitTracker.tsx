"use client";

import type { ReactNode } from "react";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import versionData from "@/version.json";
import type { Goal, GoalStatus, ReflectionPrompt } from "@/lib/types";
import type { VacationWindow } from "@/lib/kv";
import { EmotionWheel, MoodModal } from "@/app/components/MoodModal";

const PST = "America/Los_Angeles";

function getTodayPST(): Date {
  const pstStr = new Date().toLocaleString("en-US", { timeZone: PST });
  return new Date(pstStr);
}

function getTodayDateStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PST }).format(new Date());
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
  return [dt.getUTCFullYear(), String(dt.getUTCMonth() + 1).padStart(2, "0"), String(dt.getUTCDate()).padStart(2, "0")].join("-");
}

function isHandled(g: GoalStatus): boolean {
  return g.isDone || (g.frequency === "weekly" && g.targetCount > 1 && g.todayCount >= 1);
}

// A habit's run, in whichever unit its frequency is scored in - days for daily, weeks for
// weekly. `streak` carries the live run while a habit is tracked and the frozen one after it
// graduates, so both cases read the same field.
function runLabel(g: GoalStatus): string {
  return `${g.streak}${g.frequency === "daily" ? "d" : "w"}`;
}

function runText(g: GoalStatus): string {
  const unit = g.frequency === "daily" ? "day" : "week";
  return `${g.streak} ${unit}${g.streak === 1 ? "" : "s"} straight`;
}

function formatPeriod(frequency: "daily" | "weekly"): string {
  const today = getTodayPST();
  if (frequency === "daily") {
    return today.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - (today.getDay() + 6) % 7); // Monday
  return `Week of ${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function StreakBadge({ streak }: { streak: number }) {
  if (streak === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-600 bg-orange-50 border border-orange-200 rounded-full px-2 py-0.5">
      🔥 {streak} {streak === 1 ? "streak" : "in a row"}
    </span>
  );
}

function HabitForm({
  initial,
  onSave,
  onCancel,
  loading,
}: {
  initial?: Goal;
  onSave: (goal: Goal) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [frequency, setFrequency] = useState<"daily" | "weekly">(initial?.frequency ?? "daily");
  const [targetCount, setTargetCount] = useState(initial?.targetCount ?? 1);
  const [nudgeDays, setNudgeDays] = useState<number[]>(initial?.nudgeDays ?? []);
  const [nudgeTime, setNudgeTime] = useState(initial?.nudgeTime ?? "21:00");
  const [nudgeEnabled, setNudgeEnabled] = useState(initial?.nudgeEnabled ?? true);

  const toggleNudgeDay = (day: number) =>
    setNudgeDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);

  const nudgeActive = frequency === "daily" ? nudgeEnabled : nudgeDays.length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      emoji: emoji.trim() || "✓",
      frequency,
      targetCount,
      nudgeDays: frequency === "weekly" ? nudgeDays : undefined,
      nudgeEnabled: frequency === "daily" ? nudgeEnabled : undefined,
      nudgeTime: nudgeActive ? nudgeTime : undefined,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5 space-y-4"
    >
      <div className="flex gap-3">
        <input
          type="text"
          placeholder="😀"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          className="w-14 text-2xl text-center border border-gray-200 rounded-xl p-2 focus:outline-none focus:ring-2 focus:ring-gray-300"
          maxLength={4}
        />
        <input
          type="text"
          placeholder="Habit name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300"
          autoFocus
          required
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="flex rounded-xl border border-gray-200 overflow-hidden text-sm">
          <button
            type="button"
            onClick={() => setFrequency("daily")}
            className={`px-3 py-1.5 transition-colors ${
              frequency === "daily" ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-50"
            }`}
          >
            Daily
          </button>
          <button
            type="button"
            onClick={() => setFrequency("weekly")}
            className={`px-3 py-1.5 transition-colors ${
              frequency === "weekly" ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-50"
            }`}
          >
            Weekly
          </button>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={() => setTargetCount(Math.max(1, targetCount - 1))}
            className="w-7 h-7 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 flex items-center justify-center text-lg leading-none"
          >
            −
          </button>
          <span className="text-sm text-gray-700 w-20 text-center">
            {targetCount}× / {frequency === "daily" ? "day" : "week"}
          </span>
          <button
            type="button"
            onClick={() => setTargetCount(targetCount + 1)}
            className="w-7 h-7 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 flex items-center justify-center text-lg leading-none"
          >
            +
          </button>
        </div>
      </div>

      {frequency === "daily" && (
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={nudgeEnabled}
            onChange={(e) => setNudgeEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-gray-900 focus:ring-gray-300"
          />
          Nudge me daily
        </label>
      )}

      {frequency === "weekly" && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Nudge me on</p>
          <div className="flex gap-1.5">
            {["S","M","T","W","T","F","S"].map((label, day) => (
              <button
                key={day}
                type="button"
                onClick={() => toggleNudgeDay(day)}
                className={`w-8 h-8 rounded-full text-xs font-medium transition-colors ${
                  nudgeDays.includes(day)
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {nudgeActive && (
        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">First reminder (PST)</p>
            <input
              type="time"
              value={nudgeTime}
              onChange={(e) => setNudgeTime(e.target.value)}
              // Past 9pm there's no room left to fit three reminders before the 10pm call.
              max="21:00"
              className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-300"
            />
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            3 texts, spread from then until 10pm, then a call.
          </p>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={loading || !name.trim()}
          className="flex-1 bg-gray-900 text-white rounded-xl py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {initial ? "Save changes" : "Add habit"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// Graduated habits, as a shelf of medallions above the active list. Collapsible because the
// shelf only ever grows: left open forever it would eventually push the habits still being
// worked on below the fold, which is exactly backwards for a tracker's home screen.
function TrophyShelf({
  goals,
  onUngraduate,
  loading,
}: {
  goals: GoalStatus[];
  onUngraduate: (id: string) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = goals.find((g) => g.id === selectedId) ?? null;

  return (
    <section className="mb-6">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-800 transition-colors"
      >
        <span aria-hidden>🏆</span>
        <span>Graduated · {goals.length}</span>
        <svg
          className={`w-3 h-3 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <div className="mt-2.5">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {goals.map((g) => {
              const isSelected = g.id === selectedId;
              return (
                <button
                  key={g.id}
                  onClick={() => setSelectedId(isSelected ? null : g.id)}
                  aria-pressed={isSelected}
                  className={`flex-shrink-0 w-[4.25rem] rounded-xl border px-2 py-2 flex flex-col items-center gap-0.5 transition-colors ${
                    isSelected
                      ? "border-amber-400 bg-amber-100"
                      : "border-amber-200 bg-amber-50 hover:bg-amber-100"
                  }`}
                >
                  <span className="text-2xl leading-none">{g.emoji}</span>
                  <span className="text-[10px] font-medium text-amber-700 tabular-nums">{runLabel(g)}</span>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
              <p className="text-sm font-medium text-gray-900 break-words">
                <span className="mr-1.5">{selected.emoji}</span>
                {selected.name}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {runText(selected)}
                {selected.graduatedAt && (
                  <>
                    {" · graduated "}
                    {new Date(selected.graduatedAt + "T12:00:00").toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </>
                )}
              </p>
              <button
                onClick={() => onUngraduate(selected.id)}
                disabled={loading}
                className="mt-2 text-xs text-gray-400 hover:text-gray-600 underline disabled:opacity-50"
              >
                start tracking again
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// What the prompt actually says, which depends on why we're asking. A weekly habit isn't
// "missed" because of one skipped day, so it gets the arithmetic that made us ask instead.
function reflectionPromptText(prompt: ReflectionPrompt): ReactNode {
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

  if (prompt.reason === "missed-day") {
    const weekday = new Date(prompt.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
    return (
      <>
        <span className="font-medium">{weekday}</span> you missed this. What got in the way?
      </>
    );
  }

  if (prompt.reason === "week-missed") {
    return (
      <>
        Last week you got <span className="font-medium">{prompt.completed} of {prompt.target}</span>.
        What got in the way?
      </>
    );
  }

  const behind = prompt.target - prompt.completed > prompt.daysLeft;
  return behind ? (
    <>
      You’re at <span className="font-medium">{prompt.completed} of {prompt.target}</span> this week
      with only {days(prompt.daysLeft)} left - this one’s out of reach now. What got in the way?
    </>
  ) : (
    <>
      You’re at <span className="font-medium">{prompt.completed} of {prompt.target}</span> this week
      with {days(prompt.daysLeft)} left - every remaining day has to count. What’s getting in the way?
    </>
  );
}

// Enough to be a thought rather than a keystroke, low enough that one honest sentence clears it.
const MIN_REFLECTION_CHARS = 15;

function ReflectionModal({
  goal,
  prompt,
  onSubmit,
  onSkip,
  onDismiss,
}: {
  goal: GoalStatus;
  prompt: ReflectionPrompt;
  onSubmit: (text: string) => void;
  onSkip: () => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // A required prompt still closes - the user is never trapped in a modal. What it won't do is
  // hand over the check-in on the way out. Backing out leaves the habit unchecked, so the only
  // path to the green tick is writing the thing. That's the difference between a required
  // reflection and the old skip link, which gave away the check-in for a single tap.
  const short = text.trim().length < MIN_REFLECTION_CHARS;
  const blocked = prompt.required && short;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && onDismiss()}
    >
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{goal.emoji}</span>
            <h2 className="text-base font-semibold text-gray-900">{goal.name}</h2>
          </div>
          <button
            onClick={onDismiss}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <p className="text-sm text-gray-700">{reflectionPromptText(prompt)}</p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            prompt.required
              ? "A sentence is plenty - what actually happened?"
              : "Optional - just thinking out loud is enough"
          }
          rows={3}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-gray-300"
          autoFocus
        />

        <div className="flex flex-col gap-2">
          <button
            onClick={() => onSubmit(text)}
            disabled={blocked}
            className="w-full bg-gray-900 text-white rounded-xl py-2 text-sm font-medium hover:bg-gray-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {text.trim() ? "Save & Check In" : "Check In"}
          </button>
          {prompt.required ? (
            <p className="text-xs text-gray-400 text-center">
              {blocked
                ? "This one needs a reflection before it counts."
                : "Checking in will save this reflection."}
            </p>
          ) : (
            <button
              onClick={onSkip}
              className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors"
            >
              just check in, skip reflection
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


function GoalCard({
  goal,
  onCheckIn,
  onUndo,
  onEdit,
  onDelete,
  onGraduate,
  onSnoozeGraduation,
  loading,
  paused,
  dragHandleProps,
}: {
  goal: GoalStatus;
  onCheckIn: (id: string) => void;
  onUndo: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onGraduate: (id: string) => void;
  onSnoozeGraduation: (id: string) => void;
  loading: boolean;
  paused?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement> & { ref?: React.Ref<HTMLButtonElement> };
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameExpanded, setNameExpanded] = useState(false);
  const [gradInfoOpen, setGradInfoOpen] = useState(false);
  const doneCard = goal.isDone;
  const doneCircle = isHandled(goal);
  const label = goal.frequency === "daily" ? "today" : "this week";

  return (
    <div
      className={`rounded-2xl border p-5 transition-all duration-300 ${
        doneCard
          ? "bg-green-50 border-green-200"
          : "bg-white border-gray-200 shadow-sm"
      }`}
    >
      <div className="flex items-start gap-2">
        {dragHandleProps && (
          <button
            {...dragHandleProps}
            className="mt-2 cursor-grab active:cursor-grabbing touch-none text-gray-300 hover:text-gray-400 flex-shrink-0 focus:outline-none"
            tabIndex={-1}
            aria-label="Drag to reorder"
          >
            <svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor">
              <circle cx="2" cy="2.5" r="1.5" /><circle cx="8" cy="2.5" r="1.5" />
              <circle cx="2" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" />
              <circle cx="2" cy="13.5" r="1.5" /><circle cx="8" cy="13.5" r="1.5" />
            </svg>
          </button>
        )}
        <div className="flex flex-1 min-w-0 items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 min-w-0 cursor-pointer" onClick={() => setNameExpanded(e => !e)}>
            <span className="text-2xl flex-shrink-0">{goal.emoji}</span>
            <h2 className={`text-lg font-semibold text-gray-900 ${nameExpanded ? "break-words" : "truncate"}`}>
              {goal.name}
            </h2>
          </div>
          <p className="text-sm text-gray-500 mb-3">
            {goal.targetCount}x {goal.frequency} &middot; {formatPeriod(goal.frequency)}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <StreakBadge streak={goal.streak} />
            {paused && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-600 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5">
                🌴 paused
              </span>
            )}
          </div>
        </div>

        <div className="flex-shrink-0">
          {doneCircle ? (
            <div className="flex flex-col items-end gap-2">
              <div className="w-12 h-12 rounded-full bg-green-500 flex items-center justify-center shadow-md">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex items-center gap-2">
                {goal.type === "mood" ? (
                  <button
                    onClick={() => onCheckIn(goal.id)}
                    disabled={loading}
                    className="text-xs text-indigo-500 hover:text-indigo-700 underline"
                  >
                    log another
                  </button>
                ) : (
                  <>
                    {goal.frequency === "daily" && goal.targetCount > 1 && (
                      <button
                        onClick={() => onCheckIn(goal.id)}
                        disabled={loading}
                        className="text-xs text-green-600 hover:text-green-800 underline"
                      >
                        +extra
                      </button>
                    )}
                    <button
                      onClick={() => onUndo(goal.id)}
                      disabled={loading}
                      className="text-xs text-gray-400 hover:text-gray-600 underline"
                    >
                      undo
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => onCheckIn(goal.id)}
              disabled={loading}
              className="w-12 h-12 rounded-full border-2 border-dashed border-gray-300 hover:border-green-400 hover:bg-green-50 transition-all duration-200 flex items-center justify-center group disabled:opacity-50"
            >
              <svg
                className="w-5 h-5 text-gray-300 group-hover:text-green-500 transition-colors"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </button>
          )}
        </div>
        </div>
      </div>

      {goal.targetCount > 1 && (
        <div className="mt-3">
          <div className="flex gap-1">
            {Array.from({ length: goal.targetCount }).map((_, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  i < goal.completedThisPeriod ? "bg-green-500" : "bg-gray-200"
                }`}
              />
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {goal.completedThisPeriod}/{goal.targetCount} {label}
          </p>
        </div>
      )}

      {/* The offer sits inline with edit/delete rather than in a banner of its own. It's a
          suggestion about a habit that's going *well*, so it shouldn't shout - and it appears on
          every eligible card at once, which a full-width callout turns into a wall of amber. The
          reasoning behind it moves behind the ⓘ, on demand. */}
      <div className="flex items-center gap-3 mt-3 pt-2 border-t border-gray-100">
        {goal.canGraduate && !confirmDelete && (
          <div className="flex items-center gap-1 mr-auto">
            <button
              onClick={() => onGraduate(goal.id)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-900 disabled:opacity-50"
            >
              <span aria-hidden>🎓</span>
              <span className="underline">graduate</span>
            </button>
            <button
              onClick={() => setGradInfoOpen((v) => !v)}
              aria-label="What does graduating do?"
              aria-expanded={gradInfoOpen}
              className={`w-4 h-4 rounded-full border text-[10px] leading-none flex items-center justify-center transition-colors ${
                gradInfoOpen
                  ? "border-amber-400 bg-amber-100 text-amber-800"
                  : "border-amber-300 text-amber-600 hover:bg-amber-50"
              }`}
            >
              ?
            </button>
          </div>
        )}
        <div className={`flex gap-3 ${goal.canGraduate && !confirmDelete ? "" : "ml-auto"}`}>
        {confirmDelete ? (
          <>
            <span className="text-xs text-gray-500">Delete this habit?</span>
            <button
              onClick={() => onDelete(goal.id)}
              className="text-xs text-red-500 hover:text-red-700 font-medium underline"
            >
              yes, delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => onEdit(goal.id)}
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              edit
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-gray-400 hover:text-red-500 underline"
            >
              delete
            </button>
          </>
        )}
        </div>
      </div>

      {goal.canGraduate && gradInfoOpen && !confirmDelete && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-amber-900">
            <span className="font-medium">{runText(goal)}</span> - long enough that this looks
            automatic. Graduating moves it to your trophy shelf and stops tracking it: no
            check-ins, no nudges, no reflection prompts. You can start tracking it again any time.
          </p>
          <button
            onClick={() => onSnoozeGraduation(goal.id)}
            disabled={loading}
            className="mt-1.5 text-[11px] text-gray-400 hover:text-gray-600 underline disabled:opacity-50"
          >
            not yet - don&rsquo;t ask again for two weeks
          </button>
        </div>
      )}
    </div>
  );
}

function SortableGoalCard(props: React.ComponentProps<typeof GoalCard>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.goal.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : undefined,
        position: "relative",
      }}
    >
      <GoalCard {...props} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

export function HomePage({ userId }: { userId?: string }) {
  const [goals, setGoals] = useState<GoalStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reflectionTarget, setReflectionTarget] = useState<GoalStatus | null>(null);
  const [moodModalOpen, setMoodModalOpen] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [vacation, setVacation] = useState<VacationWindow | null>(null);
  const [upcomingVacation, setUpcomingVacation] = useState<VacationWindow | null>(null);
  const [vacationFormOpen, setVacationFormOpen] = useState(false);
  const [vacationStartDate, setVacationStartDate] = useState(() => getTodayDateStr());
  const [vacationEndDate, setVacationEndDate] = useState(() => addDaysToDateStr(getTodayDateStr(), 7));
  const [vacationGoalIds, setVacationGoalIds] = useState<string[]>([]);

  const isGoalPaused = (goalId: string) => !!vacation?.goalIds.includes(goalId);

  const q = userId ? `?user=${encodeURIComponent(userId)}` : "";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const fetchGoals = useCallback(async () => {
    try {
      const res = await fetch(`/api/goals${q}`);
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setGoals(data);
    } catch {
      setError("Couldn't load goals. Is the server running?");
    } finally {
      setInitialLoad(false);
    }
  }, [q]);

  const fetchVacation = useCallback(async () => {
    try {
      const res = await fetch(`/api/vacation${q}`);
      if (!res.ok) return;
      const data = await res.json();
      setVacation(data.active);
      setUpcomingVacation(data.upcoming);
    } catch {
      // non-critical — leave prior state
    }
  }, [q]);

  useEffect(() => {
    fetchGoals();
    fetchVacation();
  }, [fetchGoals, fetchVacation]);

  // Refresh at midnight PST
  useEffect(() => {
    function msUntilMidnightPST(): number {
      const now = new Date();
      const pstNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const msSinceMidnight =
        pstNow.getHours() * 3600000 +
        pstNow.getMinutes() * 60000 +
        pstNow.getSeconds() * 1000 +
        pstNow.getMilliseconds();
      return 86400000 - msSinceMidnight;
    }

    let timeout: ReturnType<typeof setTimeout>;
    function scheduleRefresh() {
      timeout = setTimeout(() => {
        fetchGoals();
        fetchVacation();
        scheduleRefresh();
      }, msUntilMidnightPST());
    }
    scheduleRefresh();
    return () => clearTimeout(timeout);
  }, [fetchGoals, fetchVacation]);

  const doCheckIn = async (goalId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/checkins${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId }),
      });
      if (!res.ok) throw new Error("Check-in failed");
      await fetchGoals();
    } catch {
      setError("Check-in failed. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleCheckIn = (goalId: string) => {
    const goal = goals.find((g) => g.id === goalId);
    if (!isGoalPaused(goalId) && goal?.reflection && goal.todayCount === 0) {
      setReflectionTarget(goal);
      return;
    }
    if (goal?.type === "mood") {
      setMoodModalOpen(true);
      return;
    }
    doCheckIn(goalId);
  };

  const handleMoodSubmit = async (emoji: string, text: string) => {
    setMoodModalOpen(false);
    setLoading(true);
    try {
      await fetch(`/api/mood${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji, text }),
      });
      await fetchGoals();
    } catch {
      setError("Failed to log check-in. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleReflectionSubmit = async (text: string) => {
    if (!reflectionTarget) return;
    const goalId = reflectionTarget.id;
    const isMood = reflectionTarget.type === "mood";
    setReflectionTarget(null);
    if (text.trim()) {
      await fetch(`/api/reflections${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId, text }),
      });
    }
    if (isMood) {
      setMoodModalOpen(true);
    } else {
      await doCheckIn(goalId);
    }
  };

  const handleReflectionSkip = async () => {
    if (!reflectionTarget) return;
    const isMood = reflectionTarget.type === "mood";
    const goalId = reflectionTarget.id;
    setReflectionTarget(null);
    if (isMood) {
      setMoodModalOpen(true);
    } else {
      await doCheckIn(goalId);
    }
  };

  const handleUndo = async (goalId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/checkins${q}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId }),
      });
      if (!res.ok) throw new Error("Undo failed");
      await fetchGoals();
    } catch {
      setError("Undo failed. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveHabit = async (goal: Goal) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/goals${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(goal),
      });
      if (!res.ok) throw new Error("Save failed");
      setAddingNew(false);
      setEditingId(null);
      await fetchGoals();
    } catch {
      setError("Couldn't save habit. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteHabit = async (goalId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/goals${q}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: goalId }),
      });
      if (!res.ok) throw new Error("Delete failed");
      await fetchGoals();
    } catch {
      setError("Couldn't delete habit. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const toggleVacationForm = () => {
    if (!vacationFormOpen) {
      setVacationGoalIds(goals.map((g) => g.id));
      setVacationStartDate(getTodayDateStr());
      setVacationEndDate(addDaysToDateStr(getTodayDateStr(), 7));
    }
    setVacationFormOpen((v) => !v);
  };

  const toggleVacationGoal = (goalId: string) => {
    setVacationGoalIds((prev) =>
      prev.includes(goalId) ? prev.filter((id) => id !== goalId) : [...prev, goalId]
    );
  };

  const handleStartVacation = async () => {
    if (vacationGoalIds.length === 0 || !vacationStartDate || !vacationEndDate) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/vacation${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: vacationStartDate, endDate: vacationEndDate, goalIds: vacationGoalIds }),
      });
      if (!res.ok) throw new Error("Failed to start vacation");
      const data = await res.json();
      setVacation(data.active);
      setUpcomingVacation(data.upcoming);
      setVacationFormOpen(false);
    } catch {
      setError("Couldn't start vacation. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleEndVacation = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/vacation${q}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to end vacation");
      setVacation(null);
      setUpcomingVacation(null);
      await fetchGoals(); // streak numbers may shift back under normal rules
    } catch {
      setError("Couldn't end vacation. Try again.");
    } finally {
      setLoading(false);
    }
  };

  // Graduated habits live on the trophy shelf, not in the tracked list, so every bit of the
  // active UI below (ordering, drag-reorder, hide-completed, the all-done celebration) works
  // off `sortedGoals` and never sees them.
  const graduatedGoals = goals.filter((g) => g.graduatedAt);
  const sortedGoals = goals
    .filter((g) => !g.graduatedAt)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortedGoals.findIndex((g) => g.id === active.id);
    const newIndex = sortedGoals.findIndex((g) => g.id === over.id);
    const reordered = arrayMove(sortedGoals, oldIndex, newIndex);

    setGoals(reordered.map((g, i) => ({ ...g, order: i })));

    try {
      await fetch(`/api/goals${q}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: reordered.map((g) => g.id) }),
      });
    } catch {
      setError("Couldn't save order. Try again.");
      fetchGoals();
    }
  };

  const allDone = sortedGoals.length > 0 && sortedGoals.every((g) => g.isDone);

  const postGraduation = async (goalId: string, graduation: "graduate" | "ungraduate" | "snooze") => {
    setLoading(true);
    try {
      const res = await fetch(`/api/goals${q}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId, graduation }),
      });
      if (!res.ok) throw new Error("Graduation update failed");
      await fetchGoals();
    } catch {
      setError("Couldn't update that habit. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const updatedLabel = new Date(versionData.updatedAt + "T12:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Hey {userId ? userId.charAt(0).toUpperCase() + userId.slice(1) : "Alan"} 👋</h1>
          <p className="text-gray-500 mt-1">
            {getTodayPST().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        <div className="text-right mt-1">
          <p className="text-xs font-semibold text-gray-400">v{versionData.version}</p>
          <p className="text-[11px] text-gray-300">updated {updatedLabel}</p>
          {!vacation && !upcomingVacation && (
            <button
              onClick={toggleVacationForm}
              className="text-[11px] text-gray-400 hover:text-gray-600 underline mt-1"
            >
              🌴 vacation mode
            </button>
          )}
        </div>
      </div>

      {/* Vacation start form */}
      {vacationFormOpen && !vacation && !upcomingVacation && (
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white shadow-sm p-4 space-y-3">
          <p className="text-sm text-gray-700">Pause nudges and protect streaks for selected habits while you’re away.</p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {sortedGoals.map((g) => (
              <label key={g.id} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={vacationGoalIds.includes(g.id)}
                  onChange={() => toggleVacationGoal(g.id)}
                  className="w-4 h-4 rounded border-gray-300 text-gray-900 focus:ring-gray-300"
                />
                <span>{g.emoji} {g.name}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
            <span className="text-sm text-gray-500">From:</span>
            <input
              type="date"
              min={getTodayDateStr()}
              value={vacationStartDate}
              onChange={(e) => {
                const next = e.target.value;
                setVacationStartDate(next);
                if (vacationEndDate < next) setVacationEndDate(next);
              }}
              className="border border-gray-200 rounded-xl px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300"
            />
            <span className="text-sm text-gray-500">Until:</span>
            <input
              type="date"
              min={vacationStartDate}
              value={vacationEndDate}
              onChange={(e) => setVacationEndDate(e.target.value)}
              className="border border-gray-200 rounded-xl px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleStartVacation}
              disabled={loading || vacationGoalIds.length === 0 || !vacationStartDate || !vacationEndDate}
              className="ml-auto bg-gray-900 text-white rounded-xl px-4 py-1.5 text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              {vacationStartDate > getTodayDateStr() ? "Schedule" : "Start"}
            </button>
            <button
              onClick={() => setVacationFormOpen(false)}
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {/* Vacation active banner */}
      {vacation && (
        <div className="mb-6 rounded-2xl bg-sky-50 border border-sky-200 p-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-sky-900">
              🌴 {vacation.goalIds.length} habit{vacation.goalIds.length === 1 ? "" : "s"} paused until{" "}
              {new Date(vacation.endDate + "T12:00:00").toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </p>
            <p className="text-xs text-sky-600 mt-0.5">
              {goals.filter((g) => vacation.goalIds.includes(g.id)).map((g) => g.emoji).join(" ") || "Nudges paused. Streaks are safe."}
            </p>
          </div>
          <button
            onClick={handleEndVacation}
            className="text-xs text-sky-600 hover:text-sky-800 underline flex-shrink-0"
          >
            end early
          </button>
        </div>
      )}

      {/* Vacation scheduled (not started yet) banner */}
      {!vacation && upcomingVacation && (
        <div className="mb-6 rounded-2xl bg-sky-50 border border-sky-200 p-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-sky-900">
              🌴 {upcomingVacation.goalIds.length} habit{upcomingVacation.goalIds.length === 1 ? "" : "s"} scheduled for vacation{" "}
              {new Date(upcomingVacation.startDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              {" – "}
              {new Date(upcomingVacation.endDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </p>
            <p className="text-xs text-sky-600 mt-0.5">
              {goals.filter((g) => upcomingVacation.goalIds.includes(g.id)).map((g) => g.emoji).join(" ")}
            </p>
          </div>
          <button
            onClick={handleEndVacation}
            className="text-xs text-sky-600 hover:text-sky-800 underline flex-shrink-0"
          >
            cancel
          </button>
        </div>
      )}

      {/* All done banner */}
      {allDone && (
        <div className="mb-6 rounded-2xl bg-green-500 text-white p-4 text-center shadow-md">
          <p className="text-xl font-bold">All done for today! 🎉</p>
          <p className="text-green-100 text-sm mt-0.5">Keep it up.</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Trophy shelf */}
      {!initialLoad && graduatedGoals.length > 0 && (
        <TrophyShelf
          goals={graduatedGoals}
          onUngraduate={(id) => postGraduation(id, "ungraduate")}
          loading={loading}
        />
      )}

      {/* Goals */}
      {!initialLoad && sortedGoals.some(isHandled) && (
        <div className="flex justify-end mb-3">
          <button
            onClick={() => setHideDone((v) => !v)}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            {hideDone ? "show completed" : "hide completed"}
          </button>
        </div>
      )}
      {initialLoad ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-28 animate-pulse" />
          ))}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortedGoals.map((g) => g.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-4">
              {sortedGoals.filter((g) => !hideDone || !isHandled(g)).map((goal) =>
                editingId === goal.id ? (
                  <HabitForm
                    key={goal.id}
                    initial={goal}
                    onSave={handleSaveHabit}
                    onCancel={() => setEditingId(null)}
                    loading={loading}
                  />
                ) : (
                  <SortableGoalCard
                    key={goal.id}
                    goal={goal}
                    onCheckIn={handleCheckIn}
                    onUndo={handleUndo}
                    onEdit={setEditingId}
                    onDelete={handleDeleteHabit}
                    onGraduate={(id) => postGraduation(id, "graduate")}
                    onSnoozeGraduation={(id) => postGraduation(id, "snooze")}
                    loading={loading}
                    paused={isGoalPaused(goal.id)}
                  />
                )
              )}

          {addingNew ? (
            <HabitForm
              onSave={handleSaveHabit}
              onCancel={() => setAddingNew(false)}
              loading={loading}
            />
          ) : (
            <button
              onClick={() => setAddingNew(true)}
              className="w-full rounded-2xl border-2 border-dashed border-gray-200 p-4 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600 transition-colors"
            >
              + Add habit
            </button>
          )}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Reflection modal */}
      {reflectionTarget?.reflection && (
        <ReflectionModal
          goal={reflectionTarget}
          prompt={reflectionTarget.reflection}
          onSubmit={handleReflectionSubmit}
          onSkip={handleReflectionSkip}
          onDismiss={() => setReflectionTarget(null)}
        />
      )}

      {/* Mood modal */}
      {moodModalOpen && (
        <MoodModal
          onSubmit={handleMoodSubmit}
          onClose={() => setMoodModalOpen(false)}
        />
      )}

    </main>
  );
}
