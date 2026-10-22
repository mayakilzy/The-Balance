"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "next-auth";

export function HomeClient({ session }: { session: Session }) {
  const router = useRouter();
  const [health, setHealth] = useState<{ status: string; checks: Array<{ name: string; status: string; detail?: string }> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/health", { cache: "no-store", signal });
      const data = await res.json();
      setHealth(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "فشل تحميل حالة النظام");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const doFetch = () => fetchHealth(controller.signal);
    doFetch();
    const id = setInterval(doFetch, 15000);
    return () => { controller.abort(); clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    await fetch("/api/v1/auth/signout", { method: "POST" });
    router.push("/login");
  };

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">الميزان</h1>
            <p className="text-sm text-gray-500">منصة ذكاء الدولة</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-sm text-left">
              <p className="font-medium text-gray-700">{session.user.name}</p>
              <p className="text-gray-400">{session.user.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="text-sm px-4 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition"
            >
              تسجيل الخروج
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <section className="mb-8 bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">سياق المستأجر</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-gray-400 mb-1">المستأجر</p>
              <p className="font-mono text-gray-700">{session.user.tenantId ?? "غير محدد"}</p>
            </div>
            <div>
              <p className="text-gray-400 mb-1">الدور</p>
              <p className="font-mono text-gray-700">{session.user.roleCode ?? "غير محدد"}</p>
            </div>
            <div>
              <p className="text-gray-400 mb-1">حالة العضوية</p>
              <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                session.user.membershipStatus === "active"
                  ? "bg-green-50 text-green-700"
                  : "bg-red-50 text-red-700"
              }`}>
                {session.user.membershipStatus === "active" ? "نشط" : session.user.membershipStatus ?? "غير معروف"}
              </span>
            </div>
            <div>
              <p className="text-gray-400 mb-1">المستخدم</p>
              <p className="font-mono text-gray-700 text-xs">{session.user.id.slice(0, 16)}...</p>
            </div>
          </div>
        </section>

        <section className="mb-8 bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">حالة النظام</h2>
          {loading ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm">
              <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
              جارٍ التحميل...
            </div>
          ) : error ? (
            <div className="text-red-600 text-sm bg-red-50 rounded-lg p-3">{error}</div>
          ) : health ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {health.checks.map((check) => (
                <div key={check.name} className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
                  <span className="font-mono text-sm text-gray-600">{check.name}</span>
                  <span className={`text-xs font-medium px-2 py-1 rounded ${
                    check.status === "ok" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>
                    {check.status === "ok" ? "يعمل" : "متوقف"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <a href="/tasks" className="block bg-white rounded-xl border border-gray-200 p-5 hover:border-blue-300 hover:shadow-sm transition">
            <div className="text-3xl mb-2">📋</div>
            <h3 className="font-semibold text-gray-800 mb-1">المهام</h3>
            <p className="text-sm text-gray-400">إنشاء ومتابعة المهام</p>
          </a>
          <a href="/evidence" className="block bg-white rounded-xl border border-gray-200 p-5 hover:border-blue-300 hover:shadow-sm transition">
            <div className="text-3xl mb-2">🔬</div>
            <h3 className="font-semibold text-gray-800 mb-1">الأدلة</h3>
            <p className="text-sm text-gray-400">إدارة الأدلة العلمية</p>
          </a>
          <a href="/capabilities" className="block bg-white rounded-xl border border-gray-200 p-5 hover:border-blue-300 hover:shadow-sm transition">
            <div className="text-3xl mb-2">🔧</div>
            <h3 className="font-semibold text-gray-800 mb-1">القدرات</h3>
            <p className="text-sm text-gray-400">سجل الأدوات والخبراء</p>
          </a>
          <a href="/strategies" className="block bg-white rounded-xl border border-gray-200 p-5 hover:border-blue-300 hover:shadow-sm transition">
            <div className="text-3xl mb-2">📐</div>
            <h3 className="font-semibold text-gray-800 mb-1">الاستراتيجيات</h3>
            <p className="text-sm text-gray-400">الخطط والقرارات</p>
          </a>
        </section>

        <div className="mt-8 p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          <strong>تنبيه:</strong> مزود الذكاء الاصطناعي الحالي هو Stub (محاكاة).
          جميع نتائج Balance Master والـAdapters هي محاكاة، وليست توصيات حكومية حقيقية.
        </div>
      </main>
    </div>
  );
}
