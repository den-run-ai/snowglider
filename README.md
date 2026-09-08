# September physics-v3 release screenshots

These three PNGs are exact, unmodified Playwright attachments from [GitHub Actions run 34203188015](https://github.com/den-run-ai/snowglider/actions/runs/34203188015), application commit `6a56f0b4b4f76c5f86a75d34e4ae54665a5044b3`.

The Chromium case `real-player release notice, About, and EZ mountain screenshots` in `tests/e2e/accessibility.spec.ts` captured a 1440 × 1000 viewport. It set `navigator.webdriver = false`, opened `?eztrees=1`, and used the real reduced-motion preference to skip the intro. Its EZ-Tree branch-instance assertion passed before the mountain screenshot. These are the player visuals, not the automation cone-tree fallback.

| File | CI attachment file | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| start.png | `17668d2872935f2b9fece4c7089f06ac2db3ba5f.png` | 204884 | `04e9109f4f71c158dc28438a5afda33f83ecb797024d71d97d324271b108bfdc` |
| about.png | `08a5cbcf6d59c90b018247fe6871f0b4f1bef9ba.png` | 215097 | `f57f987148ecb6921f422b9ca301a8abaf182933b2efa97572cb75477a87745f` |
| mountain.png | `481995b44abb056a76a302fb3a74da5177c43ce0.png` | 804706 | `901e669f036811b15858b0e05034d7e252f4cd2370002a98131ccf10db2527ca` |

This asset branch must never be merged into the application. Its tree contains only these three PNGs and this provenance file. The GitHub connector requires a parent for commit creation, so this commit descends only from the existing parentless screenshot commit `30481436c75ff5b6e17ab9c728c9d01380dd5e78` (`assets/terrain-401`). It has no application-history ancestor.
