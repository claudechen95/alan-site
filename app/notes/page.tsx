"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { WeeklyNote } from "@/lib/types";

// --- Expandable Note Card ---
function NoteCard({ note }: { note: WeeklyNote }) {
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
          className={`w-5 h-5 text-gray-400 transition-transform duration-200 flex-shrink-0 ml-2 ${expanded ? 'rotate-180' : ''}`}
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

  useEffect(() => {
    fetch("/api/notes")
      .then((r) => r.json())
      .then((data) => setNotes(data))
      .catch(() => setError("Couldn't load notes."))
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
        <h1 className="text-2xl font-bold text-gray-900">Weekly Notes</h1>
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-24 animate-pulse" />
          ))}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
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
          {notes.map((note) => (
            <NoteCard key={note.week} note={note} />
          ))}
        </div>
      )}
    </main>
  );
}
