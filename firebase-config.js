// 1) Go to https://console.firebase.google.com -> Add project
// 2) Project settings -> "Your apps" -> Web (</>) -> copy the config below
// 3) Build -> Authentication -> Get started -> enable "Email/Password"
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCHjsAARbr0yNbsKcK70EXkHxh56cHZXAE",
  authDomain: "kasama-81566.firebaseapp.com",
  projectId: "kasama-81566",
  appId: "1:416408232239:web:c02f92c4123d6ac1c641da",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);