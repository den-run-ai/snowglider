// @ts-check
(function () {
  let startGamePending = false;

  function addBuildBadge() {
    const buildMeta = document.querySelector('meta[name="build-id"]');
    const build = buildMeta instanceof HTMLMetaElement
      ? buildMeta.content
      : new Date().toISOString().slice(0, 16).replace('T', ' ');
    const btn = document.getElementById('startGameButton');
    if (btn) {
      btn.innerHTML = `Start Game <span class="build-badge">${build}</span>`;
    }
  }

  async function unlockAudioForStart(source) {
    if (!window.AudioModule) {
      return;
    }

    try {
      await window.AudioModule.resumeAudioContext();
      console.log(`AudioContext resume attempted in ${source} handler`);
      window.AudioModule.playPreloadedAudio();
    } catch (e) {
      console.warn(`Audio operation in ${source} failed:`, e);
    }
  }

  function startGame() {
    const gameCanvas = document.getElementById('gameCanvas');
    const canInitializeGame = typeof window.initializeGameWithAudio === 'function';

    if (!gameCanvas || !canInitializeGame) {
      startGamePending = true;
      setStartButtonWaiting(true);
      console.log("Start requested before game scripts finished loading; deferring until ready.");
      return false;
    }

    startGamePending = false;
    setStartButtonWaiting(false);

    const startContainer = document.getElementById('startGameContainer');
    if (startContainer) {
      startContainer.style.display = 'none';
    }

    gameCanvas.style.display = 'block';

    window.initializeGameWithAudio();
    return true;
  }

  function startPendingGameIfReady() {
    const gameCanvas = document.getElementById('gameCanvas');
    if (!gameCanvas || typeof window.initializeGameWithAudio !== 'function') {
      return false;
    }

    setStartButtonWaiting(false);

    if (startGamePending) {
      console.log("Starting game from deferred start request.");
      return startGame();
    }

    return true;
  }

  function setStartButtonWaiting(waiting) {
    const startButton = document.getElementById('startGameButton');
    if (!(startButton instanceof HTMLButtonElement)) {
      return;
    }

    startButton.disabled = waiting;
    if (waiting) {
      startButton.setAttribute('aria-busy', 'true');
    } else {
      startButton.removeAttribute('aria-busy');
    }
  }

  function showAbout() {
    const aboutPanel = document.getElementById('aboutGamePanel');
    const controlsGuide = document.getElementById('controlsGuide');
    const startMenu = document.getElementById('startMenu');
    const keyboardHint = document.getElementById('keyboardHint');

    if (aboutPanel) aboutPanel.style.display = 'block';
    if (controlsGuide) controlsGuide.style.display = 'none';
    if (startMenu) startMenu.style.display = 'none';
    if (keyboardHint) keyboardHint.style.display = 'none';
  }

  function hideAbout() {
    const aboutPanel = document.getElementById('aboutGamePanel');
    const controlsGuide = document.getElementById('controlsGuide');
    const startMenu = document.getElementById('startMenu');
    const keyboardHint = document.getElementById('keyboardHint');

    if (aboutPanel) aboutPanel.style.display = 'none';
    if (controlsGuide) controlsGuide.style.display = 'block';
    if (startMenu) startMenu.style.display = 'flex';
    if (keyboardHint) keyboardHint.style.display = 'block';
  }

  function initializeStartMenu() {
    addBuildBadge();
    if (/** @type {any} */ (window).SnowGliderGameScriptsReady) {
      startPendingGameIfReady();
    }

    const startGameButton = document.getElementById('startGameButton');
    if (startGameButton) {
      startGameButton.addEventListener('click', async function () {
        console.log("Start button clicked");
        await unlockAudioForStart('click');
        startGame();
      });

      startGameButton.addEventListener('touchstart', function (e) {
        e.preventDefault();
        this.classList.add('touch-active');
      }, { passive: false });

      startGameButton.addEventListener('touchend', async function (e) {
        e.preventDefault();
        this.classList.remove('touch-active');
        console.log("Touch end - starting game");
        await unlockAudioForStart('touch');
        startGame();
      }, { passive: false });

      startGameButton.addEventListener('touchcancel', function () {
        this.classList.remove('touch-active');
      }, { passive: true });
    }

    const aboutGameButton = document.getElementById('aboutGameButton');
    if (aboutGameButton) {
      aboutGameButton.addEventListener('click', showAbout);
    }

    const closeAboutButton = document.getElementById('closeAboutButton');
    if (closeAboutButton) {
      closeAboutButton.addEventListener('click', hideAbout);
    }

    document.addEventListener('keydown', function (event) {
      const startContainer = document.getElementById('startGameContainer');
      const aboutPanel = document.getElementById('aboutGamePanel');

      if (startContainer &&
          startContainer.style.display !== 'none' &&
          aboutPanel &&
          aboutPanel.style.display !== 'block') {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          startGame();
        }
      } else if (aboutPanel && aboutPanel.style.display === 'block') {
        if (event.key === 'Escape') {
          const closeAboutButton = document.getElementById('closeAboutButton');
          if (closeAboutButton) closeAboutButton.click();
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initializeStartMenu);
  window.addEventListener('snowglider:game-scripts-ready', startPendingGameIfReady);

  window.SnowGliderStartMenu = {
    startGame,
    showAbout,
    hideAbout,
    initializeStartMenu,
    startPendingGameIfReady
  };
})();
