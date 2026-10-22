// ============================================================
// app/page.tsx — Home page (tenant context + system health)
// ============================================================
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { HomeClient } from "@/components/home-client";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();

  if (!session || !session.user) {
    redirect("/login");
  }

  return <HomeClient session={session} />;
}
