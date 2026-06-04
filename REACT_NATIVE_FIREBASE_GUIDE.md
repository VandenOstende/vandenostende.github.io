# 🚀 React Native + Firebase: Start-to-Finish Guide

A complete, copy-paste friendly guide to building a React Native (Expo) app from scratch, connecting it to a Cloud Firestore database, and building it for publishing to a website.

> This guide uses **[Expo](https://expo.dev/)** because it gives you a single codebase that runs on **iOS**, **Android**, and the **Web** — which makes publishing to a website straightforward.

---

## 📚 Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Create the Project](#2-create-the-project)
3. [Run the App in Development](#3-run-the-app-in-development)
4. [Project Structure](#4-project-structure)
5. [Install & Configure Firebase](#5-install--configure-firebase)
6. [Connect to Firestore](#6-connect-to-firestore)
7. [Read & Write Data (Collections)](#7-read--write-data-collections)
8. [Build for the Web](#8-build-for-the-web)
9. [Publish to a Website](#9-publish-to-a-website)
10. [Quick Command Reference](#10-quick-command-reference)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prerequisites

Before you start, install the following tools.

| Tool | Why | Check version |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) (LTS) | Runs the JS tooling | `node -v` |
| npm (bundled with Node) | Package manager | `npm -v` |
| [Git](https://git-scm.com/) | Version control | `git --version` |
| [Expo](https://expo.dev/) CLI | Run via `npx` (no global install needed) | `npx expo --version` |

Optional but recommended:

```bash
# Install the Expo Application Services (EAS) CLI for cloud builds
npm install -g eas-cli

# Verify
eas --version
```

[⬆ Back to top](#-table-of-contents)

---

## 2. Create the Project

Create a new Expo app. The `--template` flag scaffolds a TypeScript project with file-based routing.

```bash
# Scaffold a new app (you will be prompted for a template; pick "Navigation (TypeScript)")
npx create-expo-app@latest my-app

# Move into the project folder
cd my-app
```

> Replace `my-app` with your project name.

Install dependencies (already done by the scaffolder, but run again if needed):

```bash
npm install
```

[⬆ Back to top](#-table-of-contents)

---

## 3. Run the App in Development

```bash
# Start the Expo dev server
npx expo start
```

Then choose where to run it:

| Key | Target |
| --- | --- |
| `w` | Open in the **web** browser |
| `i` | Open in the **iOS** simulator (macOS + Xcode) |
| `a` | Open in the **Android** emulator |
| Scan QR | Open on a physical device via the **Expo Go** app |

To start directly on web:

```bash
npx expo start --web
```

[⬆ Back to top](#-table-of-contents)

---

## 4. Project Structure

A typical Expo project looks like this:

```
my-app/
├── app/                # Screens & routes (file-based routing)
│   ├── _layout.tsx
│   └── index.tsx
├── assets/             # Images, fonts, icons
├── components/         # Reusable UI components
├── constants/          # Theme, colors, config
├── firebase/           # (you create this) Firebase setup
│   └── firebaseConfig.ts
├── app.json            # Expo app configuration
├── package.json
└── tsconfig.json
```

[⬆ Back to top](#-table-of-contents)

---

## 5. Install & Configure Firebase

Install the Firebase JS SDK:

```bash
npm install firebase
```

Create a file `firebase/firebaseConfig.ts` and paste your Firebase configuration.

> ⚠️ **Security note:** The keys below are **client-side** Firebase config values (safe to ship in a web/mobile app — they identify the project, they are not secrets). However, you **must** protect your data with [Firestore Security Rules](https://firebase.google.com/docs/firestore/security/get-started). Never put server-side service-account credentials in client code.

```ts
// firebase/firebaseConfig.ts

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyB0zgeHJpDcfw1tB6gWN0-Bu99etBcoEvk",
  authDomain: "tkedelweiss-ac154.firebaseapp.com",
  projectId: "tkedelweiss-ac154",
  storageBucket: "tkedelweiss-ac154.firebasestorage.app",
  messagingSenderId: "1063994250811",
  appId: "1:1063994250811:web:d182b3528c649a03136e1e",
  measurementId: "G-EL4287RVN5",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firestore
export const db = getFirestore(app);

// Analytics only works in supported (web) environments — guard it
export let analytics: ReturnType<typeof getAnalytics> | null = null;
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
  }
});

export default app;
```

> **Tip:** To avoid hard-coding config, move the values into environment variables prefixed with `EXPO_PUBLIC_` (e.g. `EXPO_PUBLIC_FIREBASE_API_KEY`) and read them via `process.env.EXPO_PUBLIC_FIREBASE_API_KEY`.

[⬆ Back to top](#-table-of-contents)

---

## 6. Connect to Firestore

The `db` exported above is your Firestore connection. Import it anywhere you need to read or write data:

```ts
import { db } from "../firebase/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";
```

[⬆ Back to top](#-table-of-contents)

---

## 7. Read & Write Data (Collections)

As of **04 June 2026**, the database uses the following collections:

| Collection | Description |
| --- | --- |
| `aanwezigheden` | Attendances |
| `disciplines` | Disciplines |
| `instellingen` | Settings |
| `lesRoosters` | Class schedules / timetables |
| `personen` | People / members |

### Read all documents from a collection

```ts
import { db } from "../firebase/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";

export async function getPersonen() {
  const snapshot = await getDocs(collection(db, "personen"));
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
```

### Read a single document by ID

```ts
import { doc, getDoc } from "firebase/firestore";

export async function getPersoon(id: string) {
  const ref = doc(db, "personen", id);
  const snap = await getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
```

### Add a new document

```ts
import { collection, addDoc } from "firebase/firestore";

export async function addAanwezigheid(data: Record<string, unknown>) {
  const ref = await addDoc(collection(db, "aanwezigheden"), data);
  return ref.id;
}
```

### Update a document

```ts
import { doc, updateDoc } from "firebase/firestore";

export async function updateInstelling(id: string, data: Record<string, unknown>) {
  await updateDoc(doc(db, "instellingen", id), data);
}
```

### Delete a document

```ts
import { doc, deleteDoc } from "firebase/firestore";

export async function deleteLesRooster(id: string) {
  await deleteDoc(doc(db, "lesRoosters", id));
}
```

### Query with filters

```ts
import { collection, query, where, getDocs } from "firebase/firestore";

export async function getDisciplinesByType(type: string) {
  const q = query(collection(db, "disciplines"), where("type", "==", type));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
```

[⬆ Back to top](#-table-of-contents)

---

## 8. Build for the Web

Expo compiles your app into a static website that can be hosted anywhere.

### One-time setup

Make sure the web dependencies are installed:

```bash
npx expo install react-dom react-native-web @expo/metro-runtime
```

### Export a static web build

```bash
# Generates a production-ready static site in the ./dist folder
npx expo export --platform web
```

The output is placed in the `dist/` directory — plain HTML, CSS, and JS ready to host.

> To preview the production build locally:
>
> ```bash
> npx serve dist
> ```

[⬆ Back to top](#-table-of-contents)

---

## 9. Publish to a Website

Pick **one** of the hosting options below.

### Option A — GitHub Pages

```bash
# 1. Build the static site
npx expo export --platform web

# 2. Install the gh-pages helper
npm install --save-dev gh-pages

# 3. Deploy the dist folder to the gh-pages branch
npx gh-pages -d dist
```

> In your repository **Settings → Pages**, set the source to the `gh-pages` branch.
> If hosting under a sub-path (e.g. `username.github.io/repo`), set the base path:
>
> ```bash
> npx expo export --platform web
> # then ensure your app.json "experiments" / baseUrl is configured for the sub-path
> ```

### Option B — Firebase Hosting (recommended with Firestore)

```bash
# 1. Install the Firebase CLI
npm install -g firebase-tools

# 2. Log in
firebase login

# 3. Initialize hosting (choose "dist" as the public directory, configure as a single-page app: Yes)
firebase init hosting

# 4. Build the web app
npx expo export --platform web

# 5. Deploy
firebase deploy --only hosting
```

### Option C — Netlify

```bash
# 1. Build
npx expo export --platform web

# 2. Install the Netlify CLI and deploy
npm install -g netlify-cli
netlify deploy --dir=dist --prod
```

### Option D — Vercel

```bash
npm install -g vercel
npx expo export --platform web
vercel --prod ./dist
```

[⬆ Back to top](#-table-of-contents)

---

## 10. Quick Command Reference

| Action | Command |
| --- | --- |
| Create project | `npx create-expo-app@latest my-app` |
| Install dependencies | `npm install` |
| Start dev server | `npx expo start` |
| Start on web | `npx expo start --web` |
| Install Firebase | `npm install firebase` |
| Install web deps | `npx expo install react-dom react-native-web @expo/metro-runtime` |
| Build for web | `npx expo export --platform web` |
| Preview build | `npx serve dist` |
| Deploy to GitHub Pages | `npx gh-pages -d dist` |
| Deploy to Firebase | `firebase deploy --only hosting` |
| Deploy to Netlify | `netlify deploy --dir=dist --prod` |
| Deploy to Vercel | `vercel --prod ./dist` |

[⬆ Back to top](#-table-of-contents)

---

## 11. Troubleshooting

| Problem | Fix |
| --- | --- |
| `command not found: expo` | Use `npx expo …` instead of a global `expo`. |
| Blank page after deploy to a sub-path | Configure the `baseUrl` in `app.json` to match the hosting sub-path. |
| Analytics error on native | Wrap `getAnalytics` in an `isSupported()` check (see [Section 5](#5-install--configure-firebase)). |
| `Missing or insufficient permissions` from Firestore | Update your [Firestore Security Rules](https://firebase.google.com/docs/firestore/security/get-started). |
| Web build missing dependencies | Run `npx expo install react-dom react-native-web @expo/metro-runtime`. |

[⬆ Back to top](#-table-of-contents)

---

*Happy building! 🚀*
