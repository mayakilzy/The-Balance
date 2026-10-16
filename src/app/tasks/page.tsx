"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

interface Task {
  id: string;
  type: string;
  goal: string;
  status: string;
  progress: number;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export default function TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newGoal, setNewGoal] = useState("");
  const [newType, setNewType] = useState("analysis");
  const [creating, setCreating] = useState(false);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/tasks", { cache: "no-store" });
      if (res.status === 401) { router.push("/login"); return; }
      if (res.status === 403) { setError("غير مصرح"); return; }
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل تحميل المهام");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const doFetch = () => fetchTasks();
    doFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/v1/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newType, goal: newGoal }),
      });
      if (!res.ok) throw new Error("فشل إنشاء المهمة");
      setNewGoal("");
      setShowCreate(false);
      fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطأ");
    } finally {
      setCreating(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/v1/auth/signout", { method: "POST" });
    router.push("/login");
  };

  const statusColors: Record<string, string> = {
    pending: "bg-gray-100 text-gray-600",
    claimed: "bg-blue-50 text-blue-600",
    running: "bg-yellow-50 text-yellow-600",
    completed: "bg-green-50 text-green-600",
    failed: "bg-red-50 text-red-600",
    abandoned: "bg-gray-100 text-gray-500",
  };

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-gray-400 hover:text-gray-600 text-sm">← الرئيسية</a>
            <h1 className="text-xl font-bold text-gray-900">المهام</h1>
          </div>
          <button onClick={handleLogout} className="text-sm px-4 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">خروج</button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <p className="text-sm text-gray-500">{tasks.length} مهمة</p>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800"
          >
            {showCreate ? "إلغاء" : "+ مهمة جديدة"}
          </button>
        </div>

        {showCreate && (
          <form onSubmit={handleCreate} className="mb-6 bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">الهدف</label>
              <input
                type="text"
                value={newGoal}
                onChange={(e) => setNewGoal(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-lg border border-gray-300 outline-none focus:border-blue-400"
                placeholder="مثال: تحليل المؤشرات الاقتصادية للربع الثالث"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">النوع</label>
              <select value={newType} onChange={(e) => setNewType(e.target.value)} className="w-full px-4 py-2.5 rounded-lg border border-gray-300 outline-none">
                <option value="analysis">تحليل</option>
                <option value="research">بحث</option>
                <option value="report">تقرير</option>
                <option value="general">عام</option>
              </select>
            </div>
            <button type="submit" disabled={creating} className="px-6 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50">
              {creating ? "جارٍ الإنشاء..." : "إنشاء"}
            </button>
          </form>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
            جارٍ التحميل...
          </div>
        ) : error ? (
          <div className="text-red-600 text-sm bg-red-50 rounded-lg p-3">{error}</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-lg mb-2">لا توجد مهام</p>
            <p className="text-sm">أنشئ مهمة جديدة للبدء</p>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <div key={task.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-medium text-gray-800">{task.goal}</p>
                    <p className="text-xs text-gray-400 mt-1 font-mono">{task.type} · {task.id.slice(0, 16)}...</p>
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded ${statusColors[task.status] || "bg-gray-100 text-gray-500"}`}>
                    {task.status}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${task.progress}%` }} />
                  </div>
                  <span className="text-xs text-gray-400">{task.progress}%</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs">
          تنبيه: مزود الـLLM الحالي هو Stub (محاكاة). نتائج تنفيذ المهام محاكاة وليست تحليلاً حقيقياً.
        </div>
      </main>
    </div>
  );
}
