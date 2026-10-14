"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// Client-side session access for the existing UI. It answers the same
// useSession() / signIn() / signOut() calls the pages were written against, from
// GET /api/auth/session, which is itself answered from the verified Clerk session.
// `user.id` is the LOCAL user id.

export interface ClientSession {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    role: string;
  };
  expires: string;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

interface SessionState {
  data: ClientSession | null;
  status: SessionStatus;
}

const SessionContext = createContext<SessionState>({ data: null, status: "loading" });

async function fetchSession(): Promise<ClientSession | null> {
  const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) return null;
  const body = (await response.json()) as ClientSession | null;
  return body && body.user ? body : null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ data: null, status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const session = await fetchSession();
      setState({ data: session, status: session ? "authenticated" : "unauthenticated" });
    } catch {
      setState({ data: null, status: "unauthenticated" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const value = useMemo(() => state, [state]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}

export interface SignInResult {
  error: string | null;
  ok: boolean;
  status: number;
  url: string | null;
}

// Signing in is Clerk's job: this hands the visitor to the /signin page, which
// renders Clerk's component. Credentials and OAuth providers are chosen there, so
// the provider and any credentials passed in are ignored. `callbackUrl` is kept,
// but only as a path on this site. Resolves immediately: the browser is leaving.
export async function signIn(_provider?: string, options: { callbackUrl?: string } = {}): Promise<SignInResult> {
  const target = new URL("/signin", window.location.origin);
  const callbackUrl = options.callbackUrl;
  if (callbackUrl && callbackUrl.startsWith("/") && !callbackUrl.startsWith("//") && !callbackUrl.includes("\\")) {
    target.searchParams.set("callbackUrl", callbackUrl);
  }
  window.location.assign(target.toString());
  return { error: null, ok: true, status: 200, url: target.toString() };
}

export async function signOut(options: { callbackUrl?: string } = {}): Promise<void> {
  window.location.assign(options.callbackUrl ?? "/");
}
