// auth.js / scores.js import Firebase from the gstatic CDN by full URL
// (the same module specifiers index.html loads at runtime). Map those URLs to the
// installed `firebase` v11 package's types so `// @ts-check` can resolve them
// (Firebase ships its own types — see docs/TYPESCRIPT_MIGRATION.md).
//
// Keep the version (11.5.0) in lockstep with the URLs in src/auth.js + src/scores.js
// and the `firebase` devDependency.
declare module "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js" {
  export * from "firebase/app";
}
declare module "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js" {
  export * from "firebase/auth";
}
declare module "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js" {
  export * from "firebase/firestore";
}
declare module "https://www.gstatic.com/firebasejs/11.5.0/firebase-analytics.js" {
  export * from "firebase/analytics";
}
