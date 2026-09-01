"use client";

import React, { useEffect, useState, useCallback } from "react";
import type { Goal } from "@/lib/types";

const PST = "America/Los_Angeles";

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PST }).format(new Date());
}

interface HistoryEntry {
  period: string;
  count: number;
  done: boolean;
  vacation: boolean;
  graduated: boolean; // day falls after the habit graduated, so nothing was expected on it
}

interface GoalHistory {
  goal: Goal;
  entries: HistoryEntry[];
  streak: number;
  reflections: Record<string, string>;
}

// --- Tooltip ---
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="relative group">
      {children}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-10 pointer-events-none">
        <div className="bg-gray-900 text-white text-[10px] rounded px-2 py-1 whitespace-pre-line max-w-[180px] text-center">
          {text}
        </div>
      </div>
    </div>
  );
}

// --- Backfill confirmation modal ---
function BackfillModal({
  period,
  goalName,
  goalEmoji,
  reflection,
  onConfirm,
  onCancel,
  saving,
}: {
  period: string;
  goalName: string;
  goalEmoji: string;
  reflection?: string;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const dateLabel = new Date(period + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{goalEmoji}</span>
          <div>
            <h2 className="text-base font-semibold text-gray-900">{goalName}</h2>
            <p className="text-xs text-gray-400">{dateLabel}</p>
          </div>
        </div>
        {reflection && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <p className="text-xs font-medium text-amber-600 uppercase tracking-wide mb-1">Your reflection</p>
            <p className="text-sm text-gray-700 leading-snug">“{reflection}”</p>
          </div>
        )}
        <div className="space-y-1">
          <p className="text-sm text-gray-700">Mark this day as completed?</p>
          <p className="text-xs text-gray-400">Use this if you did it but forgot to log at the time.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            disabled={saving}
            className="flex-1 bg-gray-900 text-white rounded-xl py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Yes, backfill it"}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Daily calendar grid (13 weeks × 7 days) ---
function DailyGrid({
  entries,
  frequency,
  reflections,
  onBackfill,
}: {
  entries: HistoryEntry[];
  frequency: "daily" | "weekly";
  reflections: Record<string, string>;
  onBackfill?: (period: string) => void;
}) {
  const today = getTodayPST();

  const firstDate = new Date((entries[0]?.period ?? today) + "T12:00:00");
  const dayOfWeek = (firstDate.getDay() + 6) % 7;
  const paddedEntries: (HistoryEntry | null)[] = [
    ...Array(dayOfWeek).fill(null),
    ...entries,
  ];
  while (paddedEntries.length % 7 !== 0) paddedEntries.push(null);

  const weeks: (HistoryEntry | null)[][] = [];
  for (let i = 0; i < paddedEntries.length; i += 7) {
    weeks.push(paddedEntries.slice(i, i + 7));
  }

  const dayLabels = ["M", "T", "W", "T", "F", "S", "Su"];

  return (
    <div>
      <div className="flex gap-1">
        <div className="flex flex-col gap-1 mr-1">
          <div className="h-3" />
          {dayLabels.map((d, i) => (
            <div key={i} className="w-4 h-3 flex items-center justify-start text-[9px] text-gray-400">
              {i % 2 === 0 ? d : ""}
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => {
          const firstReal = week.find((e) => e !== null);
          const showMonth =
            firstReal && (wi === 0 || firstReal.period.endsWith("-01"));
          const monthLabel = firstReal
            ? new Date(firstReal.period + "T12:00:00").toLocaleDateString("en-US", { month: "short" })
            : "";

          return (
            <div key={wi} className="flex flex-col gap-1">
              <div className="h-3 flex items-end justify-center">
                {showMonth && (
                  <span className="text-[9px] text-gray-400 leading-none">{monthLabel}</span>
                )}
              </div>
              {week.map((entry, di) => {
                if (!entry) {
                  return <div key={di} className="w-3 h-3 rounded-sm bg-transparent" />;
                }
                const isFuture = entry.period > today;
                const isToday = entry.period === today;
                const isMissed =
                  !isFuture && !isToday && !entry.done && !entry.vacation && !entry.graduated;
                const reflection = isMissed ? reflections[entry.period] : undefined;
                const color = isFuture
                  ? "bg-gray-100"
                  : entry.done
                  ? "bg-green-500"
                  : entry.vacation
                  ? "bg-sky-200"
                  : entry.graduated
                  ? "bg-gray-100"
                  : reflection
                  ? "bg-amber-300"
                  : "bg-gray-200";
                const label = new Date(entry.period + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "short", month: "short", day: "numeric",
                });
                const status = isFuture
                  ? ""
                  : entry.graduated
                  ? ` · 🎓 graduated`
                  : frequency === "weekly"
                  ? ""
                  : entry.done
                  ? ` · ✓`
                  : entry.vacation
                  ? ` · 🌴 vacation`
                  : isToday
                  ? ""
                  : ` · ✗ missed`;
                const retroHint = isMissed && onBackfill ? "\ntap to backfill" : "";
                const tooltipText = reflection
                  ? `${label}${status}\n"${reflection.length > 80 ? reflection.slice(0, 80) + "…" : reflection}"${retroHint}`
                  : `${label}${status}${retroHint}`;
                const clickable = isMissed && !!onBackfill;
                return (
                  <Tooltip key={di} text={tooltipText}>
                    <div
                      className={`w-3 h-3 rounded-sm ${color} transition-colors ${clickable ? "cursor-pointer hover:opacity-70 active:scale-90" : "cursor-default"}`}
                      onClick={() => clickable && onBackfill!(entry.period)}
                    />
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 mt-2 text-[10px] text-gray-400">
        <div className="w-3 h-3 rounded-sm bg-gray-200" />
        <span>missed</span>
        <div className="w-3 h-3 rounded-sm bg-amber-300" />
        <span>reflected</span>
        <div className="w-3 h-3 rounded-sm bg-sky-200" />
        <span>vacation</span>
        <div className="w-3 h-3 rounded-sm bg-green-500" />
        <span>done</span>
        {/* Only worth a swatch on a grid that actually has graduated days in it. */}
        {entries.some((e) => e.graduated) && (
          <>
            <div className="w-3 h-3 rounded-sm bg-gray-100 border border-gray-200" />
            <span>graduated</span>
          </>
        )}
      </div>
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <div className="text-xl font-bold text-gray-900">{value}</div>
      <div className="text-xs text-gray-400">{label}</div>
    </div>
  );
}

function GoalHistoryCard({
  goalHistory,
  onBackfill,
}: {
  goalHistory: GoalHistory;
  onBackfill: (goalId: string, period: string) => void;
}) {
  const { goal, entries, streak, reflections } = goalHistory;
  const today = getTodayPST();
  const doneCount = entries.filter((e) => e.done).length;
  // Days after graduation were never expected, so they'd only drag the completion rate down
  // for a habit the user was told to stop tracking.
  const totalPast = entries.filter((e) => e.period <= today && !e.graduated).length;
  const rate = totalPast > 0 ? Math.round((doneCount / totalPast) * 100) : 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-2xl">{goal.emoji}</span>
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-1.5">
            {goal.name}
            {goal.graduatedAt && (
              <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5">
                🎓 graduated
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-400">{goal.targetCount}x {goal.frequency}</p>
        </div>
      </div>

      <div className="flex justify-around mb-5 py-3 bg-gray-50 rounded-xl">
        <StatPill label="completion" value={`${rate}%`} />
        <div className="w-px bg-gray-200" />
        <StatPill label="check-ins" value={doneCount} />
        <div className="w-px bg-gray-200" />
        <StatPill label="streak" value={streak > 0 ? `🔥 ${streak}` : "—"} />
      </div>

      <DailyGrid
        entries={entries}
        frequency={goal.frequency}
        reflections={reflections}
        onBackfill={(period) => onBackfill(goal.id, period)}
      />
    </div>
  );
}

interface BackfillTarget {
  goalId: string;
  goalName: string;
  goalEmoji: string;
  period: string;
  reflection?: string;
}

export function HistoryPage({ userId }: { userId?: string }) {
  const [history, setHistory] = useState<GoalHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backfillTarget, setBackfillTarget] = useState<BackfillTarget | null>(null);
  const [backfillSaving, setRetroSaving] = useState(false);

  const q = userId ? `?user=${encodeURIComponent(userId)}` : "";

  const loadHistory = useCallback(() => {
    fetch(`/api/history${q}`)
      .then((r) => r.json())
      .then((data) => setHistory(data))
      .catch(() => setError("Couldn't load history."))
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleBackfill = (goalId: string, period: string) => {
    const gh = history.find((h) => h.goal.id === goalId);
    if (!gh) return;
    setBackfillTarget({
      goalId,
      period,
      goalName: gh.goal.name,
      goalEmoji: gh.goal.emoji,
      reflection: gh.reflections[period],
    });
  };

  const confirmBackfill = async () => {
    if (!backfillTarget) return;
    setRetroSaving(true);
    try {
      await fetch(`/api/checkins${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId: backfillTarget.goalId, date: backfillTarget.period }),
      });
      setBackfillTarget(null);
      setLoading(true);
      loadHistory();
    } finally {
      setRetroSaving(false);
    }
  };

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      <div className="flex items-center gap-3 mb-8">
        <h1 className="text-2xl font-bold text-gray-900">History</h1>
      </div>

      {loading && (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-52 animate-pulse" />
          ))}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-4">
          {history.map((gh) => (
            <GoalHistoryCard key={gh.goal.id} goalHistory={gh} onBackfill={handleBackfill} />
          ))}
        </div>
      )}

      {backfillTarget && (
        <BackfillModal
          period={backfillTarget.period}
          goalName={backfillTarget.goalName}
          goalEmoji={backfillTarget.goalEmoji}
          reflection={backfillTarget.reflection}
          onConfirm={confirmBackfill}
          onCancel={() => setBackfillTarget(null)}
          saving={backfillSaving}
        />
      )}
    </main>
  );
}
