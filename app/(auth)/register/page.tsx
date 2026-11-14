"use client";

import { createUserWithEmailAndPassword, sendEmailVerification } from "firebase/auth";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { AuthCard, FormMessage } from "@/components/auth/auth-card";
import { useAuth } from "@/components/auth/auth-provider";
import { useRedirectWhenSignedIn } from "@/components/auth/use-redirect-when-signed-in";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage, MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/auth/errors";
import { getFirebaseServices } from "@/lib/firebase/client";

export default function RegisterPage() {
  const auth = useAuth();
  useRedirectWhenSignedIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setPending(true);
    try {
      const credential = await createUserWithEmailAndPassword(
        getFirebaseServices().auth,
        email.trim(),
        password,
      );
      await sendEmailVerification(credential.user);
      // The auth listener redirects to the verification page.
    } catch (caught) {
      setError(authErrorMessage(caught));
      setPending(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      description="You will confirm your email address before importing anything."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {auth.status === "misconfigured" ? (
          <FormMessage tone="error">{auth.message}</FormMessage>
        ) : null}
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
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            aria-describedby="password-hint"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p id="password-hint" className="text-xs text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Button type="submit" size="lg" disabled={pending || !email || !password}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
