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

interface TaskEvent {
  id: string;
  eventType: string;
  actor: string;
  at: string;
  details: unknown;
}

interface TaskDetail {
  task: {
    id: string;
    type: string;
    goal: string;
    status: string;
    progress: number;
    output: Record<string, unknown> | null;
    error: string | null;
    claimedBy: string | null;
    claimGeneration: number;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
  events: TaskEvent[];
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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

  const fetchTaskDetail = useCallback(async (taskId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/v1/tasks/${taskId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("فشل تحميل تفاصيل المهمة");
      const data = await res.json();
      setTaskDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطأ");
    } finally {
      setDetailLoading(false);
    }
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
      const result = await res.json();
      setNewGoal("");
      setShowCreate(false);
      await fetchTasks();
      // Auto-select the newly created task
      if (result.taskId) {
        setSelectedTaskId(result.taskId);
        fetchTaskDetail(result.taskId);
      }
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

  const handleTaskClick = (taskId: string) => {
    setSelectedTaskId(taskId);
    fetchTaskDetail(taskId);
  };

  const handleCloseDetail = () => {
    setSelectedTaskId(null);
    setTaskDetail(null);
  };

  const statusColors: Record<string, string> = {
    pending: "bg-gray-100 text-gray-600",
    claimed: "bg-blue-50 text-blue-600",
    running: "bg-yellow-50 text-yellow-600",
    completed: "bg-green-50 text-green-600",
    failed: "bg-red-50 text-red-600",
    abandoned: "bg-gray-100 text-gray-500",
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    try {
      return new Date(dateStr).toLocaleString("ar");
    } catch {
      return dateStr;
    }
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
          <form onSubmit={handleCreate} className="mb-6 bg-white rounded-xl border border-gray-200 p-6 space-y-4" data-testid="create-task-form">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">الهدف</label>
              <input
                type="text"
                value={newGoal}
                onChange={(e) => setNewGoal(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-lg border border-gray-300 outline-none focus:border-blue-400"
                placeholder="مثال: تحليل المؤشرات الاقتصادية للربع الثالث"
                data-testid="task-goal-input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">النوع</label>
              <select value={newType} onChange={(e) => setNewType(e.target.value)} className="w-full px-4 py-2.5 rounded-lg border border-gray-300 outline-none" data-testid="task-type-select">
                <option value="analysis">تحليل</option>
                <option value="research">بحث</option>
                <option value="report">تقرير</option>
                <option value="general">عام</option>
              </select>
            </div>
            <button type="submit" disabled={creating} className="px-6 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50" data-testid="task-create-button">
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
              <div
                key={task.id}
                onClick={() => handleTaskClick(task.id)}
                className={`bg-white rounded-xl border p-4 cursor-pointer hover:border-blue-300 transition ${
                  selectedTaskId === task.id ? "border-blue-400 ring-1 ring-blue-200" : "border-gray-200"
                }`}
                data-testid={`task-card-${task.id}`}
              >
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

        {/* Task Detail Panel */}
        {selectedTaskId && (
          <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50" onClick={handleCloseDetail}>
            <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()} data-testid="task-detail-panel">
              {detailLoading ? (
                <div className="flex items-center gap-2 text-gray-400 text-sm py-8 justify-center">
                  <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                  جارٍ تحميل التفاصيل...
                </div>
              ) : taskDetail ? (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-bold text-gray-900">تفاصيل المهمة</h2>
                    <button onClick={handleCloseDetail} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
                  </div>

                  <div className="space-y-3 text-sm">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-gray-400 mb-1">الهدف</p>
                        <p className="text-gray-800">{taskDetail.task.goal}</p>
                      </div>
                      <div>
                        <p className="text-gray-400 mb-1">النوع</p>
                        <p className="text-gray-800 font-mono">{taskDetail.task.type}</p>
                      </div>
                      <div>
                        <p className="text-gray-400 mb-1">الحالة</p>
                        <span className={`text-xs font-medium px-2 py-1 rounded ${statusColors[taskDetail.task.status] || "bg-gray-100"}`}>
                          {taskDetail.task.status}
                        </span>
                      </div>
                      <div>
                        <p className="text-gray-400 mb-1">التقدم</p>
                        <p className="text-gray-800">{taskDetail.task.progress}%</p>
                      </div>
                      <div>
                        <p className="text-gray-400 mb-1">أنشئت في</p>
                        <p className="text-gray-800">{formatDate(taskDetail.task.createdAt)}</p>
                      </div>
                      <div>
                        <p className="text-gray-400 mb-1">اكتملت في</p>
                        <p className="text-gray-800">{formatDate(taskDetail.task.completedAt)}</p>
                      </div>
                    </div>

                    {taskDetail.task.error && (
                      <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
                        <strong>خطأ:</strong> {taskDetail.task.error}
                      </div>
                    )}

                    {taskDetail.task.output !== null && (
                      <div>
                        <p className="text-gray-400 mb-1">النتيجة</p>
                        <pre className="p-3 rounded-lg bg-gray-50 border border-gray-200 text-xs overflow-x-auto text-gray-700" dir="ltr">
                          {JSON.stringify(taskDetail.task.output, null, 2)}
                        </pre>
                        {taskDetail.task.output?.simulated === true && (
                          <p className="text-xs text-amber-600 mt-1">⚠ هذه النتيجة محاكاة (Stub)، وليست تحليلاً حقيقياً.</p>
                        )}
                      </div>
                    )}

                    <div>
                      <p className="text-gray-400 mb-2">سجل الأحداث ({taskDetail.events.length})</p>
                      <div className="space-y-2">
                        {taskDetail.events.map((ev) => (
                          <div key={ev.id} className="flex items-start gap-3 p-2 rounded bg-gray-50 text-xs">
                            <span className="font-mono text-gray-500 whitespace-nowrap">{formatDate(ev.at)}</span>
                            <div>
                              <span className="font-medium text-gray-700">{ev.eventType}</span>
                              <span className="text-gray-400 mr-2">· {ev.actor}</span>
                            </div>
                          </div>
                        ))}
                        {taskDetail.events.length === 0 && (
                          <p className="text-gray-400 text-xs">لا توجد أحداث</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-gray-400 text-center py-8">فشل تحميل التفاصيل</p>
              )}
            </div>
          </div>
        )}

        <div className="mt-8 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs">
          تنبيه: مزود الـLLM الحالي هو Stub (محاكاة). نتائج تنفيذ المهام محاكاة وليست تحليلاً حقيقياً.
        </div>
      </main>
    </div>
  );
}
