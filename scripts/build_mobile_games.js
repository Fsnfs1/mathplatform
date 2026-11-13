#!/usr/bin/env node
/**
 * scripts/build_mobile_games.js
 * Builds the phone-native full-screen ports games/*-mobile.html from the desktop
 * game sources (games/328.HTML, games/2.HTML, games/4.html) so game logic stays in
 * a single source of truth. Mobile ports:
 *  - viewport-fit=cover, 100dvh full-screen, safe-area aware, forced portrait layout
 *  - desktop-only chrome (layout toggles, fullscreen button, name input) removed
 *  - shared MobileGameShell HUD: ← 大廳 / real-name / ⏳ MM:SS countdown / net / mute
 *  - score reported via MobileGameShell.reportRound (skipDurationRecord: true)
 *  - 00:00 lockout stops the round; start is blocked while locked
 * Usage: node scripts/build_mobile_games.js   (re-run after editing a desktop game)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const GAMES_DIR = path.join(__dirname, '..', 'games');
const GAMES = [
  { src: '328.HTML', out: '328-mobile.html', gameId: 'trig-ratio', title: '三角比極速挑戰' },
  { src: '2.HTML', out: '2-mobile.html', gameId: 'bash-nim', title: '高級巴什博弈挑戰' },
  { src: '4.html', out: '4-mobile.html', gameId: 'ring-nim', title: '高級套圈博弈挑戰' },
];

const CORE_SCRIPTS = ['config', 'crypto', 'registry', 'storage', 'netwatch', 'api', 'sync', 'auth', 'bonus'];

const PORT_CSS = `
    <link rel="stylesheet" href="./mobile-shell.css">
    <style id="mobile-port-css">
        /* ---- phone-native port overrides ---- */
        html, body { height: 100%; height: 100dvh; }
        .controls-top-left, #fullscreen-toggle, #btn-portrait, #btn-landscape, #player-name { display: none !important; }
        .overlay { top: calc(var(--mgs-hud-h) + env(safe-area-inset-top)) !important; padding: 12px 12px calc(12px + env(safe-area-inset-bottom)); box-sizing: border-box; overflow-y: auto; justify-content: center; }
        .overlay h1 { font-size: clamp(1.8rem, 8vw, 2.6rem) !important; }
        .mega-btn { min-height: 56px; font-size: 1.25rem !important; padding: 14px 22px !important; touch-action: manipulation; }
        .game-wrapper, .game-wrapper.portrait { flex-direction: column !important; height: 100% !important; }
        .game-wrapper .geometry-pane { flex: 1.5 1 0 !important; width: 100% !important; min-height: 0; border-right: none !important; border-bottom: 3px solid #334155; }
        .game-wrapper .info-pane { flex: 1 1 0 !important; width: 100% !important; min-height: 0; padding: 8px 10px calc(8px + env(safe-area-inset-bottom)) !important; border-left: none !important; }
        .q-floating-header { top: 8px !important; }
        .question-stem { font-size: 1.1rem !important; padding: 6px 14px !important; }
        .instruction-text { font-size: 0.95rem !important; }
        .leaderboard-box { width: 94% !important; padding: 12px !important; }
        .mgs-player-tag { color: #06B6D4; font-weight: 800; font-size: 1.1rem; margin-top: 10px; text-align: center; }
    </style>
`;

function bootstrap(game) {
  return `
<script>
/* Mobile port bootstrap: binds the desktop game logic to MobileGameShell */
(function () {
    var GAME_ID = ${JSON.stringify(game.gameId)};
    function haltRound() {
        try { if (typeof timerInterval !== 'undefined') clearInterval(timerInterval); } catch (e) {}
        try { gameState = 'GAMEOVER'; } catch (e) {}
        try { SoundManager.stopBGM(); } catch (e) {}
        var w = document.getElementById('main-wrapper'); if (w) w.classList.add('hidden');
    }
    var ok = window.MobileGameShell.init({
        gameId: GAME_ID,
        title: ${JSON.stringify(game.title)},
        onLockout: haltRound,
        onMute: function (m) { if (m) { try { SoundManager.stopBGM(); } catch (e) {} } }
    });
    // Real-name player from the logged-in session (replaces desktop free-text name input)
    var stu = window.MobileGameShell.getStudent();
    var input = document.getElementById('player-name');
    if (stu && input) {
        input.value = stu.name || (stu.classID + ' ' + stu.studentID);
        var tag = document.createElement('div');
        tag.className = 'mgs-player-tag';
        tag.textContent = '實名玩家：' + stu.classID + ' ' + (stu.name || stu.studentID);
        input.parentNode.insertBefore(tag, input.nextSibling);
    }
    // Mute: gate all SFX / BGM through the HUD mute toggle
    try {
        var origPlay = SoundManager.play.bind(SoundManager);
        var origBgm = SoundManager.startBGM.bind(SoundManager);
        SoundManager.play = function () { if (!window.MobileGameShell.isMuted()) return origPlay.apply(null, arguments); };
        SoundManager.startBGM = function () { if (!window.MobileGameShell.isMuted()) return origBgm.apply(null, arguments); };
    } catch (e) {}
    // Block starting a round when today's playtime is used up
    var origStart = window.startGame;
    window.startGame = function () {
        if (!ok || window.MobileGameShell.isLocked() || window.MobileGameShell.getPlaytimeStatus().locked) { return; }
        return origStart.apply(this, arguments);
    };
})();
</script>`;
}

function buildPort(game) {
  let html = fs.readFileSync(path.join(GAMES_DIR, game.src), 'utf8');
  const before = html;
  const must = (re, repl, label) => {
    if (!re.test(html)) throw new Error(game.src + ': transform failed: ' + label);
    html = html.replace(re, repl);
  };

  must(/<meta name="viewport"[^>]*>/i,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">\n    <meta name="theme-color" content="#020617">\n    <meta name="mobile-web-app-capable" content="yes">', 'viewport');
  must(/<title>([^<]*)<\/title>/i, '<title>$1（手機版）</title>', 'title');
  must(/<\/style>\s*<\/head>/i, '</style>' + PORT_CSS + '</head>', 'port css');
  must(/setLayout\(isMobile \? 'portrait' : 'landscape'\);/, "setLayout('portrait'); /* mobile port: always portrait */", 'force portrait');
  // Score reporting through the shell (time is tracked live by the shell, never double-counted)
  must(/window\.GameBridge\.report\(/g, 'window.MobileGameShell.reportRound(', 'report');
  html = html.replace(/if \(window\.GameBridge\)/g, 'if (window.MobileGameShell)');
  html = html.replace(/window\.GameBridge\.getCurrentStudent\(\)/g, 'window.MobileGameShell.getStudent()');
  // Replace the desktop script tail with the full core stack + shell + bootstrap
  must(/<script src="\.\.\/core\/config\.js"><\/script>\s*<script src="\.\.\/core\/bonus\.js"><\/script>/,
    CORE_SCRIPTS.map(n => `<script src="../core/${n}.js"></script>`).join('\n') +
    '\n<script src="./mobile-shell.js"></script>' + bootstrap(game), 'script tail');

  if (/window\.GameBridge\b/.test(html)) throw new Error(game.src + ': leftover GameBridge reference');
  const banner = `<!-- AUTO-GENERATED by scripts/build_mobile_games.js from games/${game.src}. Phone-native full-screen port. -->\n`;
  html = html.replace(/^<!DOCTYPE html>/i, m => m + '\n' + banner);
  fs.writeFileSync(path.join(GAMES_DIR, game.out), html);
  return { out: game.out, bytes: html.length, changed: html !== before };
}

if (require.main === module) {
  GAMES.forEach(g => console.log('built', buildPort(g)));
}
module.exports = { buildPort, GAMES };
