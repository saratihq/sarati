"use client";

import Link from "next/link";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { SaratiSquircle } from "@/components/SaratiLogo";

export default function NotFound() {
  useDocumentTitle("Page not found");
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-3 px-4 text-center"
      style={{ background: "var(--orchestr-surface)" }}
    >
      <SaratiSquircle size={48} />
      <h1 className="text-xl font-semibold m-0 mt-2" style={{ color: "var(--orchestr-ink)" }}>
        Page not found
      </h1>
      <p className="text-sm m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
        This page doesn&apos;t exist. It may have been deleted, or the link is wrong.
      </p>
      <Link href="/" className="text-sm hover:underline mt-2" style={{ color: "var(--orchestr-ink)" }}>
        Back to dashboard
      </Link>
    </div>
  );
}
