"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { JournalEntry } from "@/lib/kv";

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AddEntryModal({
  onSave,
  onClose,
}: {
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!text.trim()) return;
    setSaving(true);
    await onSave(text.trim());
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="w-full max-w-md bg-white rounded-3xl p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">New reflection</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>
        <p className="text-sm text-gray-500 mb-3">What’s on your mind?</p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write anything — a thought, an observation, how you're feeling..."
          className="w-full rounded-xl border border-gray-200 p-3 text-sm text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300"
          rows={5}
        />
        <button
          onClick={handleSave}
          disabled={!text.trim() || saving}
          className="mt-3 w-full bg-indigo-600 text-white font-semibold rounded-xl py-3 disabled:opacity-40 transition"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

export function ReflectionsPage({ userId }: { userId?: string }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const q = userId && userId !== "alan" ? `?user=${userId}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/journal${q}`);
    if (res.ok) setEntries(await res.json());
    setLoading(false);
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (text: string) => {
    await fetch(`/api/journal${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setShowModal(false);
    await load();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/journal${q}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  return (
    <div className="min-h-screen bg-[#f8f7f4] pb-24">
      <div className="max-w-md mx-auto px-4 pt-10">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Reflections</h1>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1.5 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-sm"
          >
            <span className="text-lg leading-none">+</span> Add
          </button>
        </div>

        {loading ? (
          <div className="text-center text-gray-400 mt-20 text-sm">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-center text-gray-400 mt-20">
            <p className="text-4xl mb-3">📝</p>
            <p className="text-sm">No reflections yet.</p>
            <p className="text-sm">Tap <strong>Add</strong> to write your first one.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <div key={entry.id} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
                <p className="text-sm text-gray-900 whitespace-pre-wrap">{entry.text}</p>
                <div className="flex items-center justify-between mt-3">
                  <span className="text-xs text-gray-400">{formatTimestamp(entry.timestamp)}</span>
                  <button
                    onClick={() => handleDelete(entry.id)}
                    className="text-xs text-gray-300 hover:text-red-400 transition"
                  >
                    delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <AddEntryModal onSave={handleSave} onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}
