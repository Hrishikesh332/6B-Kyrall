import { useState } from "react";
import { Component } from "lucide-react";
import { signInWithGoogle } from "./auth.js";
import { ErrorNotice } from "./ui.jsx";
import "./sign-in.css";

// Google's "G" mark, as its sign-in branding guidelines ask for on the button.
export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

export default function SignIn({ config, onSignedIn }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const user = await signInWithGoogle(config);
      if (user) await onSignedIn(user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="sign-in" id="main-content">
      <section className="sign-in-card" aria-labelledby="sign-in-title">
        <span className="brand-symbol">
          <Component size={22} strokeWidth={1.6} />
        </span>
        <h1 id="sign-in-title">Sign in to 6B</h1>
        <p className="muted">
          Your chats, projects and files are kept with your Google account and
          copied to the cloud as each run starts and finishes.
        </p>
        <button
          className="google-button"
          onClick={signIn}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          <GoogleMark />
          {busy ? "Signing in…" : "Continue with Google"}
        </button>
        {error && <ErrorNotice error={error} />}
      </section>
    </main>
  );
}
