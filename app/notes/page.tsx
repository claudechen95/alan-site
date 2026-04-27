"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { WeeklyNote } from "@/lib/types";

function getWeekKey(offsetWeeks = 0): string {
  const now = new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  pst.setDate(pst.getDate() - offsetWeeks * 7);
  const y = pst.getFullYear();
  const jan4 = new Date(y, 0, 4);
  const daysDiff = Math.floor((pst.getTime() - jan4.getTime()) / 86400000);
  const week = Math.ceil((daysDiff + jan4.getDay() + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

// --- Note Form ---
function NoteForm({
  initial,
  weekKey,
  onSave,
  onCancel,
}: {
  initial?: WeeklyNote;
  weekKey: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [headline, setHeadline] = useState(initial?.headline ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [changes, setChanges] = useState<string[]>(initial?.changes ?? [""]);
  const [saving, setSaving] = useState(false);

  const updateChange = (i: number, val: string) => {
    const next = [...changes];
    next[i] = val;
    setChanges(next);
  };

  const removeChange = (i: number) => setChanges(changes.filter((_, idx) => idx !== i));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        week: weekKey,
        headline,
        notes,
        changes: changes.filter((c) => c.trim()),
      }),
    });
    setSaving(false);
    onSave();
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl border border-indigo-200 bg-white shadow-sm p-5 space-y-4">
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
        rows={3}
        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
      />
      <div className="space-y-2">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Progress Log</p>
        {changes.map((c, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="text"
              value={c}
              onChange={(e) => updateChange(i, e.target.value)}
              placeholder="e.g. ✅ Completed protein goal"
              className="flex-1 border border-gray-200 rounded-xl px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
            {changes.length > 1 && (
              <button type="button" onClick={() => removeChange(i)} className="text-gray-300 hover:text-red-400 text-lg leading-none">×</button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setChanges([...changes, ""])}
          className="text-xs text-indigo-400 hover:text-indigo-600 underline"
        >
          + add line
        </button>
      </div>
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

// --- Expandable Note Card ---
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
            {note.changes.length > 0 && (
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

export default function NotesPage() {
  const [notes, setNotes] = useState<WeeklyNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingWeek, setEditingWeek] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  const load = () => {
    setLoading(true);
    fetch("/api/notes")
      .then((r) => r.json())
      .then((data) => setNotes(data))
      .catch(() => setError("Couldn't load notes."))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const currentWeek = getWeekKey();

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-gray-400 hover:text-gray-700 transition-colors">
            ← back
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">Weekly Notes</h1>
        </div>
        {!addingNew && (
          <button
            onClick={() => { setAddingNew(true); setEditingWeek(null); }}
            className="text-sm text-indigo-500 hover:text-indigo-700 underline"
          >
            + new note
          </button>
        )}
      </div>

      {addingNew && (
        <div className="mb-4">
          <NoteForm
            weekKey={currentWeek}
            onSave={() => { setAddingNew(false); load(); }}
            onCancel={() => setAddingNew(false)}
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
          <p className="text-sm text-gray-400 mt-1">Notes will appear here after your weekly sync.</p>
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
                onSave={() => { setEditingWeek(null); load(); }}
                onCancel={() => setEditingWeek(null)}
              />
            ) : (
              <NoteCard
                key={note.week}
                note={note}
                onEdit={() => { setEditingWeek(note.week); setAddingNew(false); }}
              />
            )
          )}
        </div>
      )}
    </main>
  );
}
