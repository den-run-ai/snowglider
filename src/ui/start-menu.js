// @ts-check
(function () {
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
    const startContainer = document.getElementById('startGameContainer');
    if (startContainer) {
      startContainer.style.display = 'none';
    }

    const gameCanvas = document.getElementById('gameCanvas');
    if (gameCanvas) {
      gameCanvas.style.display = 'block';
    }

    if (typeof window.initializeGameWithAudio === 'function') {
      window.initializeGameWithAudio();
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

  window.SnowGliderStartMenu = {
    startGame,
    showAbout,
    hideAbout,
    initializeStartMenu
  };
})();
