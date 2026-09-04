"use client";

import { useState } from "react";

// Edits one of the two numbers on a UserRecord: `phone` (where the nudge texts and the
// escalation call go) or `partnerPhone` (who hears about it when the ladder runs out). PATCH
// only touches the key it's given, so saving one never clears the other.
export default function EditPhoneForm({
  id,
  field,
  label,
  value: saved,
}: {
  id: string;
  field: "phone" | "partnerPhone";
  label: string;
  value: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(saved ?? "");
  const [loading, setLoading] = useState(false);

  async function handleSave() {
    setLoading(true);
    await fetch("/api/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, [field]: value.trim() }),
    });
    window.location.reload();
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-400 w-24 flex-shrink-0">{label}</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="+15551234567"
          className="flex-1 border border-gray-200 rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:border-gray-400"
        />
        <button
          onClick={handleSave}
          disabled={loading}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold disabled:opacity-50"
        >
          {loading ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-400 w-24 flex-shrink-0">{label}</span>
      {saved ? (
        <span className="text-xs font-mono text-gray-600">{saved}</span>
      ) : (
        // An unset partner number just means the ladder stops at the call, so it reads as
        // neutral rather than as the missing-config warning an unset own-number is.
        <span className={`text-xs ${field === "phone" ? "text-red-400" : "text-gray-300"}`}>not set</span>
      )}
      <button
        onClick={() => setEditing(true)}
        className="text-xs text-gray-300 hover:text-gray-500 transition-colors ml-1"
      >
        edit
      </button>
    </div>
  );
}
