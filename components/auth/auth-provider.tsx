"use client";

import { onIdTokenChanged, type User } from "firebase/auth";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { getFirebaseServices } from "@/lib/firebase/client";

export type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; user: User; emailVerified: boolean }
  | { status: "misconfigured"; message: string };

const AuthContext = createContext<AuthState>({ status: "loading" });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let unsubscribe = () => {};
    try {
      const { auth } = getFirebaseServices();
      // Fires on sign-in, sign-out and token refresh, so `emailVerified`
      // updates after the user confirms their address and the token reloads.
      unsubscribe = onIdTokenChanged(auth, (user) => {
        setState(
          user
            ? { status: "signedIn", user, emailVerified: user.emailVerified }
            : { status: "signedOut" },
        );
      });
    } catch (error) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reports a one-time configuration failure
      setState({
        status: "misconfigured",
        message: error instanceof Error ? error.message : "Firebase is not configured.",
      });
    }
    return () => unsubscribe();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
