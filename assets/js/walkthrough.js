/* Dechonk download walkthrough: vanilla JS, no build step.
 *
 * Every download CTA on the page carries data-download="auto|macos|windows|linux".
 * Clicking one opens a native <dialog> that auto-starts the right release asset
 * (resolved from the GitHub Releases API, cached in localStorage) and walks the
 * user through install + first launch. The anchors keep their releases-page
 * hrefs, so with JS disabled the old behavior is untouched.
 *
 * House rules: ES5-style like blackhole.js (var / function declarations, one
 * IIFE). All motion lives in CSS keyframes in index.html; this file only
 * orchestrates steps and lets the DOM it injects animate. Every scene's
 * default CSS state is a readable static frame, so killing animations under
 * prefers-reduced-motion costs nothing here.
 */
(function () {
  'use strict';

  /* ---- config ---------------------------------------------------------- */

  // Flip to true when Apple Developer ID signing + notarization activate
  // (D019, see docs/RELEASING.md). Removes the Gatekeeper "Open Anyway"
  // step from the macOS walkthrough.
  var NOTARIZED = false;

  var RELEASES_PAGE = 'https://github.com/chengsokdara/dechonk/releases';
  var API_URL = 'https://api.github.com/repos/chengsokdara/dechonk/releases/latest';
  var CACHE_KEY = 'dechonk-latest-release';
  var CACHE_TTL = 24 * 60 * 60 * 1000; // releases are rare; a day is plenty

  /* ---- state ----------------------------------------------------------- */

  var dlg = document.getElementById('walkthrough');
  if (!dlg || !dlg.showModal) return; // no <dialog> support: anchors behave as before

  var current = { platform: 'macos', step: 0 };
  var lastTrigger = null;
  var release = null;      // resolved release data, false = resolution failed, null = in flight/unknown
  var pending = null;      // shared in-flight request
  var autoStarted = {};    // per-platform "download already auto-triggered this visit"

  /* ---- tiny helpers ---------------------------------------------------- */

  function detectPlatform() {
    var ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Android/i.test(ua)) return 'linux';
    if (/Mac|iPhone|iPad/i.test(ua)) return 'macos';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return 'macos';
  }

  /* macOS era detection (D038): Chrome and Edge expose the real macOS
     major version via UA-CH platformVersion; Safari and Firefox expose
     nothing reliable and default to the modern flow, which is correct
     for every macOS from 13 (Ventura) on. ?macera=legacy|modern
     overrides detection (preview/test aid). */
  var macEra = 'modern'; // 'modern' (macOS 13+, System Settings) | 'legacy' (macOS 12-, System Preferences)
  (function initMacEra() {
    try {
      var q = new URLSearchParams(window.location.search).get('macera');
      if (q === 'legacy' || q === 'modern') { macEra = q; return; }
    } catch (e) { /* no URLSearchParams: keep the default */ }
    try {
      var uad = navigator.userAgentData;
      if (!uad || !uad.getHighEntropyValues) return;
      uad.getHighEntropyValues(['platformVersion']).then(function (v) {
        var m = /^(\d+)\./.exec((v && v.platformVersion) || '');
        var major = m ? parseInt(m[1], 10) : NaN;
        var era = isNaN(major) ? macEra : (major <= 12 ? 'legacy' : 'modern');
        if (era === macEra) return;
        macEra = era;
        if (dlg.open && current.platform === 'macos') render(false);
      }).catch(function () { /* best-effort */ });
    } catch (e) { /* detection must never break the modal */ }
  })();

  function assetKey(platform) {
    if (platform === 'macos') return 'dmg';
    if (platform === 'windows') return 'exe';
    return null;
  }

  function triggerDownload(url) {
    var a = document.createElement('a');
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.parentNode.removeChild(a); // release assets ship Content-Disposition: attachment, page stays put
  }

  /* ---- latest-release resolution ---------------------------------------- */

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !data.ts || Date.now() - data.ts > CACHE_TTL) return null;
      return data;
    } catch (e) { return null; }
  }

  function writeCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* private mode: skip */ }
  }

  // cb always fires exactly once with data or false. Never throws.
  function resolveRelease(cb) {
    if (release !== null) { cb(release); return; }
    if (!pending) {
      var cached = readCache();
      if (cached) { release = cached; cb(release); return; }
      pending = fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (rel) {
          var d = { ts: Date.now(), tag: rel.tag_name || '', dmg: null, dmgName: '', exe: null, exeName: '', msi: null, msiName: '' };
          (rel.assets || []).forEach(function (a) {
            var n = a.name || '', u = a.browser_download_url || '';
            if (!d.dmg && /\.dmg$/i.test(n)) { d.dmg = u; d.dmgName = n; }
            else if (!d.exe && /-setup\.exe$/i.test(n)) { d.exe = u; d.exeName = n; }
            else if (!d.msi && /\.msi$/i.test(n)) { d.msi = u; d.msiName = n; }
          });
          writeCache(d);
          release = d;
          return d;
        })
        .catch(function () {
          release = false;
          pending = null; // allow a retry on the next click
          return false;
        });
    }
    pending.then(cb);
  }

  function ensureAutoDownload(platform) {
    if (platform === 'linux' || autoStarted[platform]) return;
    autoStarted[platform] = true;
    resolveRelease(function (data) {
      updateDlStatus();
      if (!dlg.open || !data) return;
      var url = data[assetKey(platform)];
      if (url) triggerDownload(url);
    });
  }

  function manualDownload() {
    var data = (release && typeof release === 'object') ? release : null;
    var url = data ? data[assetKey(current.platform)] : null;
    if (url) triggerDownload(url);
    else window.open(RELEASES_PAGE, '_blank', 'noopener');
  }

  /* ---- step copy --------------------------------------------------------- */

  function macSteps() {
    var steps = [
      {
        scene: sceneDownload('dmg'), title: 'Ride the download home', hasDl: true,
        copy: 'Your download is already falling toward <span class="inline-code">Downloads</span>. One universal .dmg covers Apple Silicon and Intel alike, no choice to get wrong. If it never landed, the button below sends another copy.'
      },
      {
        scene: sceneDmg(), title: 'Mount. Drag. Done.',
        copy: 'Open the .dmg and drag Dechonk into Applications. That is the entire installation ceremony. There is, unfortunately, one more step.'
      }
    ];
    if (!NOTARIZED) {
      if (macEra === 'legacy') {
        steps.push({
          scene: sceneGatekeeperAlert('legacy'), title: 'Gatekeeper blocks the door',
          copy: 'Open Dechonk from Applications and Gatekeeper warns it \u201Ccan\u2019t be opened\u201D (wording varies by macOS version). Expected: we have not paid the Apple toll yet. Press the neutral button, <strong>Done</strong> or <strong>Cancel</strong> depending on what yours shows; never <strong>Move to Trash</strong>. This dialog cannot approve the app.'
        });
        steps.push({
          scene: scenePrivacySecurity('legacy'), title: 'Open Anyway lives in Security &amp; Privacy',
          copy: 'Open <strong>System Preferences \u2192 Security &amp; Privacy \u2192 the General tab</strong>. Next to \u201CDechonk\u201D was blocked, press <strong>Open Anyway</strong>, then confirm with <strong>Open</strong> if macOS asks. Leave <strong>Allow apps downloaded from</strong> on <strong>Mac App Store &amp; identified developers</strong>: that is already the correct setting, and this flow works with it untouched.'
        });
      } else {
        steps.push({
          scene: sceneGatekeeperAlert('modern'), title: 'Gatekeeper blocks the door',
          copy: 'Open Dechonk from Applications and macOS says it \u201Ccould not verify\u201D the app. Expected: we have not paid the Apple toll yet. Press <strong>Done</strong>; do not touch <strong>Move to Trash</strong>, whatever its blue glow says. Modern macOS shows no Open button in this dialog at all, so it cannot unblock the app.'
        });
        steps.push({
          scene: scenePrivacySecurity('modern'), title: 'Open Anyway lives in Settings',
          copy: 'Open <strong>System Settings \u2192 Privacy &amp; Security</strong> and scroll to the Security section. Next to \u201CDechonk\u201D was blocked to protect your Mac, press <strong>Open Anyway</strong>. Leave <strong>Allow applications from</strong> on <strong>App Store &amp; Known Developers</strong>: that is already the correct setting, and this flow works with it untouched. On macOS 12 or older this pane is called <strong>Security &amp; Privacy</strong>, inside <strong>System Preferences</strong>.'
        });
        steps.push({
          scene: sceneOpenConfirm(), title: 'One last confirmation',
          copy: 'macOS asks one final time: Open \u201CDechonk\u201D? Press <strong>Open Anyway</strong>, the middle button; not the blue Move to Trash. Dechonk opens, and the ceremony never repeats: after the first allow it launches like anything else. Older macOS versions word this dialog a little differently; the safe button is still <strong>Open Anyway</strong> or <strong>Open</strong>, never Move to Trash.'
        });
      }
    }
    steps.push({
      scene: scenePayoff(), title: 'Dechonk.',
      copy: 'Pick a scope, scan, and watch the chonk roll in. One click sends it past the event horizon: your Trash, the only horizon with a return policy. <strong>Your code stays. The gravity goes.</strong>'
    });
    return steps;
  }

  function winSteps() {
    return [
      {
        scene: sceneDownload('exe'), title: 'Grab the installer', hasDl: true,
        copy: 'The <span class="inline-code">-setup.exe</span> should already be parachuting into Downloads. Allergic to wizards? There is also an <span class="inline-code">.msi</span> on the releases page for the group-policy enjoyers.'
      },
      {
        scene: sceneOsDialog('windows'), title: 'SmartScreen will clutch its pearls',
        copy: '\u201CWindows protected your PC\u201D is the standard greeting for installers without a code-signing certificate. Press <strong>More info \u2192 Run anyway</strong>. It is us. We are the safe one.'
      },
      {
        scene: sceneWizard(), title: 'Next. Next. Finish.',
        copy: 'The installer takes about four seconds, then leaves Dechonk in your Start menu, where it waits patiently and weighs nothing.'
      },
      {
        scene: scenePayoff(), title: 'Dechonk.',
        copy: 'Pick a scope, scan, and watch the chonk roll in. One click sends it to the Recycle Bin: fully recoverable, as physics intended. <strong>Your code stays. The gravity goes.</strong>'
      }
    ];
  }

  function linuxSteps() {
    return [
      {
        scene: sceneOrbit(), title: 'Linux builds are still in orbit',
        copy: 'A <span class="inline-code">.deb</span> and an <span class="inline-code">AppImage</span> are on the roadmap; they will land on GitHub Releases when they escape the build farm. Watch that page. The blackhole, meanwhile, keeps feeding.'
      }
    ];
  }

  function getSteps(platform) {
    if (platform === 'windows') return winSteps();
    if (platform === 'linux') return linuxSteps();
    return macSteps();
  }

  /* ---- illustration scenes (default CSS state = readable static frame) --- */

  var ARROW_DOWN = '<svg class="wt-dlarrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v14"/><polyline points="6 11 12 17 18 11"/></svg>';
  var ARROW_RIGHT = '<svg class="wt-dmgarrow" width="60" height="14" viewBox="0 0 60 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 7h50" stroke-dasharray="4 4"/><path d="M47 2l7 5-7 5"/></svg>';
  var ALERT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var TRASH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  var HOLE = '<svg width="34" height="34" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="4.5" fill="#09090b" stroke="#34d399" stroke-width="1.6"/><ellipse cx="11" cy="11" rx="9.5" ry="3.4" stroke="#fb923c" stroke-width="1.4" transform="rotate(-18 11 11)"/></svg>';

  function sceneDownload(kind) {
    var data = (release && typeof release === 'object') ? release : null;
    var name = kind === 'dmg'
      ? (data && data.dmgName) || 'Dechonk_universal.dmg'
      : (data && data.exeName) || 'Dechonk_x64-setup.exe';
    var tag = kind === 'dmg' ? 'DMG · universal' : 'EXE · installer';
    return '<div class="wt-illus" aria-hidden="true"><div class="wt-dlchip">' +
      ARROW_DOWN +
      '<div class="wt-dltrack"><i class="wt-dlfill"></i></div>' +
      '<div class="wt-dlfile"><span class="wt-dlname">' + name + '</span><span class="wt-dltag">' + tag + '</span></div>' +
      '</div></div>';
  }

  function sceneDmg() {
    return '<div class="wt-illus" aria-hidden="true"><div class="wt-win">' +
      '<div class="wt-winhead"><i></i><i></i><i></i><span>Dechonk · disk image</span></div>' +
      '<div class="wt-dmgrow">' +
        '<div class="wt-appicon">' + HOLE + '<span>Dechonk</span></div>' +
        ARROW_RIGHT +
        '<div class="wt-folder"><span class="wt-foldershape"></span><span>Applications</span></div>' +
      '</div>' +
    '</div></div>';
  }

  function sceneOsDialog(platform) {
    var mac = platform === 'macos';
    return '<div class="wt-illus" aria-hidden="true"><div class="wt-osdlg">' +
      '<div class="wt-osdlg-title">' + ALERT + (mac ? 'macOS cannot verify the developer' : 'Windows protected your PC') + '</div>' +
      '<p>' + (mac
        ? '\u201CDechonk.app\u201D cannot be opened because it is from an unidentified developer.'
        : 'SmartScreen stopped an unrecognized app from starting. Running it might be a risk.') + '</p>' +
      '<div class="wt-osdlg-actions"><span class="wt-ghostbtn">' + (mac ? 'Done' : 'More info') + '</span><span class="wt-gobtn">' + (mac ? 'Open Anyway' : 'Run anyway') + '</span></div>' +
    '</div></div>';
  }

  /* macOS Gatekeeper alerts, reproduced from the real dialogs: modern
     (macOS 13+, verified on 27) and legacy (macOS 12-, wording varies by
     version). The blue button is Move to Trash in both eras, which is
     exactly the trap the cues mark. */
  function macAlertScene(o) {
    var btns = '<span class="wt-macbtn wt-macbtn--blue">Move to Trash<i class="wt-nobadge">no</i></span>';
    if (o.confirm) {
      btns += '<span class="wt-macbtn wt-macbtn--pick">Open Anyway<i class="wt-taptag">opens Dechonk</i></span>' +
        '<span class="wt-macbtn">Done</span>';
    } else {
      btns += '<span class="wt-macbtn wt-macbtn--pick">Done<i class="wt-taptag">' + o.tag + '</i></span>';
    }
    return '<div class="wt-illus wt-illus--tall" aria-hidden="true"><div class="wt-macalert">' +
      '<div class="wt-macapp">' + HOLE + '<i class="wt-macapp-warn">' + ALERT + '</i></div>' +
      '<div class="wt-macalert-title">' + o.title + '</div>' +
      '<p>' + o.body + '</p>' +
      '<div class="wt-macalert-actions">' + btns + '</div>' +
    '</div></div>';
  }

  function sceneGatekeeperAlert(era) {
    return macAlertScene(era === 'legacy' ? {
      title: '\u201CDechonk\u201D can\u2019t be opened',
      body: 'Apple cannot check \u201CDechonk\u201D for malicious software.',
      tag: 'keep it'
    } : {
      title: '\u201CDechonk\u201D Not Opened',
      body: 'Apple could not verify \u201CDechonk\u201D is free of malware that may harm your Mac or compromise your privacy.',
      tag: 'click Done'
    });
  }

  function sceneOpenConfirm() {
    return macAlertScene({
      confirm: true,
      title: 'Open \u201CDechonk\u201D?',
      body: 'Apple is not able to verify that it is free from malware that could harm your Mac or compromise your privacy. Don\u2019t open this unless you are certain it is from a trustworthy source.',
      tag: 'opens Dechonk'
    });
  }

  /* The Gatekeeper pane where Open Anyway lives, per era: sidebar item,
     the allow-source row (leave it alone), and the blocked-app row with
     the Open Anyway button. */
  function scenePrivacySecurity(era) {
    var legacy = era === 'legacy';
    return '<div class="wt-illus wt-illus--tall" aria-hidden="true"><div class="wt-win">' +
      '<div class="wt-winhead"><i></i><i></i><i></i><span>' + (legacy ? 'System Preferences' : 'System Settings') + '</span></div>' +
      '<div class="wt-secpane-cols">' +
        '<div class="wt-secpane-side"><span>' + (legacy ? 'Security &amp; Privacy' : 'Privacy &amp; Security') + '</span></div>' +
        '<div class="wt-secpane-main">' +
          '<div class="wt-secpane-sec">' + (legacy ? 'General' : 'Security') + '</div>' +
          '<div class="wt-secpane-row"><span>' + (legacy ? 'Allow apps downloaded from' : 'Allow applications from') + '</span><b>' +
            (legacy ? 'Mac App Store &amp; identified developers' : 'App Store &amp; Known Developers') +
            '<i class="wt-asisbadge">leave as is</i></b></div>' +
          '<div class="wt-secpane-blocked">' +
            '<b>' + (legacy
              ? '\u201CDechonk\u201D was blocked from use because it is not from an identified developer.'
              : '\u201CDechonk\u201D was blocked to protect your Mac.') + '</b>' +
            '<span class="wt-secpane-btn">Open Anyway<i class="wt-taptag">press</i></span>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div></div>';
  }

  function sceneWizard() {
    return '<div class="wt-illus" aria-hidden="true"><div class="wt-wizard">' +
      '<div class="wt-wizard-title">Dechonk Setup</div>' +
      '<div class="wt-dltrack"><i class="wt-dlfill wt-dlfill--fast"></i></div>' +
      '<div class="wt-wizard-actions"><span class="wt-ghostbtn">Cancel</span><span class="wt-gobtn">Install</span></div>' +
    '</div></div>';
  }

  function scenePayoff() {
    return '<div class="wt-illus" aria-hidden="true"><div class="wt-paywin">' +
      '<div class="wt-payhead"><i class="wt-livedot"></i><span>Dechonk · scan complete</span></div>' +
      '<div class="wt-payrow"><span class="wt-paypath">~/Projects/definitely-final-v2</span><span class="wt-paybadge">1.4 GB</span></div>' +
      '<div class="wt-trashzone">' + TRASH + '<span class="wt-freed">+1.4 GB freed</span></div>' +
    '</div></div>';
  }

  function sceneOrbit() {
    return '<div class="wt-illus" aria-hidden="true">' +
      '<div class="wt-orbitspace">' +
        '<div class="wt-orbitring"></div>' +
        '<div class="wt-orbitcore">' + HOLE + '</div>' +
        '<div class="wt-orbitspin"><span class="wt-orbitmoon"><span class="wt-orbitfolder"></span></span></div>' +
      '</div>' +
      '<span class="wt-orbittag">T-MINUS · ROADMAP</span>' +
    '</div>';
  }

  /* ---- step-1 download status line --------------------------------------- */

  function dlStatusHtml() {
    if (release === null) {
      return '<p class="wt-dlstatus is-busy" data-wt-dlstatus>finding the latest release\u2026</p>';
    }
    if (release === false) {
      return '<p class="wt-dlstatus" data-wt-dlstatus>couldn\u2019t reach GitHub; the button below knows the way.</p>';
    }
    var key = assetKey(current.platform);
    var name = release[key === 'dmg' ? 'dmgName' : 'exeName'];
    var url = release[key];
    if (!url) {
      return '<p class="wt-dlstatus" data-wt-dlstatus>no ' + (key === 'dmg' ? '.dmg' : 'installer') + ' found in the latest release; grab it from the releases page.</p>';
    }
    return '<p class="wt-dlstatus" data-wt-dlstatus>latest release' + (release.tag ? ' ' + release.tag : '') + ' \u2192 <span class="inline-code">' + name + '</span></p>';
  }

  function updateDlStatus() {
    var el = dlg.querySelector('[data-wt-dlstatus]');
    if (el) el.outerHTML = dlStatusHtml();
  }

  /* ---- rendering ---------------------------------------------------------- */

  function tabHtml(platform, label) {
    var active = current.platform === platform ? ' aria-pressed="true"' : ' aria-pressed="false"';
    return '<button type="button" class="wt-tab" data-wt="tab:' + platform + '"' + active + '>' + label + '</button>';
  }

  function render(focusBody) {
    var platform = current.platform;
    var steps = getSteps(platform);
    var idx = Math.min(current.step, steps.length - 1);
    current.step = idx;
    var step = steps[idx];
    var single = steps.length === 1;

    var dots = '';
    if (!single) {
      for (var i = 0; i < steps.length; i++) {
        dots += '<button type="button" class="wt-dot' + (i === idx ? ' is-active' : '') +
          '" data-wt="dot:' + i + '" aria-label="Go to step ' + (i + 1) + '"></button>';
      }
    }

    var meta = single ? '' :
      '<div class="wt-meta"><span class="wt-count">Step ' + (idx + 1) + ' of ' + steps.length + '</span>' +
      '<div class="wt-dots">' + dots + '</div></div>';

    var dlRow = step.hasDl
      ? '<div class="wt-dlrow"><button type="button" class="wt-dlbtn" data-wt="download">Download now</button>' +
        '<a class="wt-dlpage" href="' + RELEASES_PAGE + '" target="_blank" rel="noopener">releases page \u2197</a></div>'
      : (single
        ? '<div class="wt-dlrow"><a class="wt-dlbtn" href="' + RELEASES_PAGE + '" target="_blank" rel="noopener">Watch releases \u2197</a></div>'
        : '');

    var last = idx === steps.length - 1;
    var actions = single
      ? '<button type="button" class="wt-nav wt-nav--next" data-wt="close">Done</button>'
      : '<button type="button" class="wt-nav wt-nav--back" data-wt="back"' + (idx === 0 ? ' disabled' : '') + '>Back</button>' +
        '<button type="button" class="wt-nav wt-nav--next" data-wt="' + (last ? 'close' : 'next') + '">' + (last ? 'Done' : 'Next') + '</button>';

    dlg.innerHTML =
      '<div class="wt-panel">' +
        '<div class="wt-head">' +
          '<div>' +
            '<p class="wt-eyebrow">Install walkthrough</p>' +
            '<h2 class="wt-title" id="walkthrough-title">Getting Dechonk onto your machine</h2>' +
          '</div>' +
          '<button type="button" class="wt-close" data-wt="close" aria-label="Close walkthrough">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="wt-tabs" role="group" aria-label="Platform">' +
          tabHtml('macos', 'macOS') + tabHtml('windows', 'Windows') + tabHtml('linux', 'Linux') +
        '</div>' +
        step.scene +
        '<div class="wt-body" aria-live="polite"' + (focusBody ? ' tabindex="-1"' : '') + '>' +
          meta +
          '<h3 class="wt-step-title">' + step.title + '</h3>' +
          '<div class="wt-copy">' + step.copy + '</div>' +
          dlRow +
          (step.hasDl ? dlStatusHtml() : '') +
        '</div>' +
        '<div class="wt-actions">' + actions + '</div>' +
      '</div>';

    if (focusBody) {
      var body = dlg.querySelector('.wt-body');
      if (body) body.focus();
    }
  }

  /* ---- open / close -------------------------------------------------------- */

  function open(platform, trigger) {
    lastTrigger = trigger || null;
    current.platform = platform;
    current.step = 0;
    render(false);
    dlg.showModal();
    document.documentElement.classList.add('wt-lock');
    ensureAutoDownload(platform);
  }

  function close() {
    if (!dlg.open) return;
    dlg.close();
    cleanup(); // some engines deliver the 'close' event late; never wait for it
  }

  // Idempotent: close() runs it directly, the 'close' event (native Esc etc.)
  // runs it again as a no-op. Focus restore is deferred one task so it lands
  // after the browser's own dialog-close focus restore.
  function cleanup() {
    document.documentElement.classList.remove('wt-lock');
    var trigger = lastTrigger;
    lastTrigger = null;
    if (trigger && trigger.focus) {
      setTimeout(function () {
        try { trigger.focus(); } catch (e) { /* trigger may be gone */ }
      }, 0);
    }
  }

  dlg.addEventListener('close', cleanup);

  /* ---- events (delegated once; render() replaces innerHTML freely) --------- */

  dlg.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-wt]') : null;
    if (!el) {
      if (e.target === dlg) close(); // click on the ::backdrop
      return;
    }
    var action = el.getAttribute('data-wt');
    if (action === 'close') { close(); return; }
    if (action === 'download') { manualDownload(); return; }
    if (action === 'back') { current.step = Math.max(0, current.step - 1); render(true); return; }
    if (action === 'next') { current.step = current.step + 1; render(true); return; }
    if (action === 'dot' || action.indexOf('dot:') === 0) {
      current.step = parseInt(action.slice(4), 10) || 0;
      render(true);
      return;
    }
    if (action.indexOf('tab:') === 0) {
      var p = action.slice(4);
      if (p !== current.platform) {
        current.platform = p;
        current.step = 0;
        render(true);
        ensureAutoDownload(p);
      }
    }
  });

  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[data-download]') : null;
    if (!a) return;
    e.preventDefault();
    var p = a.getAttribute('data-download');
    open(p === 'auto' ? detectPlatform() : p, a);
  });
})();
