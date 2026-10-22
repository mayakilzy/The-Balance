"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function StrategiesPage() {
  const router = useRouter();

  useEffect(() => {
    // Redirect to home for now — strategies page will be built in GROUP 01
    router.push("/");
  }, [router]);

  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-400">جارٍ التحويل...</p>
    </div>
  );
}
