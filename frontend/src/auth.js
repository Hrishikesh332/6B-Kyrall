import { api } from "./lib.js";

// Google sign-in through Firebase Auth. Firebase only proves who signed in: the
// ID token is exchanged once for the server's HttpOnly session cookie, so nothing
// stays signed in inside this page (in-memory persistence) and page scripts never
// hold a lasting credential. The SDK loads only when sign-in is turned on.
export const authConfig = () => api("/auth/config");

let firebaseAuth = null;
async function loadAuth(config) {
  if (!firebaseAuth) {
    const [{ initializeApp, getApps }, auth] = await Promise.all([
      import("firebase/app"),
      import("firebase/auth"),
    ]);
    const app =
      getApps().find((a) => a.name === "6b") || initializeApp(config, "6b");
    const instance = auth.initializeAuth(app, {
      persistence: auth.inMemoryPersistence,
      popupRedirectResolver: auth.browserPopupRedirectResolver,
    });
    firebaseAuth = { auth, instance };
  }
  return firebaseAuth;
}

const CANCELLED = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/user-cancelled",
]);

// Resolves to the signed-in user, or null when the user closed the Google window.
export async function signInWithGoogle(config) {
  const { auth, instance } = await loadAuth(config);
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  let credential;
  try {
    credential = await auth.signInWithPopup(instance, provider);
  } catch (err) {
    if (CANCELLED.has(err?.code)) return null;
    if (err?.code === "auth/popup-blocked")
      throw new Error("Allow pop-ups for this site, then try again.");
    if (
      err?.code === "auth/operation-not-allowed" ||
      err?.code === "auth/configuration-not-found"
    )
      throw new Error(
        "Google sign-in is not turned on for this Firebase project yet. In the Firebase console, open Authentication → Sign-in method and enable Google.",
      );
    if (err?.code === "auth/unauthorized-domain")
      throw new Error(
        `${location.hostname} is not an authorized domain for Google sign-in. Add it in Firebase → Authentication → Settings.`,
      );
    throw new Error("Google sign-in did not finish. Please try again.");
  }
  try {
    const { user } = await api("/auth/session", {
      method: "POST",
      body: { id_token: await credential.user.getIdToken() },
    });
    return user;
  } finally {
    await auth.signOut(instance);
  }
}

export const signOut = () => api("/auth/session", { method: "DELETE" });
