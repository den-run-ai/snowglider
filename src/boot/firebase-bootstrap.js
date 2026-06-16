// @ts-check
(function () {
  const isFileProtocol = window.location.protocol === 'file:';
  const isLocalDevelopment = isFileProtocol ||
    window.location.hostname.includes('localhost') ||
    window.location.hostname.includes('127.0.0.1');

  const firebaseConfig = {
    apiKey: "AIzaSyAzzpgn54sKER3aa03F2E5vlogfenP9T8Q",
    authDomain: "sn0wglider.firebaseapp.com",
    projectId: "sn0wglider",
    storageBucket: "sn0wglider.appspot.com",
    messagingSenderId: "504681218869",
    appId: "1:504681218869:web:5abbba6825691006d6027c",
    measurementId: "G-GYQC13R6MZ"
  };

  function addLocalModeNotice() {
    if (!isFileProtocol && !isLocalDevelopment) {
      return;
    }

    const notice = document.createElement('div');
    notice.style.position = 'fixed';
    notice.style.bottom = '10px';
    notice.style.right = '10px';
    notice.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    notice.style.color = 'white';
    notice.style.padding = '8px 12px';
    notice.style.borderRadius = '4px';
    notice.style.fontSize = '12px';
    notice.style.fontFamily = 'Arial, sans-serif';
    notice.style.zIndex = '1000';

    if (isFileProtocol) {
      notice.innerHTML = '&#127968; Local File Mode: Firebase disabled';
    } else if (isLocalDevelopment) {
      notice.innerHTML = '&#128736;&#65039; Local Dev Mode: Firestore disabled';
    }

    document.body.appendChild(notice);
  }

  function loadAuthModules() {
    if (isFileProtocol) {
      return;
    }

    console.log("Firebase initialization will be handled by auth.js");

    const head = document.getElementsByTagName('head')[0];
    const scoresScript = document.createElement('script');
    scoresScript.type = 'module';
    scoresScript.id = 'scoresScript';
    scoresScript.src = 'src/scores.js';
    head.appendChild(scoresScript);

    const authScript = document.createElement('script');
    authScript.type = 'module';
    authScript.id = 'authScript';
    authScript.src = 'src/auth.js';
    head.appendChild(authScript);
  }

  function waitForAuthModule() {
    if (isFileProtocol) {
      if (window.SnowGliderLocalAuth &&
          typeof window.SnowGliderLocalAuth.installAuthModule === 'function') {
        console.log("File protocol detected - using local auth implementation");
        window.SnowGliderLocalAuth.installAuthModule();
      }
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let checkCount = 0;
      const maxChecks = 25;
      const checkInterval = setInterval(() => {
        if (window.AuthModule && typeof window.AuthModule.initializeAuth === 'function') {
          clearInterval(checkInterval);
          console.log("AuthModule successfully detected");
          resolve();
        } else {
          checkCount++;
          if (checkCount >= maxChecks) {
            clearInterval(checkInterval);
            console.error("AuthModule failed to load after timeout.");
            reject(new Error("AuthModule failed to load"));
          }
        }
      }, 200);
    });
  }

  function initializeAuthModule() {
    try {
      if (window.AuthModule && typeof window.AuthModule.initializeAuth === 'function') {
        console.log("Calling AuthModule.initializeAuth...");
        window.AuthModule.initializeAuth(firebaseConfig);

        if (window.AuthModule.isFirebaseAvailable) {
          const status = window.AuthModule.isFirebaseAvailable();
          console.log("Firebase services status (reported by AuthModule):",
            "Auth:", status.auth ? "Available" : "Unavailable",
            "Firestore:", status.firestore ? "Available" : "Unavailable",
            "Analytics:", status.analytics ? "Available" : "Unavailable"
          );
        }
        console.log("AuthModule initialization called.");
      } else {
        console.error("AuthModule or initializeAuth function not found when expected!");
      }
    } catch (e) {
      console.error("Error calling AuthModule.initializeAuth:", e.message, e.stack);
    }
  }

  window.FIREBASE_MANUAL_INIT = true;
  if (!window.__FIREBASE_DEFAULTS__) {
    window.__FIREBASE_DEFAULTS__ = {};
  }

  const originalFetch = window.fetch;
  window.fetch = function (url, options) {
    if (url && typeof url === 'string' && url.includes('/__/firebase/init.json')) {
      console.log('Intercepted Firebase init.json fetch request');
      return Promise.resolve(new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
    return originalFetch.apply(this, arguments);
  };

  document.addEventListener('DOMContentLoaded', addLocalModeNotice);
  loadAuthModules();

  window.SnowGliderFirebase = {
    isFileProtocol,
    isLocalDevelopment,
    waitForAuthModule,
    initializeAuthModule
  };
})();
