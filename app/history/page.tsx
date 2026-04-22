"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { Goal } from "@/lib/types";

const PST = "America/Los_Angeles";

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PST }).format(new Date());
}

interface HistoryEntry {
  period: string;
  count: number;
  done: boolean;
}

interface GoalHistory {
  goal: Goal;
  entries: HistoryEntry[];
  streak: number;
}

// --- Tooltip ---
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="relative group">
      {children}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-10 pointer-events-none">
        <div className="bg-gray-900 text-white text-[10px] rounded px-2 py-1 whitespace-nowrap">
          {text}
        </div>
      </div>
    </div>
  );
}

// --- Daily calendar grid (13 weeks × 7 days) ---
function DailyGrid({ entries, frequency }: { entries: HistoryEntry[]; frequency: "daily" | "weekly" }) {
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
                const color = isFuture
                  ? "bg-gray-100"
                  : entry.done
                  ? "bg-green-500"
                  : "bg-gray-200";
                const label = new Date(entry.period + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "short", month: "short", day: "numeric",
                });
                const status = isFuture || frequency === "weekly" ? "" : entry.done ? ` · ✓` : isToday ? "" : ` · ✗ missed`;
                return (
                  <Tooltip key={di} text={`${label}${status}`}>
                    <div className={`w-3 h-3 rounded-sm ${color} transition-colors cursor-default`} />
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 mt-2 text-[10px] text-gray-400">
        <span>Less</span>
        <div className="w-3 h-3 rounded-sm bg-gray-200" />
        <div className="w-3 h-3 rounded-sm bg-green-300" />
        <div className="w-3 h-3 rounded-sm bg-green-500" />
        <span>More</span>
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

function GoalHistoryCard({ goalHistory }: { goalHistory: GoalHistory }) {
  const { goal, entries, streak } = goalHistory;
  const today = getTodayPST();
  const doneCount = entries.filter((e) => e.done).length;
  const totalPast = entries.filter((e) => e.period <= today).length;
  const rate = totalPast > 0 ? Math.round((doneCount / totalPast) * 100) : 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-2xl">{goal.emoji}</span>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{goal.name}</h2>
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

      <DailyGrid entries={entries} frequency={goal.frequency} />
    </div>
  );
}

export default function HistoryPage() {
  const [history, setHistory] = useState<GoalHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((data) => setHistory(data))
      .catch(() => setError("Couldn't load history."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      <div className="flex items-center gap-3 mb-8">
        <Link
          href="/"
          className="text-gray-400 hover:text-gray-700 transition-colors"
        >
          ← back
        </Link>
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
            <GoalHistoryCard key={gh.goal.id} goalHistory={gh} />
          ))}
        </div>
      )}
    </main>
  );
}
