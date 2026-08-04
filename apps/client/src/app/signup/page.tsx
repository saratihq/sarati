"use client";

import LocalAuthGate from "@/components/LocalAuthGate";
import SignupPage from "@/components/SignupPage";

export default function Page() {
  return (
    <LocalAuthGate variant="signup">
      <SignupPage />
    </LocalAuthGate>
  );
}
