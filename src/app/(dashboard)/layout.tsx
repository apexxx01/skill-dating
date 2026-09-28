import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard - Skill Dating",
  description: "Your builder dashboard - track progress, discover opportunities, and collaborate",
};

export default async function DashboardLayoutWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/dashboard");
  }

  return <DashboardLayout>{children}</DashboardLayout>;
}