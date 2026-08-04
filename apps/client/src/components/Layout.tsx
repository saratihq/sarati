"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { LogOut, Settings, ChevronDown } from "lucide-react";
import * as api from "@/api/client";
import { useWorkflow } from "@/store/useWorkflow";
import { useAuth } from "@/store/useAuth";
import { useOrgs } from "@/store/useOrgs";
import { OrgMenuSection, CreateOrgModal } from "@/components/OrgSwitcher";
import { SaratiLockup } from "@/components/SaratiLogo";
import Dashboard from "@/components/Dashboard";
import ApprovalsNavButton from "@/components/ApprovalsNavButton";

interface LayoutProps {
  children?: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const goToDashboard = useWorkflow((s) => s.goToDashboard);
  const user = useAuth((s) => s.user);
  const clearProfile = useAuth((s) => s.clearProfile);
  const loadMe = useAuth((s) => s.loadMe);
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const fetchOrgs = useOrgs((s) => s.fetchOrgs);

  // Warm the org list and the signed-in profile once per page load (both deduped in their
  // stores) so the header renders an identity without waiting for a Settings visit.
  useEffect(() => {
    fetchOrgs();
    if (!useAuth.getState().user) loadMe();
  }, [fetchOrgs, loadMe]);

  const leaveToDashboard = () => {
    goToDashboard();
    router.push("/");
  };

  // Escape closes the user menu.
  useEffect(() => {
    if (!showUserMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowUserMenu(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showUserMenu]);

  const handleLogout = async () => {
    clearProfile();
    // Ends whichever session this is (local or Clerk) and lands back on /login.
    await api.signOut();
  };

  const userInitial = user?.name?.charAt(0)?.toUpperCase() || "U";

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{
        background: "var(--orchestr-surface)",
        color: "var(--orchestr-ink)",
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* Header */}
      <header
        className="relative py-3.5 px-8 flex items-center justify-between sticky top-0 z-[100]"
        style={{
          borderBottom: "1px solid var(--orchestr-line)",
          background: "var(--orchestr-surface-overlay)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={leaveToDashboard}
            className="flex items-center bg-transparent border-none cursor-pointer p-0"
            aria-label="Sarati — Home"
          >
            <SaratiLockup size={26} wordSize={17} gap={9} />
          </button>
        </div>
        {/* Phase rail lives in the header — no dedicated stepper band */}
        <div className="flex items-center gap-3">
          {/* Approvals inbox — runs waiting on a human, org-wide */}
          <ApprovalsNavButton />
          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 bg-transparent border-none cursor-pointer p-0"
              aria-label="User menu"
              aria-expanded={showUserMenu}
            >
              <div
                className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-semibold"
                style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }}
              >
                {userInitial}
              </div>
              <ChevronDown size={12} style={{ color: "var(--orchestr-ink-subtle)" }} />
            </button>
            {showUserMenu && (
              <>
                <div className="fixed inset-0 z-[150]" onClick={() => setShowUserMenu(false)} />
                <div
                  className="absolute right-0 top-full mt-2 w-56 rounded-lg py-1 z-[200]"
                  style={{
                    background: "var(--orchestr-surface-raised)",
                    border: "1px solid var(--orchestr-line)",
                  }}
                >
                  <div className="px-3 py-2 border-b" style={{ borderColor: "var(--orchestr-line)" }}>
                    <p className="text-xs font-medium truncate" style={{ color: "var(--orchestr-ink)" }}>
                      {user?.name}
                    </p>
                    <p className="text-[10px] truncate" style={{ color: "var(--orchestr-ink-subtle)" }}>
                      {user?.email}
                    </p>
                  </div>
                  <OrgMenuSection
                    onCreate={() => {
                      // The modal lives outside the dropdown, so closing the menu can't unmount it.
                      setShowUserMenu(false);
                      setShowCreateOrg(true);
                    }}
                  />
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      router.push("/settings");
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs bg-transparent border-none cursor-pointer text-left"
                    style={{ color: "var(--orchestr-ink-muted)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--orchestr-accent-tint)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Settings size={13} />
                    Settings
                  </button>
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      handleLogout();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs bg-transparent border-none cursor-pointer text-left"
                    style={{ color: "var(--orchestr-ink-muted)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--orchestr-accent-tint)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <LogOut size={13} />
                    Log out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {children ? (
        <div className="flex-1 flex overflow-hidden">{children}</div>
      ) : (
        <AnimatePresence mode="wait">
          <motion.div
            key="dashboard"
            initial={{ opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
            className="flex-1 overflow-y-auto"
          >
            <Dashboard />
          </motion.div>
        </AnimatePresence>
      )}

      {/* Create-organization modal — sibling of the menu (survives its close) */}
      <CreateOrgModal open={showCreateOrg} onClose={() => setShowCreateOrg(false)} />

    </div>
  );
}
