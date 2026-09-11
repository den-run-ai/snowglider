// auth.ts / scores.ts import Firebase from the gstatic CDN by full URL.
// Map those URLs to the exact installed SDK's official type declarations.
//
// tests/dependency-type-contract-tests.js enforces parity between these URLs,
// runtime imports, and the pinned firebase dependency / lockfile version.
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
