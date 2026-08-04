"use client";

import LocalAuthGate from "@/components/LocalAuthGate";
import LoginPage from "@/components/LoginPage";

export default function Page() {
  return (
    <LocalAuthGate variant="signin">
      <LoginPage />
    </LocalAuthGate>
  );
}
