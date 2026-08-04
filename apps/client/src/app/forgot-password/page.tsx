"use client";

import ForgotPasswordPage from "@/components/ForgotPasswordPage";
import LocalAuthGate from "@/components/LocalAuthGate";

export default function Page() {
  return (
    <LocalAuthGate variant="reset">
      <ForgotPasswordPage />
    </LocalAuthGate>
  );
}
