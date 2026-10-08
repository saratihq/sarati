import { describe, expect, it } from "vitest";
import type { AccountIdentity } from "@/api/client";
import {
  accountFields,
  accountRefToken,
  accountRefValue,
  isAccountRef,
  isEmailRecipientField,
} from "@/lib/accountRef";

const MAILBOX: AccountIdentity = {
  subject: "user",
  name: null,
  id: "me@e2e.local",
  email: "me@e2e.local",
  handle: null,
};

describe("{{$account…}} in the editor", () => {
  it("offers what the account actually says about itself, and nothing for a workspace", () => {
    expect(accountFields(MAILBOX)).toEqual([
      { field: "email", label: "Email", value: "me@e2e.local" },
      { field: "id", label: "ID", value: "me@e2e.local" },
    ]);
    expect(accountFields({ ...MAILBOX, subject: "workspace" })).toEqual([]);
    expect(accountFields(null)).toEqual([]);
  });

  it("writes the same reference the service fills", () => {
    expect(accountRefToken("email")).toBe("{{$account.email}}");
  });

  it("previews a reference as the account's value, and knows nothing it cannot read", () => {
    expect(isAccountRef(" $account.email ")).toBe(true);
    expect(isAccountRef("$auth.token")).toBe(false);
    expect(accountRefValue("$account.email", MAILBOX)).toBe("me@e2e.local");
    expect(accountRefValue("$account.handle", MAILBOX)).toBeNull();
    expect(accountRefValue("$account.email", null)).toBeNull();
  });

  it("suggests sending to me only on recipient fields", () => {
    for (const key of ["to", "cc", "bcc", "recipient_email", "recipients", "to_email"]) {
      expect(isEmailRecipientField(key)).toBe(true);
    }
    for (const key of ["subject", "body", "from", "user_id"]) {
      expect(isEmailRecipientField(key)).toBe(false);
    }
  });
});
