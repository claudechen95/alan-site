"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { version } from "@/version.json";
import type { Goal, GoalStatus } from "@/lib/types";

const PST = "America/Los_Angeles";

function getTodayPST(): Date {
  const pstStr = new Date().toLocaleString("en-US", { timeZone: PST });
  return new Date(pstStr);
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      emoji: emoji.trim() || "✓",
      frequency,
      targetCount,
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

function GoalCard({
  goal,
  onCheckIn,
  onUndo,
  onEdit,
  onDelete,
  loading,
}: {
  goal: GoalStatus;
  onCheckIn: (id: string) => void;
  onUndo: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  loading: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const doneCard = goal.isDone;
  const doneCircle = goal.isDone || (
    goal.frequency === "weekly" && goal.targetCount > 1 && goal.todayCount >= 1
  );
  const label = goal.frequency === "daily" ? "today" : "this week";

  return (
    <div
      className={`rounded-2xl border p-5 transition-all duration-300 ${
        doneCard
          ? "bg-green-50 border-green-200"
          : "bg-white border-gray-200 shadow-sm"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">{goal.emoji}</span>
            <h2 className="text-lg font-semibold text-gray-900 truncate">
              {goal.name}
            </h2>
          </div>
          <p className="text-sm text-gray-500 mb-3">
            {goal.targetCount}x {goal.frequency} &middot; {formatPeriod(goal.frequency)}
          </p>
          <StreakBadge streak={goal.streak} />
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

      <div className="flex justify-end gap-3 mt-3 pt-2 border-t border-gray-100">
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
  );
}

export default function HomePage() {
  const [goals, setGoals] = useState<GoalStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchGoals = useCallback(async () => {
    try {
      const res = await fetch("/api/goals");
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setGoals(data);
    } catch {
      setError("Couldn't load goals. Is the server running?");
    } finally {
      setInitialLoad(false);
    }
  }, []);

  useEffect(() => {
    fetchGoals();
  }, [fetchGoals]);

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
        scheduleRefresh();
      }, msUntilMidnightPST());
    }
    scheduleRefresh();
    return () => clearTimeout(timeout);
  }, [fetchGoals]);

  const handleCheckIn = async (goalId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/checkins", {
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

  const handleUndo = async (goalId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/checkins", {
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
      const res = await fetch("/api/goals", {
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
      const res = await fetch("/api/goals", {
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

  const allDone = goals.length > 0 && goals.every((g) => g.isDone);

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">
          Hey Alan 👋
        </h1>
        <p className="text-gray-500 mt-1">
          {getTodayPST().toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

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

      {/* Goals */}
      {initialLoad ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-28 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {goals.map((goal) =>
            editingId === goal.id ? (
              <HabitForm
                key={goal.id}
                initial={goal}
                onSave={handleSaveHabit}
                onCancel={() => setEditingId(null)}
                loading={loading}
              />
            ) : (
              <GoalCard
                key={goal.id}
                goal={goal}
                onCheckIn={handleCheckIn}
                onUndo={handleUndo}
                onEdit={setEditingId}
                onDelete={handleDeleteHabit}
                loading={loading}
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
      )}

      {/* Footer */}
      <div className="flex justify-center items-center gap-4 mt-6">
        <Link href="/notes" className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 transition-colors">
          view notes
        </Link>
        <span className="text-xs text-gray-300">·</span>
        <Link href="/history" className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 transition-colors">
          view history
        </Link>
        <span className="text-xs text-gray-300">·</span>
        <span className="text-xs text-gray-300">v{version}</span>
      </div>
    </main>
  );
}
