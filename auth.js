import { auth } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const $ = (id) => document.getElementById(id);
let mode = "login"; // "login" or "signup"
let busy = false; // blocks the auto-redirect while we save the user's name

onAuthStateChanged(auth, (user) => {
  if (user && !busy) window.location.href = "dashboard.html";
});

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  $("title").textContent = signup ? "Create account" : "Log in";
  $("subtitle").textContent = signup ? "Make an account to start your circle." : "Welcome back. Your circle is waiting.";
  $("submit").textContent = signup ? "Create account" : "Log in";
  $("switch-text").textContent = signup ? "Already have an account?" : "No account yet?";
  $("switch-btn").textContent = signup ? "Log in" : "Create an account";
  $("name-row").classList.toggle("hidden", !signup);
  $("password").autocomplete = signup ? "new-password" : "current-password";
  $("error").textContent = "";
}
$("switch-btn").addEventListener("click", () => setMode(mode === "login" ? "signup" : "login"));

const messages = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/missing-password": "Enter your password.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/email-already-in-use": "An account with this email already exists. Try logging in.",
  "auth/invalid-credential": "Wrong email or password.",
  "auth/user-not-found": "Wrong email or password.",
  "auth/wrong-password": "Wrong email or password.",
  "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
  "auth/network-request-failed": "No internet connection.",
};

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const name = $("name").value.trim();
  $("error").textContent = "";

  if (mode === "signup" && !name) {
    $("error").textContent = "Enter your name so your circle knows who you are.";
    return;
  }

  $("submit").disabled = true;
  busy = true;
  try {
    if (mode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    window.location.href = "dashboard.html";
  } catch (err) {
    busy = false;
    $("error").textContent = messages[err.code] || "Something went wrong. (" + err.code + ")";
  } finally {
    $("submit").disabled = false;
  }
});