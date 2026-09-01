"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { MoodEntry } from "@/lib/types";
import { MoodModal } from "@/app/components/MoodModal";

const PST = "America/Los_Angeles";

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: PST,
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: PST,
  });
}

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PST }).format(new Date());
}

interface DayGroup {
  date: string;
  entries: MoodEntry[];
}

function groupByDate(entries: MoodEntry[]): DayGroup[] {
  const map = new Map<string, MoodEntry[]>();
  for (const entry of entries) {
    if (!map.has(entry.date)) map.set(entry.date, []);
    map.get(entry.date)!.push(entry);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entries]) => ({ date, entries }));
}

export function MoodPage({ userId }: { userId?: string }) {
  const [groups, setGroups] = useState<DayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const today = getTodayPST();

  const q = userId ? `&user=${encodeURIComponent(userId)}` : "";

  const load = useCallback(() => {
    fetch(`/api/mood?date=all${q}`)
      .then((r) => r.json())
      .then((data: MoodEntry[]) => setGroups(groupByDate(data)))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async (emoji: string, text: string) => {
    setModalOpen(false);
    await fetch(`/api/mood${userId ? `?user=${encodeURIComponent(userId)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji, text }),
    });
    load();
  };

  const handleDelete = async (entry: MoodEntry) => {
    setDeletingId(entry.id);
    setConfirmId(null);
    const dq = userId ? `?user=${encodeURIComponent(userId)}` : "";
    await fetch(`/api/mood${dq}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id, date: entry.date }),
    });
    setDeletingId(null);
    setGroups((prev) =>
      prev
        .map((g) => ({ ...g, entries: g.entries.filter((e) => e.id !== entry.id) }))
        .filter((g) => g.entries.length > 0)
    );
  };

  return (
    <>
    <main className="max-w-md mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Mood Journal</h1>
        <button
          onClick={() => setModalOpen(true)}
          className="text-sm font-medium text-indigo-500 hover:text-indigo-700 underline"
        >
          + log emotion
        </button>
      </div>

      {loading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-28 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && groups.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">🧠</div>
          <p className="text-sm">No check-ins yet.</p>
          <p className="text-xs mt-1">Log your first emotion from the home screen.</p>
        </div>
      )}

      {!loading && groups.length > 0 && (
        <div className="space-y-6">
          {groups.map(({ date, entries }) => (
            <div key={date}>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                {date === today ? "Today" : formatDate(date)}
              </p>
              <div className="space-y-2">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3 flex items-start gap-3"
                  >
                    {/^[\x20-\x7E]+$/.test(entry.emoji) ? (
                      <span className="flex-shrink-0 mt-0.5 px-2 py-0.5 rounded-lg bg-indigo-50 text-indigo-600 text-xs font-medium leading-snug max-w-[80px] text-center">
                        {entry.emoji}
                      </span>
                    ) : (
                      <span className="text-3xl leading-none mt-0.5 flex-shrink-0">{entry.emoji}</span>
                    )}
                    <div className="flex-1 min-w-0">
                      {entry.text ? (
                        <p className="text-sm text-gray-800 leading-snug">{entry.text}</p>
                      ) : (
                        <p className="text-sm text-gray-400 italic">No note</p>
                      )}
                      <p className="text-[11px] text-gray-300 mt-1">{formatTime(entry.timestamp)}</p>
                    </div>
                    <div className="flex-shrink-0 flex items-center">
                      {confirmId === entry.id ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleDelete(entry)}
                            disabled={deletingId === entry.id}
                            className="text-xs text-red-500 hover:text-red-700 font-medium underline"
                          >
                            {deletingId === entry.id ? "…" : "delete"}
                          </button>
                          <button
                            onClick={() => setConfirmId(null)}
                            className="text-xs text-gray-400 hover:text-gray-600 underline"
                          >
                            cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmId(entry.id)}
                          className="text-gray-300 hover:text-gray-500 transition-colors p-1"
                          aria-label="Delete entry"
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193v-.443A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>

      {modalOpen && (
        <MoodModal onSubmit={handleSubmit} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
