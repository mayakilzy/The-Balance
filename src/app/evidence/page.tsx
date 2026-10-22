"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

interface EvidenceItem {
  id: string;
  claim: string;
  summary?: string | null;
  type: string;
  verificationStatus: string;
  source?: { code: string; displayName: string; type: string } | null;
  relatedEvidenceId?: string | null;
}

export default function EvidencePage() {
  const router = useRouter();
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEvidence = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/evidence", { cache: "no-store" });
      if (res.status === 401) { router.push("/login"); return; }
      if (res.status === 403) { setError("غير مصرح"); return; }
      const data = await res.json();
      setEvidence(data.evidence || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل تحميل الأدلة");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const f = () => fetchEvidence();
    f();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    await fetch("/api/v1/auth/signout", { method: "POST" });
    router.push("/login");
  };

  const statusColors: Record<string, string> = {
    unverified: "bg-gray-100 text-gray-600",
    verified: "bg-green-50 text-green-600",
    disputed: "bg-yellow-50 text-yellow-600",
    refuted: "bg-red-50 text-red-600",
  };

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-gray-400 hover:text-gray-600 text-sm">← الرئيسية</a>
            <h1 className="text-xl font-bold text-gray-900">الأدلة</h1>
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
        ) : evidence.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-lg mb-2">لا توجد أدلة</p>
          </div>
        ) : (
          <div className="space-y-3">
            {evidence.map((ev, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-start justify-between mb-2">
                  <p className="font-medium text-gray-800">{ev.claim}</p>
                  <span className={`text-xs font-medium px-2 py-1 rounded ${statusColors[ev.verificationStatus] || "bg-gray-100"}`}>
                    {ev.verificationStatus}
                  </span>
                </div>
                {ev.summary && <p className="text-sm text-gray-500 mb-2">{ev.summary}</p>}
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span>{ev.type}</span>
                  {ev.source && <span>· {ev.source.displayName}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
