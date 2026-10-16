"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

interface Capability {
  id: string;
  code: string;
  displayName: string;
  description: string;
  type: string;
  readiness: string;
  requiredPermission: string;
  domains: string[];
}

export default function CapabilitiesPage() {
  const router = useRouter();
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCapabilities = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/capabilities", { cache: "no-store" });
      if (res.status === 401) { router.push("/login"); return; }
      const data = await res.json();
      setCapabilities(data.capabilities || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل تحميل القدرات");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const f = () => fetchCapabilities();
    f();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    await fetch("/api/v1/auth/signout", { method: "POST" });
    router.push("/login");
  };

  const readinessColors: Record<string, string> = {
    stub: "bg-gray-100 text-gray-600",
    mock: "bg-yellow-50 text-yellow-600",
    live: "bg-green-50 text-green-600",
    untested: "bg-red-50 text-red-600",
  };

  const readinessLabels: Record<string, string> = {
    stub: "محاكاة (Stub)",
    mock: "محاكاة (Mock)",
    live: "حي",
    untested: "غير مُختبَر",
  };

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-gray-400 hover:text-gray-600 text-sm">← الرئيسية</a>
            <h1 className="text-xl font-bold text-gray-900">القدرات</h1>
          </div>
          <button onClick={handleLogout} className="text-sm px-4 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">خروج</button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
            جارٍ التحميل...
          </div>
        ) : error ? (
          <div className="text-red-600 text-sm bg-red-50 rounded-lg p-3">{error}</div>
        ) : capabilities.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-lg mb-2">لا توجد قدرات مسجلة</p>
          </div>
        ) : (
          <div className="space-y-3">
            {capabilities.map((cap, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-medium text-gray-800">{cap.displayName}</p>
                    <p className="text-xs text-gray-400 font-mono mt-1">{cap.code}</p>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-xs font-medium px-2 py-1 rounded bg-blue-50 text-blue-600">{cap.type}</span>
                    <span className={`text-xs font-medium px-2 py-1 rounded ${readinessColors[cap.readiness] || "bg-gray-100"}`}>
                      {readinessLabels[cap.readiness] || cap.readiness}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-gray-500 mb-2">{cap.description}</p>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span>الصلاحية: {cap.requiredPermission}</span>
                  {cap.domains && cap.domains.length > 0 && (
                    <span>· المجالات: {cap.domains.join(", ")}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
