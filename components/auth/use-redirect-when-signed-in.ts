"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "./auth-provider";

/** Sends an already signed-in visitor away from the sign-in and sign-up pages. */
export function useRedirectWhenSignedIn(): void {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.status !== "signedIn") return;
    router.replace(auth.emailVerified ? "/dashboard" : "/verify-email");
  }, [auth, router]);
}
