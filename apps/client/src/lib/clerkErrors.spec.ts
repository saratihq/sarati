import { describe, expect, it } from "vitest";
import { clerkErrorMessage } from "@/lib/clerkErrors";

const clerkError = (error: { code?: string; longMessage?: string; message?: string }) => ({ errors: [error] });

describe("clerkErrorMessage", () => {
  it("explains the confusing OAuth-account case in plain language", () => {
    const message = clerkErrorMessage(clerkError({ code: "strategy_for_user_invalid" }), "fallback");
    expect(message).toContain("Google or GitHub");
    expect(message).not.toBe("fallback");
  });

  it.each(["form_password_incorrect", "form_identifier_not_found", "form_identifier_exists"])(
    "rewrites %s",
    (code) => {
      expect(clerkErrorMessage(clerkError({ code, longMessage: "Clerk's own wording" }), "fallback")).not.toBe(
        "Clerk's own wording",
      );
    },
  );

  it("does not leak which accounts exist beyond what the code already says", () => {
    expect(clerkErrorMessage(clerkError({ code: "form_password_incorrect" }), "x")).toBe("Incorrect email or password.");
  });

  it("prefers Clerk's longMessage for an unlisted code", () => {
    const err = clerkError({ code: "some_new_code", longMessage: "The long one", message: "The short one" });
    expect(clerkErrorMessage(err, "fallback")).toBe("The long one");
  });

  it("falls back to Clerk's short message when there is no long one", () => {
    expect(clerkErrorMessage(clerkError({ code: "x", message: "The short one" }), "fallback")).toBe("The short one");
  });

  it.each([
    { label: "null", err: null },
    { label: "undefined", err: undefined },
    { label: "a plain Error", err: new Error("boom") },
    { label: "an empty errors array", err: { errors: [] } },
    { label: "an error with no text at all", err: clerkError({ code: "x" }) },
    { label: "blank messages", err: clerkError({ code: "x", longMessage: "", message: "" }) },
  ])("falls back to the caller's copy for $label", ({ err }) => {
    expect(clerkErrorMessage(err, "Something went wrong.")).toBe("Something went wrong.");
  });
});
