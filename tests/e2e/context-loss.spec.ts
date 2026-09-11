import type { GameState, SceneContext } from '../../src/game/scene-setup.js';
import type { PlayerState } from '../../src/player-state.js';
import { test, expect } from './fixtures';
import { gotoGame, startGame } from './helpers';

type RecoveryWindow = Window &
  Pick<SceneContext, 'renderer' | 'scene'> &
  Pick<GameState, 'gameActive' | 'simElapsed'> &
  Pick<PlayerState, 'pos'> &
  Required<Pick<Window, 'initializeGameWithAudio' | 'restartGame' | 'resetSnowman' | 'showGameOver'>> & {
    getControls: typeof import('../../src/controls.js').Controls.getControls;
  };

test.describe('real WebGL context loss', () => {
  // Chromium exposes WEBGL_lose_context consistently in CI. This intentionally
  // exercises the driver event, not a synthetic Event or a throwing render stub.
  test.skip(({ browserName }) => browserName !== 'chromium', 'requires Chromium WEBGL_lose_context');

  for (const phase of ['menu', 'loading', 'forest', 'intro', 'run', 'result'] as const) {
    test(`stops safely during ${phase} and reloads a fresh game`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let releaseForest: () => void = () => {};
      if (phase === 'forest') {
        const forestGate = new Promise<void>((resolve) => { releaseForest = resolve; });
        await page.route(/(?:@dgreenheck|dgreenheck).*ez-tree/, async (route) => {
          await forestGate;
          await route.continue();
        });
      }
      await gotoGame(page, phase === 'intro' ? '?intro=force' :
        phase === 'forest' || phase === 'run' ? '?eztrees=1' : '');
      if (phase === 'run' || phase === 'result') await startGame(page);
      if (phase === 'run') {
        // Successful CI runs retain visual evidence too. Force and verify the
        // actual player forest, rather than photographing the automation cones.
        await page.waitForFunction(() => {
          const w = window as unknown as RecoveryWindow;
          let ezAttached = false;
          w.scene.traverse((object) => {
            if (object.userData.forestPart === 'ezBranches') ezAttached = true;
          });
          return ezAttached && w.renderer.info.render.calls > 0;
        });
        await testInfo.attach('webgl-context-before-ez-player-scene', {
          body: await page.screenshot(), contentType: 'image/png',
        });
      }
      if (phase === 'forest') {
        await page.getByRole('button', { name: 'Start Game', exact: true }).click();
        await expect(page.getByText('Loading forest...', { exact: true })).toBeVisible();
      }
      // Keep original references: disposal intentionally removes every window
      // handle. Check the retained real state and callbacks rather than reading
      // undefined handles and mistakenly concluding the simulation stopped.
      const probe = await page.evaluateHandle(async (currentPhase) => {
        const w = window as unknown as RecoveryWindow;
        if (currentPhase === 'loading' || currentPhase === 'intro') {
          // Start awaits the audio-unlock promise before entering its loading
          // delay/intro. Observe the actual phase before losing graphics; doing
          // both in one browser task avoids a slow driver missing a short intro.
          await new Promise<void>((resolve, reject) => {
            const observer = new MutationObserver(checkPhase);
            const timeout = window.setTimeout(() => {
              observer.disconnect();
              reject(new Error(`Start never entered the ${currentPhase} phase`));
            }, 10_000);
            function checkPhase(): void {
              const entered = currentPhase === 'intro'
                ? document.body.classList.contains('intro-active')
                : Array.from(document.body.children).some((node) => node.textContent === 'Loading game...');
              if (!entered) return;
              observer.disconnect();
              clearTimeout(timeout);
              resolve();
            }
            observer.observe(document.body, { childList: true, subtree: true,
              attributes: true, attributeFilter: ['class'] });
            document.getElementById('startGameButton')!.click();
            checkPhase();
          });
        }
        if (currentPhase === 'result') w.showGameOver('Tree Collision');
        const renderer = w.renderer;
        const canvas = renderer.domElement;
        const gl = renderer.getContext();
        const extension = gl.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('WEBGL_lose_context unavailable');
        // Retain the actual accessors before disposal deletes the window handles.
        // PropertyDescriptor.get returns any, so validate its result at this seam
        // rather than allowing an untyped value through the serialized probe.
        function retainGetter<T>(name: string, isValue: (value: unknown) => value is T): () => T {
          const getter: (() => unknown) | undefined = Object.getOwnPropertyDescriptor(w, name)?.get?.bind(w);
          if (!getter) throw new Error(`Missing live ${name} getter`);
          return () => {
            const value = getter();
            if (!isValue(value)) throw new Error(`Invalid live ${name} value`);
            return value;
          };
        }
        const getActive = retainGetter('gameActive', (value): value is boolean => typeof value === 'boolean');
        const getElapsed = retainGetter('simElapsed', (value): value is number => typeof value === 'number' && Number.isFinite(value));
        const controls = w.getControls();
        controls.left = true;
        const pos = w.pos;
        const start = w.initializeGameWithAudio;
        const restart = w.restartGame;
        const reset = w.resetSnowman;
        let renders = 0;
        const render = renderer.render.bind(renderer);
        renderer.render = (...args) => { renders++; render(...args); };
        const phaseAtLoss = {
          active: w.gameActive,
          intro: document.body.classList.contains('intro-active'),
          loading: Array.from(document.body.children).some((node) => node.textContent === 'Loading game...'),
        };
        extension.loseContext();
        return { canvas, controls, pos, getActive, getElapsed, start, restart, reset,
          phaseAtLoss, readRenders: () => renders };
      }, phase);
      if (phase === 'intro') expect(await probe.evaluate((p) => p.phaseAtLoss.intro)).toBe(true);
      if (phase === 'loading') {
        expect(await probe.evaluate((p) => p.phaseAtLoss.loading)).toBe(true);
        expect(await probe.evaluate((p) => p.phaseAtLoss.active)).toBe(false);
      }
      await expect(page.locator('#fatalErrorOverlay')).toBeVisible();
      await expect(page.locator('#fatalErrorTitle')).toHaveText('Graphics interrupted');
      await expect(page.locator('#fatalErrorReloadBtn')).toBeFocused();
      await expect(page.locator('#gameCanvas')).toHaveCount(0);
      if (phase === 'run') {
        await testInfo.attach('webgl-context-recovery-dialog', {
          body: await page.screenshot(), contentType: 'image/png',
        });
      }
      releaseForest();
      const stopped = await probe.evaluate((p) => ({ active: p.getActive(), pos: { ...p.pos },
        elapsed: p.getElapsed(), renders: p.readRenders(), held: Object.values(p.controls).some(Boolean) }));
      expect(stopped.active).toBe(false);
      expect(stopped.held).toBe(false);
      await probe.evaluate((p) => {
        // A restored-event notification and stale callers must not reactivate
        // the instance; real recovery below obtains a fresh context by reload.
        p.canvas.dispatchEvent(new Event('webglcontextrestored'));
        p.start(); p.restart(); p.reset();
      });
      // Pass the loading/intro handoff deadline: this detects orphaned rAFs,
      // delayed starts, and Get Ready toasts, not merely immediate flag changes.
      await page.waitForTimeout(phase === 'forest' ? 6500 : phase === 'intro' ? 4500 : 2200);
      expect(await probe.evaluate((p) => ({ active: p.getActive(), pos: { ...p.pos },
        elapsed: p.getElapsed(), renders: p.readRenders(), held: Object.values(p.controls).some(Boolean) })))
        .toEqual(stopped);
      expect(await page.locator('body').getAttribute('class')).not.toMatch(/intro-active|game-active/);
      expect(errors).toEqual([]);
      const navigation = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
      await page.getByRole('button', { name: 'Reload', exact: true }).click();
      await navigation;
      await page.waitForFunction(() => typeof (window as unknown as RecoveryWindow).initializeGameWithAudio === 'function');
      await expect(page.locator('#fatalErrorOverlay')).toHaveCount(0);
      await expect(page.locator('#gameCanvas canvas')).toHaveCount(1);
      expect(await page.evaluate(() => !(window as unknown as RecoveryWindow).renderer.getContext().isContextLost())).toBe(true);
    });
  }
});
