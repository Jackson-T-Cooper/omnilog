import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const CHROME_BIN =
  '/Users/jacksoncooper/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const BASE_URL = process.env.BASE_URL || 'http://localhost:4173';

export async function runMobileViewportAudit() {
  if (!fs.existsSync(CHROME_BIN)) {
    console.log('⚠️ Skipping headless Chromium audit (binary not found)');
    return { skipped: true };
  }

  const debugPort = 9333 + Math.floor(Math.random() * 400);
  const userDataDir = `/tmp/omnilog-cdp-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const proc = spawn(
    CHROME_BIN,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  try {
    // Wait for /json/list endpoint
    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        if (res.ok) {
          const targets = await res.json();
          const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (pageTarget) {
            wsUrl = pageTarget.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(wsUrl, 'Connected to Headless Chrome DevTools Protocol target');

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let msgId = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });

    function sendCdp(method, params = {}) {
      const id = ++msgId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evalInPage(expression) {
      const res = await sendCdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res.exceptionDetails) {
        throw new Error(
          `Page evaluation error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`
        );
      }
      return res.result?.value;
    }

    await sendCdp('Page.enable');
    await sendCdp('Runtime.enable');

    const viewports = [
      { name: 'iPhone 14/15 (375x812)', width: 375, height: 812 },
      { name: 'iPhone SE / Compact (320x568)', width: 320, height: 568 }
    ];

    const report = [];

    for (const vp of viewports) {
      await sendCdp('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 3,
        mobile: true
      });

      await sendCdp('Page.navigate', { url: `${BASE_URL}/app` });
      // Wait for app ready
      for (let i = 0; i < 40; i++) {
        const ready = await evalInPage(
          `Boolean(document.readyState === 'complete' && document.querySelector('.site-header') && document.querySelector('#mobileBottomNav'))`
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 250));

      const checkLayoutState = async (stateLabel) => {
        const metrics = await evalInPage(`(() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const docScrollWidth = document.documentElement.scrollWidth;
          const bodyScrollWidth = document.body.scrollWidth;
          const offenders = [];
          const squished = [];
          for (const el of document.querySelectorAll('body *')) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
            // Skip elements inside closed dialogs or hidden ancestors
            const closedDlg = el.closest('dialog:not([open])');
            if (closedDlg) continue;
            if (el.closest('.hidden')) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            // Check if element is inside a horizontally scrollable container
            let inScrollX = false;
            let parent = el.parentElement;
            while (parent && parent !== document.body && parent !== document.documentElement) {
              const ps = window.getComputedStyle(parent);
              if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') {
                inScrollX = true;
                break;
              }
              parent = parent.parentElement;
            }

            if (!inScrollX && (rect.right > vw + 1.5 || rect.left < -1.5)) {
              offenders.push({
                tag: el.tagName.toLowerCase(),
                id: el.id || '',
                className: String(el.className || '').slice(0, 60),
                left: Math.round(rect.left * 10) / 10,
                right: Math.round(rect.right * 10) / 10,
                width: Math.round(rect.width * 10) / 10,
                vw
              });
            }

            // Check buttons / pills for squishing (e.g., button narrower than 30px or taller than 88px due to vertical letter wrapping)
            if (el.matches('button, .btn, .pill, .tab-btn')) {
              const text = (el.innerText || '').trim();
              if (text.length >= 4 && (rect.width < 32 || rect.height > 84)) {
                squished.push({
                  tag: el.tagName.toLowerCase(),
                  id: el.id || '',
                  className: String(el.className || '').slice(0, 60),
                  text: text.slice(0, 30),
                  width: Math.round(rect.width * 10) / 10,
                  height: Math.round(rect.height * 10) / 10
                });
              }
            }
          }
          return {
            vw,
            vh,
            docScrollWidth,
            bodyScrollWidth,
            offenders: offenders.slice(0, 10),
            squished: squished.slice(0, 10)
          };
        })()`);

        assert.ok(
          metrics.docScrollWidth <= vp.width + 1,
          `[${vp.name} - ${stateLabel}] documentElement.scrollWidth (${metrics.docScrollWidth}) must be <= ${vp.width}`
        );
        assert.equal(
          metrics.offenders.length,
          0,
          `[${vp.name} - ${stateLabel}] Zero elements overflowing viewport width (${vp.width}px), found: ${JSON.stringify(metrics.offenders)}`
        );
        assert.equal(
          metrics.squished.length,
          0,
          `[${vp.name} - ${stateLabel}] Zero squished buttons/pills on (${vp.width}px), found: ${JSON.stringify(metrics.squished)}`
        );
        report.push({ viewport: vp.name, state: stateLabel, docScrollWidth: metrics.docScrollWidth });
      };

      // 1. Check all main tabs (feed, discover, lists, watchlist, stats, profile)
      for (const tab of ['feed', 'discover', 'lists', 'watchlist', 'stats', 'profile']) {
        await evalInPage(`(() => {
          const btn = document.querySelector('[data-mobile-nav="${tab}"], [data-tab="${tab}"]');
          if (btn) btn.click();
        })()`);
        await new Promise((r) => setTimeout(r, 120));
        await checkLayoutState(`tab:${tab}`);
      }

      // 2. Open Auth Modal (#userDialog) & check signup / login / letterboxd tabs
      await evalInPage(`(() => {
        const btn = document.getElementById('openAuthModalBtn') || document.getElementById('openEditProfileBtn');
        if (btn) btn.click();
      })()`);
      await new Promise((r) => setTimeout(r, 120));
      await checkLayoutState('modal:userDialog-signup');

      await evalInPage(`(() => {
        const loginTab = document.getElementById('authTabLogin');
        if (loginTab) loginTab.click();
      })()`);
      await new Promise((r) => setTimeout(r, 80));
      await checkLayoutState('modal:userDialog-login');

      await evalInPage(`(() => {
        const dlg = document.getElementById('userDialog');
        if (dlg && dlg.open) dlg.close();
      })()`);
      await new Promise((r) => setTimeout(r, 80));

      // 3. Switch to discover and open first media detail modal (#detailDialog)
      await evalInPage(`(() => {
        const btn = document.querySelector('[data-mobile-nav="discover"], [data-tab="discover"]');
        if (btn) btn.click();
      })()`);
      await new Promise((r) => setTimeout(r, 120));
      await evalInPage(`(() => {
        const card = document.querySelector('[data-open-detail]');
        if (card) card.click();
      })()`);
      await new Promise((r) => setTimeout(r, 120));
      await checkLayoutState('modal:detailDialog');

      await evalInPage(`(() => {
        const dlg = document.getElementById('detailDialog');
        if (dlg && dlg.open) dlg.close();
      })()`);
    }

    ws.close();
    return { skipped: false, checks: report.length, report };
  } finally {
    proc.kill('SIGKILL');
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMobileViewportAudit()
    .then((res) => {
      console.log('✅ Mobile Viewport Headless Chromium Audit Passed:', res.checks, 'states verified');
    })
    .catch((err) => {
      console.error('❌ Mobile Viewport Headless Chromium Audit Failed:', err);
      process.exit(1);
    });
}
