"use client";

import { signInWithEmailAndPassword } from "firebase/auth";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { AuthCard, FormMessage } from "@/components/auth/auth-card";
import { useAuth } from "@/components/auth/auth-provider";
import { useRedirectWhenSignedIn } from "@/components/auth/use-redirect-when-signed-in";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage } from "@/lib/auth/errors";
import { getFirebaseServices } from "@/lib/firebase/client";

export default function LoginPage() {
  const auth = useAuth();
  useRedirectWhenSignedIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signInWithEmailAndPassword(getFirebaseServices().auth, email.trim(), password);
      // The auth listener redirects once the session is established.
    } catch (caught) {
      setError(authErrorMessage(caught));
      setPending(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      description="Pick up where your conversations left off."
      footer={
        <>
          New to Recall?{" "}
          <Link href="/register" className="font-medium text-foreground underline-offset-4 hover:underline">
            Create an account
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
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/reset-password"
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Button type="submit" size="lg" disabled={pending || !email || !password}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthCard>
  );
}
