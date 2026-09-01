"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { WeeklyNote } from "@/lib/types";

const PST = "America/Los_Angeles";

// ISO-8601 week key - must stay in step with getWeekKey in lib/kv.ts, which is what the notes
// API actually reads and writes. See the comment there for why ISO is the convention.
function getWeekKeyForDate(date: Date): string {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: PST })
    .format(date)
    .split("-")
    .map(Number);

  const thursday = new Date(Date.UTC(y, m - 1, d));
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const isoYear = thursday.getUTCFullYear();

  const week1Thursday = new Date(Date.UTC(isoYear, 0, 4));
  week1Thursday.setUTCDate(week1Thursday.getUTCDate() - ((week1Thursday.getUTCDay() + 6) % 7) + 3);

  const week = Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * 86400000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// Inverse of the above: week 1 is the week containing Jan 4, so its Monday is the Monday on or
// before Jan 4. Already ISO-correct - it was getWeekKeyForDate that disagreed with it.
function getMondayOfWeek(weekKey: string): Date {
  const [year, weekStr] = weekKey.split("-W");
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(parseInt(year), 0, 4);
  const daysToMonday = (jan4.getDay() + 6) % 7;
  const firstMonday = new Date(jan4);
  firstMonday.setDate(jan4.getDate() - daysToMonday);
  const monday = new Date(firstMonday);
  monday.setDate(firstMonday.getDate() + (week - 1) * 7);
  return monday;
}

function weekLabel(weekKey: string): string {
  const monday = getMondayOfWeek(weekKey);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

function recentWeekOptions(n = 6): { key: string; label: string; rel: string }[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const key = getWeekKeyForDate(d);
    const rel = i === 0 ? "This week" : i === 1 ? "Last week" : `${i} weeks ago`;
    return { key, label: weekLabel(key), rel };
  });
}

function NoteForm({
  initial,
  weekKey,
  userId,
  onSave,
  onCancel,
}: {
  initial?: WeeklyNote;
  weekKey: string;
  userId?: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [headline, setHeadline] = useState(initial?.headline ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const q = userId ? `?user=${encodeURIComponent(userId)}` : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/notes${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        week: weekKey,
        headline,
        notes,
        // The progress log was retired - new notes never add one. Existing notes keep theirs,
        // so editing one has to pass the old lines back through rather than blank them out.
        changes: initial?.changes ?? [],
      }),
    });
    setSaving(false);
    onSave();
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl border border-indigo-200 bg-white shadow-sm p-5 space-y-4">
      <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide">
        {weekLabel(weekKey)}
      </p>
      <input
        type="text"
        placeholder="Headline"
        value={headline}
        onChange={(e) => setHeadline(e.target.value)}
        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-gray-900 font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-300"
        required
        autoFocus
      />
      <textarea
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={6}
        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
      />
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saving}
          className="flex-1 bg-indigo-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : "Save note"}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
          Cancel
        </button>
      </div>
    </form>
  );
}

function WeekPicker({
  existingWeeks,
  onPick,
  onCancel,
}: {
  existingWeeks: Set<string>;
  onPick: (weekKey: string) => void;
  onCancel: () => void;
}) {
  const options = recentWeekOptions(6);
  return (
    <div className="rounded-2xl border border-indigo-200 bg-white shadow-sm p-5 space-y-3 mb-4">
      <p className="text-sm font-semibold text-gray-700">Which week are you writing about?</p>
      <div className="space-y-2">
        {options.map(({ key, label, rel }) => {
          const hasNote = existingWeeks.has(key);
          return (
            <button
              key={key}
              onClick={() => onPick(key)}
              className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors text-left"
            >
              <div>
                <span className="text-sm font-medium text-gray-800">{rel}</span>
                <span className="text-xs text-gray-400 ml-2">{label}</span>
              </div>
              {hasNote && (
                <span className="text-[10px] text-indigo-400 font-medium">has note</span>
              )}
            </button>
          );
        })}
      </div>
      <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600 underline w-full text-center pt-1">
        cancel
      </button>
    </div>
  );
}

function NoteCard({ note, onEdit }: { note: WeeklyNote; onEdit: () => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-2xl border border-gray-200 overflow-hidden transition-all duration-300 bg-white hover:border-indigo-200">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between text-left hover:bg-indigo-50/30 transition-colors"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center text-xl flex-shrink-0">
            📝
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-500">{note.weekLabel}</p>
            <p className="font-semibold text-gray-900 truncate">{note.headline}</p>
          </div>
        </div>
        <svg
          className={`w-5 h-5 text-gray-400 transition-transform duration-200 flex-shrink-0 ml-2 ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100">
          <div className="pt-3">
            {note.notes && (
              <p className="text-sm text-gray-700 mb-4 leading-relaxed">{note.notes}</p>
            )}
            {/* Retired - kept so notes written before the progress log was removed still render. */}
            {note.changes?.length > 0 && (
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">Progress Log</p>
                <ul className="space-y-2">
                  {note.changes.map((change, i) => (
                    <li key={i} className="text-sm text-gray-800 flex items-start gap-2">
                      <span className="text-indigo-500 mt-0.5">→</span>
                      <span>{change}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button
              onClick={onEdit}
              className="mt-3 text-xs text-gray-400 hover:text-gray-600 underline"
            >
              edit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function NotesPage({ userId }: { userId?: string }) {
  const [notes, setNotes] = useState<WeeklyNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingWeek, setEditingWeek] = useState<string | null>(null);
  const [pickingWeek, setPickingWeek] = useState(false);
  const [newWeekKey, setNewWeekKey] = useState<string | null>(null);

  const q = userId ? `?user=${encodeURIComponent(userId)}` : "";

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/notes${q}`)
      .then((r) => r.json())
      .then((data) => setNotes(data))
      .catch(() => setError("Couldn't load notes."))
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const existingWeeks = new Set(notes.map((n) => n.week));

  const handlePickWeek = (weekKey: string) => {
    setPickingWeek(false);
    if (existingWeeks.has(weekKey)) {
      setEditingWeek(weekKey);
    } else {
      setNewWeekKey(weekKey);
    }
  };

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Weekly Notes</h1>
        {!pickingWeek && !newWeekKey && (
          <button
            onClick={() => { setPickingWeek(true); setEditingWeek(null); }}
            className="text-sm text-indigo-500 hover:text-indigo-700 underline"
          >
            + new note
          </button>
        )}
      </div>

      {pickingWeek && (
        <WeekPicker
          existingWeeks={existingWeeks}
          onPick={handlePickWeek}
          onCancel={() => setPickingWeek(false)}
        />
      )}

      {newWeekKey && (
        <div className="mb-4">
          <NoteForm
            weekKey={newWeekKey}
            userId={userId}
            onSave={() => { setNewWeekKey(null); load(); }}
            onCancel={() => setNewWeekKey(null)}
          />
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-24 animate-pulse" />
          ))}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
      )}

      {!loading && !error && notes.length === 0 && (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">📝</div>
          <p className="text-gray-500">No weekly notes yet.</p>
          <p className="text-sm text-gray-400 mt-1">Tap “+ new note” to add your first reflection.</p>
        </div>
      )}

      {!loading && !error && notes.length > 0 && (
        <div className="space-y-3">
          {notes.map((note) =>
            editingWeek === note.week ? (
              <NoteForm
                key={note.week}
                initial={note}
                weekKey={note.week}
                userId={userId}
                onSave={() => { setEditingWeek(null); load(); }}
                onCancel={() => setEditingWeek(null)}
              />
            ) : (
              <NoteCard
                key={note.week}
                note={note}
                onEdit={() => { setEditingWeek(note.week); setNewWeekKey(null); setPickingWeek(false); }}
              />
            )
          )}
        </div>
      )}
    </main>
  );
}
