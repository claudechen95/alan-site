import { getUsers, type UserRecord } from "@/lib/kv";
import AddUserForm from "./AddUserForm";
import DeleteUserButton from "./DeleteUserButton";
import EditPhoneForm from "./EditPhoneForm";

function resolveCheckinTopic(user: UserRecord) {
  const upper = user.id.toUpperCase();
  return (
    user.checkinTopic ??
    (user.id === "alan"
      ? process.env.NTFY_TOPIC
      : process.env[`NTFY_${upper}_TOPIC`]) ??
    null
  );
}

export default async function AdminPage() {
  const users = await getUsers();

  return (
    <main className="min-h-screen bg-[#f8f7f4] px-6 py-12 max-w-lg mx-auto">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-6">Admin</p>
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Users</h1>

      <div className="flex flex-col gap-3 mb-10">
        {users.map((user) => {
          const checkin = resolveCheckinTopic(user);
          return (
            <div key={user.id} className="bg-white rounded-2xl border border-gray-200 px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-gray-900">{user.label}</span>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-400 font-mono">/{user.id}</span>
                  <DeleteUserButton id={user.id} label={user.label} />
                </div>
              </div>
              <div className="space-y-1.5">
                <TopicRow label="Completions" topic={checkin} />
                <EditPhoneForm id={user.id} field="phone" label="Phone" value={user.phone ?? null} />
                <EditPhoneForm
                  id={user.id}
                  field="partnerPhone"
                  label="Partner"
                  value={user.partnerPhone ?? null}
                />
              </div>
            </div>
          );
        })}
      </div>

      <AddUserForm />
    </main>
  );
}

function TopicRow({ label, topic }: { label: string; topic: string | null }) {
  if (!topic) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-400 w-24 flex-shrink-0">{label}</span>
        <span className="text-red-400 text-xs">not set</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-400 w-24 flex-shrink-0">{label}</span>
      <a
        href={`https://ntfy.sh/${topic}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-indigo-600 hover:underline font-mono text-xs"
      >
        ntfy.sh/{topic}
      </a>
    </div>
  );
}
