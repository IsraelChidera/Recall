"use client";

import { sendEmailVerification, signOut } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AuthCard, FormMessage } from "@/components/auth/auth-card";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { authErrorMessage } from "@/lib/auth/errors";
import { getFirebaseServices } from "@/lib/firebase/client";

export default function VerifyEmailPage() {
  const auth = useAuth();
  const router = useRouter();
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (auth.status === "signedOut") router.replace("/login");
    if (auth.status === "signedIn" && auth.emailVerified) router.replace("/dashboard");
  }, [auth, router]);

  if (auth.status !== "signedIn") {
    return (
      <AuthCard title="Confirm your email" description="Loading your account…">
        <div aria-busy="true" className="h-10 animate-pulse rounded-md bg-muted" />
      </AuthCard>
    );
  }

  const { user } = auth;

  async function checkVerified() {
    setPending(true);
    setMessage(null);
    try {
      await user.reload();
      if (user.emailVerified) {
        // Refresh the ID token so its email_verified claim is current. The
        // auth listener then redirects to the dashboard.
        await user.getIdToken(true);
      } else {
        setMessage({
          tone: "info",
          text: "Not confirmed yet. Open the link in the email, then try again.",
        });
      }
    } catch (caught) {
      setMessage({ tone: "error", text: authErrorMessage(caught) });
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    setPending(true);
    setMessage(null);
    try {
      await sendEmailVerification(user);
      setMessage({ tone: "info", text: "Sent. Check your inbox and spam folder." });
    } catch (caught) {
      setMessage({ tone: "error", text: authErrorMessage(caught) });
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard
      title="Confirm your email"
      description={`We sent a confirmation link to ${user.email ?? "your address"}. Recall stays locked until you open it.`}
      footer={
        <button
          type="button"
          className="font-medium text-foreground underline-offset-4 hover:underline"
          onClick={() => signOut(getFirebaseServices().auth)}
        >
          Use a different account
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
        <Button size="lg" onClick={checkVerified} disabled={pending}>
          I have confirmed my email
        </Button>
        <Button size="lg" variant="outline" onClick={resend} disabled={pending}>
          Resend the email
        </Button>
      </div>
    </AuthCard>
  );
}
