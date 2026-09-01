"use client";

import React, { useEffect, useRef, useState } from "react";
import type { CoachMessage } from "@/lib/kv";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, matches the server-side cap
const ACCEPT = ".txt,.md,text/plain,text/markdown,image/png,image/jpeg,image/gif,image/webp,application/pdf";

interface PendingAttachment {
  id: string;
  kind: "text" | "image" | "pdf";
  filename: string;
  content?: string; // text
  mediaType?: string; // image
  data?: string; // base64, image/pdf
  previewUrl?: string; // image thumbnail
}

function readFile(file: File): Promise<PendingAttachment | null> {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reader = new FileReader();

    if (file.type === "application/pdf") {
      reader.onload = () => {
        const data = (reader.result as string).split(",")[1] ?? "";
        resolve({ id, kind: "pdf", filename: file.name, data });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } else if (file.type.startsWith("image/")) {
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const data = dataUrl.split(",")[1] ?? "";
        resolve({ id, kind: "image", filename: file.name, mediaType: file.type, data, previewUrl: dataUrl });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve({ id, kind: "text", filename: file.name, content: reader.result as string });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    }
  });
}

function appendedTextFor(attachments: PendingAttachment[]): string {
  return attachments
    .map((a) => {
      if (a.kind === "text") return `\n\n--- ${a.filename} ---\n${a.content ?? ""}`;
      if (a.kind === "image") return `\n\n[Attached image: ${a.filename}]`;
      return `\n\n[Attached PDF: ${a.filename}]`;
    })
    .join("");
}

// The coach's replies lean on **bold** for emphasis; render it rather than showing literal asterisks.
function renderBold(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    )
  );
}

export function CoachPage({ userId }: { userId?: string }) {
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const q = userId ? `?user=${encodeURIComponent(userId)}` : "";

  useEffect(() => {
    fetch(`/api/coach${q}`)
      .then((r) => r.json())
      .then((data: CoachMessage[]) => setMessages(data))
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files) return;
    setAttachError(null);
    const oversized = Array.from(files).some((f) => f.size > MAX_FILE_BYTES);
    if (oversized) setAttachError("One or more files are over 10MB and were skipped.");

    const read = await Promise.all(
      Array.from(files)
        .filter((f) => f.size <= MAX_FILE_BYTES)
        .map(readFile)
    );
    setAttachments((prev) => [...prev, ...read.filter((a): a is PendingAttachment => a !== null)]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending) return;

    const currentAttachments = attachments;
    const displayText = text + appendedTextFor(currentAttachments);

    setInput("");
    setAttachments([]);
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", text: displayText, timestamp: Date.now() },
    ]);
    setStreamingText("");

    try {
      const res = await fetch(`/api/coach${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text || "(see attached)",
          attachments: currentAttachments.map((a) => ({
            kind: a.kind,
            filename: a.filename,
            content: a.content,
            mediaType: a.mediaType,
            data: a.data,
          })),
        }),
      });
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setStreamingText(acc);
      }

      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}-reply`, role: "assistant", text: acc, timestamp: Date.now() },
      ]);
      setStreamingText(null);
    } catch {
      setStreamingText(null);
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}-error`,
          role: "assistant",
          text: "Something went wrong reaching the coach. Try again in a moment.",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="max-w-md mx-auto px-4 py-10 flex flex-col" style={{ minHeight: "calc(100vh - 5rem)" }}>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Coach</h1>

      <div className="flex-1 space-y-3 mb-4">
        {loading && (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="rounded-2xl bg-white border border-gray-200 p-4 h-16 animate-pulse" />
            ))}
          </div>
        )}

        {!loading && messages.length === 0 && !streamingText && (
          <div className="text-center py-16 text-gray-400">
            <div className="text-4xl mb-3">🎙️</div>
            <p className="text-sm">Ask the coach anything.</p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-snug whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-indigo-500 text-white"
                  : "bg-white border border-gray-100 shadow-sm text-gray-800"
              }`}
            >
              {renderBold(m.text)}
            </div>
          </div>
        ))}

        {streamingText !== null && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-snug whitespace-pre-wrap bg-white border border-gray-100 shadow-sm text-gray-800">
              {streamingText ? renderBold(streamingText) : (
                <span className="inline-flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" />
                </span>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-20 bg-[#f8f7f4] pt-2">
        {attachError && <p className="text-xs text-red-500 mb-1.5 px-1">{attachError}</p>}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1.5 rounded-full bg-white border border-gray-200 pl-2 pr-1 py-1 text-xs text-gray-600"
              >
                {a.previewUrl ? (
                  // A 16px chip for a base64 data URL the browser already holds in memory -
                  // there's no network fetch to optimize, and next/image can't optimize a data
                  // URL anyway (it would need unoptimized, i.e. this same <img> with more steps).
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.previewUrl} alt="" className="w-4 h-4 rounded object-cover" />
                ) : (
                  <span>{a.kind === "pdf" ? "📄" : "📎"}</span>
                )}
                <span className="max-w-[120px] truncate">{a.filename}</span>
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="text-gray-400 hover:text-gray-600 px-1"
                  aria-label={`Remove ${a.filename}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => handleFilesSelected(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            aria-label="Attach a file"
            className="flex-shrink-0 w-10 h-10 rounded-full border border-gray-200 bg-white flex items-center justify-center text-gray-500 hover:text-indigo-600 hover:border-indigo-300 disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
            </svg>
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Ask the coach..."
            disabled={sending}
            className="flex-1 rounded-full border border-gray-200 bg-white px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-60"
          />
          <button
            onClick={handleSend}
            disabled={sending || (!input.trim() && attachments.length === 0)}
            className="rounded-full bg-indigo-500 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </main>
  );
}
