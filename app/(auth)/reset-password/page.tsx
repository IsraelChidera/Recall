"use client";

import { sendPasswordResetEmail } from "firebase/auth";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { AuthCard, FormMessage } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage } from "@/lib/auth/errors";
import { getFirebaseServices } from "@/lib/firebase/client";

/** Error codes worth showing. Anything else gets the same neutral confirmation. */
const VISIBLE_ERRORS = new Set([
  "auth/invalid-email",
  "auth/network-request-failed",
  "auth/too-many-requests",
]);

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await sendPasswordResetEmail(getFirebaseServices().auth, email.trim());
      setSent(true);
    } catch (caught) {
      const code =
        typeof caught === "object" && caught !== null && "code" in caught
          ? String((caught as { code: unknown }).code)
          : "";
      if (VISIBLE_ERRORS.has(code)) {
        setError(authErrorMessage(caught));
      } else {
        // Do not reveal whether the address has an account.
        setSent(true);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Enter your email and we will send a reset link."
      footer={
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <FormMessage tone="info">
          If an account exists for that address, a reset link is on its way. Check your inbox
          and spam folder.
        </FormMessage>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <Button type="submit" size="lg" disabled={pending || !email}>
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
