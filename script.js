

(function () {
    'use strict';

    // ─── DEVICE DETECTION ────────────────────────────────────────────────────────
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (window.innerWidth <= 768);
    const isLowEnd = isMobile && (navigator.hardwareConcurrency || 4) <= 4;
    const Q = isLowEnd ? 0 : isMobile ? 1 : 2;

    const MAX_PARTICLES = [60, 110, 220][Q];
    const MAX_SLASH = [4, 6, 12][Q];
    const MAX_SHOCKWAVE = [2, 3, 6][Q];
    const TRAIL_LEN = [12, 14, 16][Q];
    const PARTICLE_N = [8, 13, 22][Q];
    const USE_SHADOW = Q === 2;
    // FIX: Process every frame on mobile for better tracking accuracy
    // Only skip on very low-end devices
    const MP_SKIP = isLowEnd ? 2 : 1;

    // FIX: Landmark smoothing — reduces jitter without adding lag
    // Higher alpha = more smoothing (0 = none, 0.6 = heavy)
    const SMOOTH_ALPHA = isMobile ? 0.50 : 0.30;

    let bestScore = 0;
    let W = window.innerWidth, H = window.innerHeight;

    // ─── VIDEO → SCREEN COORDINATE MAPPING (cover-crop) ─────────────────────────
    let vt = { ox: 0, oy: 0, drawW: W, drawH: H, ready: false };

    function updateVideoTransform(vid) {
        if (!vid || !vid.videoWidth || !vid.videoHeight) return;
        const scale = Math.max(W / vid.videoWidth, H / vid.videoHeight);
        vt = {
            ox: (W - vid.videoWidth * scale) / 2,  // will be ≤ 0 for cover
            oy: (H - vid.videoHeight * scale) / 2,
            drawW: vid.videoWidth * scale,
            drawH: vid.videoHeight * scale,
            ready: true
        };
    }

    // FIX: Correct landmark normalisation accounting for cover-crop + selfie mirror
    // In selfie mode MP already flips x, so:
    //   screen_x = (lx * drawW + ox) / W
    function landmarkToNorm(lx, ly) {
        if (!vt.ready) return { x: lx, y: ly };
        return {
            x: clamp((lx * vt.drawW + vt.ox) / W, 0, 1),
            y: clamp((ly * vt.drawH + vt.oy) / H, 0, 1)
        };
    }

    const CFG = {
        gravity: .00028, minVy: -.018, maxVy: -.024, maxVx: .006,
        maxFruits: 8, bombChance: .13,
        trailLen: TRAIL_LEN,
        spawnRate: 1100, comboWindow: 900,
    };
    const DIFF_RAMP_MS = 90000;

    const SPECIAL_FRUITS = ['⭐', '💎', '🔥', '2️⃣', '⚡', '🛡️', '❄️', '💰', '🎯', '❤️'];
    const FRUITS = ['🍎', '🍏', '🍊', '🍋', '🍇', '🍓', '🍉', '🍌', '🍍', '🥝', '🍒', '🍑', '🥭', '🫐', '🍐', '🥥', '🍈', '🍅', '🌶️', '🥕'];

    const FRUIT_COLORS = {
        '🍎': ['#ff2d2d', '#ff6b6b', '#ffc1c1'], '🍏': ['#7CFC00', '#a8ff60', '#dfffaa'],
        '🍊': ['#ff8800', '#ffaa33', '#ffd699'], '🍋': ['#ffd700', '#fff066', '#fff9b0'],
        '🍇': ['#8e44ad', '#c084fc', '#e0bbff'], '🍓': ['#ff1744', '#ff616f', '#ffb3b3'],
        '🍉': ['#ff3b5c', '#2ecc71', '#a3ffb0'], '🍌': ['#ffd60a', '#ffe066', '#fff3b0'],
        '🍍': ['#ffcc00', '#99cc00', '#ddff55'], '🥝': ['#27ae60', '#7bed9f', '#c7f9cc'],
        '🍒': ['#c0392b', '#ff4d6d', '#ff99aa'], '🍑': ['#ff7f50', '#ffb385', '#ffd6b3'],
        '🥭': ['#ff9f1c', '#ffbf69', '#ffe8a1'], '🫐': ['#3a0ca3', '#5a189a', '#b8a9ff'],
        '🍐': ['#a3e635', '#d9f99d', '#f7fee7'], '🥥': ['#8d6e63', '#bcaaa4', '#efebe9'],
        '🍈': ['#9ccc65', '#c5e1a5', '#f1f8e9'], '🍅': ['#e53935', '#ff6f61', '#ffcdd2'],
        '🌶️': ['#d00000', '#ff4d00', '#ffba08'], '🥕': ['#f77f00', '#ff9f1c', '#ffd6a5'],
    };

    const SPRITE_SIZE = isMobile ? 72 : 90;
    const spriteCache = {};
    function getSprite(emoji) {
        if (spriteCache[emoji]) return spriteCache[emoji];
        const c = document.createElement('canvas'); c.width = c.height = SPRITE_SIZE;
        const cx = c.getContext('2d');
        cx.font = `bold ${SPRITE_SIZE - 6}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
        cx.textAlign = 'center'; cx.textBaseline = 'middle';
        cx.fillText(emoji, SPRITE_SIZE / 2, SPRITE_SIZE / 2 + 2);
        spriteCache[emoji] = c; return c;
    }
    function preWarmSprites() { [...FRUITS, ...SPECIAL_FRUITS, '💣', '💥'].forEach(getSprite); }

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const lerp = (a, b, t) => a + (b - a) * t;

    const sc = document.getElementById('sc');
    const sctx = sc.getContext('2d', { alpha: true });
    const splashes = [];

    function pushSplash(x, y, text, color, scale) {
        scale = scale || 1;
        splashes.push({ x, y, text, color, size: Math.round(26 * scale), life: 1 });
    }
    function drawSplashes(frameScale) {
        sctx.clearRect(0, 0, W, H);
        for (let i = splashes.length - 1; i >= 0; i--) {
            const s = splashes[i];
            s.life -= 0.05 * frameScale;
            s.y -= 1.2 * frameScale;
            if (s.life <= 0) { splashes.splice(i, 1); continue; }
            sctx.globalAlpha = Math.min(1, s.life * 2);
            sctx.font = `bold ${s.size}px Bangers, cursive`;
            sctx.fillStyle = s.color;
            sctx.textAlign = 'center';
            sctx.fillText(s.text, s.x, s.y);
        }
        sctx.globalAlpha = 1;
    }

    let active = false;
    let startGateWaiting = false;
    let startGateCounting = false;
    let startGateCountdownVal = 0;
    let startGateFirstSeenTs = 0;
    let startGateLastSeenTs = 0;
    let startGateTimer = null;
    let usingPointerFallback = false;
    let score = 0, lives = 3, combo = 1;
    let slicedCount = 0, missedCount = 0, bestCombo = 1;
    let comboTimer = null, spawnTimer = null;
    let fruits = [], bombs = [], particles = [], trail = [], slashMarks = [];
    let shockwaves = [];
    let screenFlash = null, shakeAmt = 0, fingerSpeed = 0, timeScale = 1, slowMoTimer = null;
    let lastFrameTs = 0, gameStartTs = 0, lastSpawnAt = 0, gameTime = 0;
    let mpFrameCount = 0;

    let superSliceMode = false, superSliceTimer = null;
    let doubleScore = false, doubleScoreTimer = null;
    let comboFreeze = false, comboFreezeTimer = null;
    let bombShield = false;
    let autoSliceTimer = null, autoSliceStopTimer = null;
    let shieldSpawnedThisGame = false;
    const activePowers = {};

    // Smooth finger position state
    let smoothX = null, smoothY = null;
    let detectionLostTimer = null;
    let trailDecayInterval = null;
    // FIX: Track last known position + last detection timestamp
    let lastKnownX = null, lastKnownY = null;
    let lastDetectionTs = 0;
    // How many consecutive frames hand was not detected
    let missedFrames = 0;

    const camC = document.getElementById('cam');
    const gc = document.getElementById('gc');
    const cCam = camC.getContext('2d', { alpha: false });
    const ctx = gc.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    cCam.imageSmoothingEnabled = false;

    function resizeCanvases() {
        W = window.innerWidth; H = window.innerHeight;
        camC.width = gc.width = sc.width = W;
        camC.height = gc.height = sc.height = H;
        ctx.imageSmoothingEnabled = false;
    }
    resizeCanvases();
    window.addEventListener('resize', () => {
        resizeCanvases();
        if (video) updateVideoTransform(video);
    });

    const scoreValEl = document.getElementById('scoreVal');
    const comboPill = document.getElementById('comboPill');
    const overlay = document.getElementById('overlay');
    const ovTitle = document.getElementById('ovTitle');
    const ovSub = document.getElementById('ovSub');
    const startGate = document.getElementById('startGate');
    const startHint = document.getElementById('startHint');
    const startCountdown = document.getElementById('startCountdown');
    const ovScore = document.getElementById('ovScore');
    const ovStats = document.getElementById('ovStats');
    const statSliced = document.getElementById('statSliced');
    const statMissed = document.getElementById('statMissed');
    const statBest = document.getElementById('statBest');
    const statHigh = document.getElementById('statHigh');
    const startBtn = document.getElementById('startBtn');
    const restartBtn = document.getElementById('restartBtn');
    const loadBar = document.getElementById('loadBar');
    const wrap = document.getElementById('wrap');
    const powerBar = document.getElementById('powerBar');
    const mobileTip = document.getElementById('mobileTip');

    // Hide mobile tip after a few seconds
    // setTimeout(() => {
    //     if (mobileTip) mobileTip.style.transition = 'opacity 0.8s';
    //     if (mobileTip) mobileTip.style.opacity = '0';
    //     setTimeout(() => { if (mobileTip) mobileTip.remove(); }, 900);
    // }, 4000);

    // ─── AUDIO ───────────────────────────────────────────────────────────────────
    let audioCtx = null;
    function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    function resumeAudio() { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); }
    function playSlice(q) {
        if (!audioCtx) return; resumeAudio();
        const now = audioCtx.currentTime;
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination); o.type = 'sine';
        o.frequency.setValueAtTime(900 + q * 300, now); o.frequency.exponentialRampToValueAtTime(300, now + .13);
        g.gain.setValueAtTime(.14, now); g.gain.exponentialRampToValueAtTime(.001, now + .15);
        o.start(now); o.stop(now + .16);
    }
    function playPowerUp() {
        if (!audioCtx) return; resumeAudio();
        const now = audioCtx.currentTime;
        [0, .08, .16].forEach((d, i) => {
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.connect(g); g.connect(audioCtx.destination); o.type = 'sine';
            o.frequency.value = 600 + i * 200; g.gain.setValueAtTime(.12, now + d); g.gain.exponentialRampToValueAtTime(.001, now + d + .18);
            o.start(now + d); o.stop(now + d + .2);
        });
    }
    function playBombCut() {
        if (!audioCtx) return; resumeAudio();
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.type = 'sawtooth'; osc.frequency.setValueAtTime(140, now); osc.frequency.exponentialRampToValueAtTime(40, now + .25);
        gain.gain.setValueAtTime(.18, now); gain.gain.exponentialRampToValueAtTime(.001, now + .35);
        osc.connect(gain); gain.connect(audioCtx.destination); osc.start(now); osc.stop(now + .35);
    }
    function playMiss() {
        if (!audioCtx) return; resumeAudio();
        const now = audioCtx.currentTime;
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination); o.type = 'sawtooth'; o.frequency.value = 200;
        g.gain.setValueAtTime(.05, now); g.gain.exponentialRampToValueAtTime(.001, now + .25);
        o.start(now); o.stop(now + .26);
    }

    // ─── POWER BAR ───────────────────────────────────────────────────────────────
    function addPowerBadge(id, label, color, durationMs) {
        activePowers[id] = { label, color, total: durationMs, remaining: durationMs };
        renderPowerBar();
        if (!durationMs || durationMs <= 0) return;
        setTimeout(() => {
            const el = document.getElementById('pw_' + id);
            if (el) el.classList.add('pw-expire');
            setTimeout(() => { delete activePowers[id]; renderPowerBar(); }, 500);
        }, durationMs);
    }
    function renderPowerBar() {
        powerBar.innerHTML = Object.entries(activePowers).map(([id, p]) => `
                <div id="pw_${id}" class="pw-badge flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bangers tracking-wide border"
                    style="background:${p.color}22;border-color:${p.color}55;color:${p.color}">${p.label}</div>`).join('');
    }

    // ─── HUD HELPERS ─────────────────────────────────────────────────────────────
    function updateHearts() {
        for (let i = 1; i <= 3; i++) {
            const h = document.getElementById('h' + i);
            if (i <= lives) { h.innerHTML = '❤️'; h.classList.remove('dead'); }
            else { h.textContent = '🖤'; h.classList.add('dead'); }
        }
        scoreValEl.textContent = score;
        if (bombShield) document.getElementById('livesBox').classList.add('shield-active');
        else document.getElementById('livesBox').classList.remove('shield-active');
    }
    function loseHeart() {
        const idx = lives; const h = document.getElementById('h' + idx);
        if (h) { h.classList.add('pop'); setTimeout(() => h.classList.remove('pop'), 350); }
        lives--; updateHearts();
    }
    function setCombo(n) {
        combo = n; if (combo > bestCombo) bestCombo = combo;
        comboPill.textContent = 'x' + combo;
        comboPill.style.borderColor = combo > 1 ? '#f9a826' : '';
        comboPill.style.color = combo > 1 ? '#f9a826' : '';
        if (combo === 3 || combo === 5) showComboFlash('x' + combo + ' COMBO!');
    }
    function setSlowMotion(scale, duration) {
        timeScale = scale; clearTimeout(slowMoTimer);
        slowMoTimer = setTimeout(() => { timeScale = 1; }, duration);
    }
    function randomPowerDurationMs() { return 5000 + Math.floor(Math.random() * 2001); }
    function runAutoSliceBurst() {
        fruits.forEach(f => {
            if (!f.sliced && f.y < 1.05 && f.y > -.1) {
                f.sliced = true; slicedCount++;
                score += 10 * (doubleScore ? 2 : 1);
                epicSliceEffect(f.x * W, f.y * H, f.emoji, 1);
            }
        });
        updateHearts();
    }
    function getDifficultyState() {
        const now = performance.now();
        const elapsedMs = Math.max(0, now - gameStartTs);
        const timeT = clamp(elapsedMs / DIFF_RAMP_MS, 0, 1);
        const scoreT = clamp(score / 900, 0, 1);
        const progress = clamp(Math.max(timeT, scoreT * .85), 0, 1);
        const bombT = clamp((progress - .25) / .75, 0, 1);
        const speedProgress = Math.pow(progress, 1.4);
        return {
            progress,
            speedScale: lerp(.90, 1.12, speedProgress),
            spawnRate: Math.round(lerp(1450, 620, progress)),
            maxFruits: Math.round(lerp(3, 10, progress)),
            bombChance: lerp(0, .22, bombT),
            maxBombs: bombT < .2 ? 0 : (bombT < .7 ? 1 : 2),
        };
    }

    // ─── POWER-UPS ───────────────────────────────────────────────────────────────
    function activatePower(emoji, cx, cy, basePts) {
        playPowerUp();
        let pts = basePts, splashText = '', splashColor = '#f9a826';
        switch (emoji) {
            case '⭐': pts = basePts + 30; splashText = '⭐ +30 BONUS!'; splashColor = '#ffd700'; addPowerBadge('star', '⭐ +30', '#ffd700', 800); break;
            case '💎': const b2 = Math.random() < .5 ? 50 : 100; pts = basePts + b2; splashText = '💎 +' + b2 + '!'; splashColor = '#88aaff'; addPowerBadge('gem', `💎 +${b2}`, '#88aaff', 800); break;
            case '🔥': const fMs = randomPowerDurationMs(); superSliceMode = true; clearTimeout(superSliceTimer); superSliceTimer = setTimeout(() => { superSliceMode = false; delete activePowers['fire']; renderPowerBar(); }, fMs); splashText = '🔥 SUPER SLICE!'; splashColor = '#ff8800'; addPowerBadge('fire', '🔥 SUPER x3', '#ff6600', fMs); break;
            case '2️⃣': const dMs = 2600; clearTimeout(doubleScoreTimer); doubleScore = false; setSlowMotion(1.45, dMs); splashText = '2️⃣ FAST!'; splashColor = '#ff44ff'; addPowerBadge('double', '2️⃣ FAST', '#ff44ff', dMs); break;
            case '⚡': const cMs = randomPowerDurationMs(); comboFreeze = true; clearTimeout(comboFreezeTimer); comboFreezeTimer = setTimeout(() => { comboFreeze = false; }, cMs); splashText = '⚡ COMBO LOCK!'; splashColor = '#ffff44'; addPowerBadge('bolt', '⚡ COMBO LOCK', '#ffff44', cMs); break;
            case '🛡️': bombShield = true; splashText = '🛡️ SHIELD!'; splashColor = '#22d46e'; addPowerBadge('shield', '🛡️ SHIELD', '#22d46e', 0); updateHearts(); break;
            case '❄️': const iMs = 2200; setSlowMotion(.55, iMs); pts = basePts + 40; splashText = '❄️ SLOW!'; splashColor = '#aaeeff'; addPowerBadge('ice', '❄️ SLOW', '#aaeeff', iMs); break;
            case '💰': pts = basePts + 75; splashText = '💰 +75!'; splashColor = '#ffd700'; addPowerBadge('coin', '💰 +75', '#ffd700', 800); break;
            case '🎯': const aMs = randomPowerDurationMs(); splashText = '🎯 AUTO!'; splashColor = '#ff5555'; addPowerBadge('auto', '🎯 AUTO', '#ff5555', aMs); clearInterval(autoSliceTimer); clearTimeout(autoSliceStopTimer); runAutoSliceBurst(); autoSliceTimer = setInterval(runAutoSliceBurst, 300); autoSliceStopTimer = setTimeout(() => { clearInterval(autoSliceTimer); autoSliceTimer = null; }, aMs); break;
            case '❤️': if (lives < 3) { lives++; splashText = '❤️ +1 LIFE!'; splashColor = '#ff5c7a'; addPowerBadge('heart', '❤️ +1', '#ff5c7a', 1000); } else { pts = basePts + 20; splashText = '❤️ +20!'; splashColor = '#ff9bb2'; addPowerBadge('heart', '❤️ +20', '#ff9bb2', 800); } break;
        }
        return { pts, splashText, splashColor };
    }

    // ─── SPAWN ───────────────────────────────────────────────────────────────────
    function spawnItem(diff = getDifficultyState(), mode = 'auto') {
        if (!active) return;
        const x = .13 + Math.random() * .74;
        const speedScale = diff.speedScale;
        const vyBase = CFG.minVy + Math.random() * (CFG.maxVy - CFG.minVy);
        const vy = vyBase * speedScale, vx = ((Math.random() - .5) * 2 * CFG.maxVx) * speedScale;
        const rot = Math.random() * Math.PI * 2, rotV = (Math.random() - .5) * .08;
        const canSpawnBomb = diff.maxBombs > 0 && bombs.length < diff.maxBombs;
        const wantsBomb = mode === 'bomb' || (mode === 'auto' && Math.random() < diff.bombChance);
        if (canSpawnBomb && wantsBomb) {
            bombs.push({ x, y: 1.05, vx, vy, gScale: speedScale * speedScale, r: .052, sliced: false, sliceT: 0, rot, rotV });
        } else {
            const isSpecial = Math.random() < .12;
            const sPool = shieldSpawnedThisGame ? SPECIAL_FRUITS.filter(e => e !== '🛡️') : SPECIAL_FRUITS;
            const emoji = isSpecial ? sPool[Math.floor(Math.random() * sPool.length)] : FRUITS[Math.floor(Math.random() * FRUITS.length)];
            if (emoji === '🛡️') shieldSpawnedThisGame = true;
            fruits.push({ x, y: 1.05, vx, vy, gScale: speedScale * speedScale, r: .058, emoji, sliced: false, sliceT: 0, rot, rotV });
        }
    }
    function spawnBurst(diff = getDifficultyState()) {
        if (!active) return;
        const liveFruits = fruits.filter(f => !f.sliced).length;
        const total = liveFruits + bombs.length;
        const slots = Math.max(0, diff.maxFruits - total);
        if (slots < 1) return;
        const burstCount = Math.min(slots, 1 + Math.floor(Math.random() * 3));
        const canSpawnBomb = diff.maxBombs > 0 && bombs.length < diff.maxBombs;
        const includeBomb = canSpawnBomb && Math.random() < Math.min(0.45, diff.bombChance + 0.12);
        const bombIndex = includeBomb ? Math.floor(Math.random() * burstCount) : -1;
        for (let i = 0; i < burstCount; i++) {
            spawnItem(diff, i === bombIndex ? 'bomb' : 'fruit');
        }
    }

    function startSpawning() {
        clearInterval(spawnTimer); lastSpawnAt = performance.now();
        for (let i = 0; i < 2; i++) setTimeout(() => {
            if (!active) return;
            const diff = getDifficultyState();
            spawnBurst(diff);
            lastSpawnAt = performance.now();
        }, i * 260);
        spawnTimer = setInterval(() => {
            if (!active) return;
            const diff = getDifficultyState();
            const now = performance.now();
            if (now - lastSpawnAt < diff.spawnRate) return;
            spawnBurst(diff);
            lastSpawnAt = now;
        }, 120);
    }

    // ─── PHYSICS ─────────────────────────────────────────────────────────────────
    function updatePhysics(frameScale = 1) {
        if (!active) return;
        const bs = frameScale * timeScale;
        shakeAmt *= Math.pow(.80, bs);
        for (let i = fruits.length - 1; i >= 0; i--) {
            const f = fruits[i];
            if (f.sliced) { f.sliceT += .026 * bs; if (f.sliceT >= 1) fruits.splice(i, 1); }
            else {
                f.x += f.vx * bs; f.y += f.vy * bs; f.vy += CFG.gravity * bs * (f.gScale || 1); f.rot += f.rotV * bs;
                if (f.y > 1.12) { fruits.splice(i, 1); missedCount++; pushSplash(f.x * W, H * .9, 'MISS!', '#ff4466', 1.4); playMiss(); if (!comboFreeze) setCombo(1); }
                else if (f.x < -.3 || f.x > 1.3 || f.y < -3) fruits.splice(i, 1);
            }
        }
        for (let i = bombs.length - 1; i >= 0; i--) {
            const b = bombs[i];
            if (b.sliced) { b.sliceT += .026 * bs; if (b.sliceT >= 1) bombs.splice(i, 1); }
            else {
                b.x += b.vx * bs; b.y += b.vy * bs; b.vy += CFG.gravity * bs * (b.gScale || 1); b.rot += b.rotV * bs;
                if (b.y > 1.12 || b.x < -.3 || b.x > 1.3 || b.y < -3) bombs.splice(i, 1);
            }
        }
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx * bs; p.y += p.vy * bs; p.vy += .00016 * bs; p.life -= .034 * bs;
            if (p.life <= 0) particles.splice(i, 1);
        }
        if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
        for (let i = slashMarks.length - 1; i >= 0; i--) { slashMarks[i].life -= .042 * bs; if (slashMarks[i].life <= 0) slashMarks.splice(i, 1); }
        if (slashMarks.length > MAX_SLASH) slashMarks.splice(0, slashMarks.length - MAX_SLASH);
        for (let i = shockwaves.length - 1; i >= 0; i--) {
            const sw = shockwaves[i]; sw.r += sw.expandSpeed * bs; sw.life -= .055 * bs;
            if (sw.life <= 0) shockwaves.splice(i, 1);
        }
        if (shockwaves.length > MAX_SHOCKWAVE) shockwaves.splice(0, shockwaves.length - MAX_SHOCKWAVE);
        if (screenFlash) { screenFlash.life -= .07 * bs; if (screenFlash.life <= 0) screenFlash = null; }
    }

    // ─── SLICE DETECTION ─────────────────────────────────────────────────────────
    function detectSlices() {
        if (!active || trail.length < 2) return;
        for (let i = 0; i < fruits.length; i++) {
            const f = fruits[i]; if (f.sliced) continue;
            if (trailHits(f)) {
                f.sliced = true; slicedCount++;
                if (!comboFreeze) { clearTimeout(comboTimer); setCombo(combo + 1); comboTimer = setTimeout(() => setCombo(1), CFG.comboWindow); }
                let basePts = 10 * combo * (doubleScore ? 2 : 1);
                if (superSliceMode) basePts *= 3;
                let splashText = '+' + basePts, splashColor = combo > 2 ? '#ffd700' : '#44ee88', pts = basePts;
                const isSpecial = SPECIAL_FRUITS.includes(f.emoji);
                if (isSpecial) { const r = activatePower(f.emoji, f.x * W, f.y * H, basePts); pts = r.pts; splashText = r.splashText; splashColor = r.splashColor; }
                score += pts; updateHearts(); playSlice(combo);
                epicSliceEffect(f.x * W, f.y * H, f.emoji, combo);
                pushSplash(f.x * W, f.y * H, splashText, splashColor, 1 + combo * .14);
            }
        }
        for (let i = bombs.length - 1; i >= 0; i--) {
            const b = bombs[i]; if (b.sliced) continue;
            if (trailHits(b)) {
                b.sliced = true;
                if (bombShield) {
                    bombShield = false; delete activePowers['shield']; renderPowerBar(); updateHearts();
                    bombCutEffect(b.x * W, b.y * H);
                    pushSplash(b.x * W, b.y * H, '🛡️ BLOCKED!', '#22d46e', 1.6);
                    return;
                }
                playBombCut(); bombCutEffect(b.x * W, b.y * H);
                loseHeart(); setCombo(1);
                pushSplash(b.x * W, b.y * H, '💥 -1 LIFE!', '#ff2200', 1.9);
                if (lives <= 0) { gameOver(true); return; }
                return;
            }
        }
    }
    function trailHits(obj) {
        // FIX: Slightly larger hit radius on mobile for better feel
        const hitR = obj.r + (isMobile ? .022 : .008);
        const r2 = hitR * hitR;
        for (let j = 1; j < trail.length; j++) {
            const p1 = trail[j - 1], p2 = trail[j];
            if (distSeg2(obj.x, obj.y, p1.x, p1.y, p2.x, p2.y) < r2) return true;
        }
        return false;
    }
    function distSeg2(px, py, x1, y1, x2, y2) {
        const vx = x2 - x1, vy = y2 - y1, dx = px - x1, dy = py - y1;
        const len2 = vx * vx + vy * vy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (dx * vx + dy * vy) / len2));
        const ex = x1 + t * vx, ey = y1 + t * vy;
        return (px - ex) ** 2 + (py - ey) ** 2;
    }

    // ─── EFFECTS ─────────────────────────────────────────────────────────────────
    function epicSliceEffect(cx, cy, emoji, c) {
        const cols = FRUIT_COLORS[emoji] || ['#ff6b6b', '#ffd93d', '#6bcb77'];
        const n = PARTICLE_N + Math.min(c * 3, 12);
        for (let i = 0; i < n; i++) {
            const ang = Math.random() * Math.PI * 2, spd = .005 + Math.random() * .016;
            particles.push({
                x: cx / W, y: cy / H, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - .007,
                color: cols[(Math.random() * cols.length) | 0], r: 3 + Math.random() * 7, life: 1
            });
        }
        if (Q >= 1) {
            for (let i = 0; i < 5; i++) {
                const ang = Math.random() * Math.PI * 2, spd = .01 + Math.random() * .02;
                particles.push({
                    x: cx / W, y: cy / H, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - .012,
                    color: '#ffffff', r: 1 + Math.random() * 3, life: .5
                });
            }
        }
        const rays = Math.min(4 + c, Q === 0 ? 4 : 8);
        for (let i = 0; i < rays; i++) {
            const ang = (i / rays) * Math.PI * 2;
            slashMarks.push({
                x: cx, y: cy, angle: ang, len: 60 + Math.random() * 60 + c * 10, life: 1,
                color: i % 2 === 0 ? '#ffffff' : cols[0], w: 2 + Math.random() * 2
            });
        }
        if (trail.length > 1 && Q >= 1) {
            const dx = (trail[trail.length - 1].x - trail[trail.length - 2].x) * W;
            const dy = (trail[trail.length - 1].y - trail[trail.length - 2].y) * H;
            slashMarks.push({ x: cx, y: cy, angle: Math.atan2(dy, dx), len: 120 + c * 8, life: 1.2, color: '#ffffff', w: 4 });
        }
        shockwaves.push({ x: cx, y: cy, r: 10, expandSpeed: 6 + c * 3, maxR: 80 + c * 25, life: 1, color: cols[0], lineW: 3 + c });
        if (Q >= 1) shockwaves.push({ x: cx, y: cy, r: 5, expandSpeed: 9 + c * 2, maxR: 55 + c * 15, life: .8, color: '#ffffff', lineW: 2 });
        if (c >= 3 && Q === 2) shockwaves.push({ x: cx, y: cy, r: 0, expandSpeed: 4, maxR: 140, life: .6, color: '#ffd700', lineW: 4 });
        screenFlash = { color: cols[0], life: c > 2 ? .7 : .4 };
        shakeAmt = Math.min(5, 1.5 + c);
    }
    function bombCutEffect(cx, cy) {
        const n = Q === 0 ? 12 : 20;
        for (let i = 0; i < n; i++) {
            const ang = Math.random() * Math.PI * 2, spd = .006 + Math.random() * .018;
            const cols = ['#ff4400', '#ff8800', '#ffcc00', '#ffffff'];
            particles.push({
                x: cx / W, y: cy / H, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - .007,
                color: cols[(Math.random() * cols.length) | 0], r: 3 + Math.random() * 7, life: 1
            });
        }
        for (let i = 0; i < 6; i++) {
            const ang = (i / 6) * Math.PI * 2;
            slashMarks.push({
                x: cx, y: cy, angle: ang, len: 60 + Math.random() * 40, life: 1,
                color: i % 2 === 0 ? '#ff4400' : '#ffcc00', w: 3
            });
        }
        shockwaves.push({ x: cx, y: cy, r: 5, expandSpeed: 10, maxR: 160, life: 1, color: '#ff2200', lineW: 5 });
        if (Q >= 1) shockwaves.push({ x: cx, y: cy, r: 5, expandSpeed: 6, maxR: 100, life: .8, color: '#ffaa00', lineW: 3 });
        screenFlash = { color: '#ff2200', life: 1 }; shakeAmt = 10;
    }

    // ─── BLADE TRAIL RENDERER ────────────────────────────────────────────────────
    function drawBladeTail(pts, spd) {
        const n = pts.length;
        if (n < 2) return;
        const normals = [];
        for (let i = 0; i < n; i++) {
            let dx, dy;
            if (i === 0) { dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y; }
            else if (i === n - 1) { dx = pts[i].x - pts[i - 1].x; dy = pts[i].y - pts[i - 1].y; }
            else { dx = pts[i + 1].x - pts[i - 1].x; dy = pts[i + 1].y - pts[i - 1].y; }
            const len = Math.hypot(dx, dy) || 1;
            normals.push({ x: -dy / len, y: dx / len });
        }
        const maxW = 5 + spd * 4;
        const glowW = maxW * 1.45;
        ctx.save();

        // Outer glow
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1), w = Math.pow(t, 0.55) * glowW;
            const nx = normals[i].x * w, ny = normals[i].y * w;
            if (i === 0) ctx.moveTo(pts[0].x, pts[0].y);
            else ctx.lineTo(pts[i].x + nx, pts[i].y + ny);
        }
        for (let i = n - 1; i >= 0; i--) {
            const t = i / (n - 1), w = Math.pow(t, 0.55) * glowW;
            const nx = normals[i].x * w, ny = normals[i].y * w;
            if (i === n - 1) ctx.lineTo(pts[i].x - nx, pts[i].y - ny);
            else if (i === 0) ctx.lineTo(pts[0].x, pts[0].y);
            else ctx.lineTo(pts[i].x - nx, pts[i].y - ny);
        }
        ctx.closePath();
        const glowGrad = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[n - 1].x, pts[n - 1].y);
        glowGrad.addColorStop(0, 'rgba(255,170,60,0)');
        glowGrad.addColorStop(0.35, 'rgba(255,150,45,0.10)');
        glowGrad.addColorStop(0.75, 'rgba(255,175,70,0.24)');
        glowGrad.addColorStop(1, 'rgba(255,210,120,0.40)');
        ctx.fillStyle = glowGrad; ctx.fill();

        // Mid glow
        ctx.beginPath();
        const midW = maxW * 1.08;
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1), w = Math.pow(t, 0.6) * midW;
            const nx = normals[i].x * w, ny = normals[i].y * w;
            if (i === 0) ctx.moveTo(pts[0].x, pts[0].y);
            else ctx.lineTo(pts[i].x + nx, pts[i].y + ny);
        }
        for (let i = n - 1; i >= 0; i--) {
            const t = i / (n - 1), w = Math.pow(t, 0.6) * midW;
            const nx = normals[i].x * w, ny = normals[i].y * w;
            if (i === n - 1) ctx.lineTo(pts[i].x - nx, pts[i].y - ny);
            else if (i === 0) ctx.lineTo(pts[0].x, pts[0].y);
            else ctx.lineTo(pts[i].x - nx, pts[i].y - ny);
        }
        ctx.closePath();
        const midGrad = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[n - 1].x, pts[n - 1].y);
        midGrad.addColorStop(0, 'rgba(255,230,190,0)');
        midGrad.addColorStop(0.4, 'rgba(255,214,140,0.28)');
        midGrad.addColorStop(0.85, 'rgba(255,236,190,0.58)');
        midGrad.addColorStop(1, 'rgba(255,248,225,0.78)');
        ctx.fillStyle = midGrad; ctx.fill();

        // Bright white core
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1), w = Math.pow(t, 0.7) * maxW;
            const nx = normals[i].x * w, ny = normals[i].y * w;
            if (i === 0) ctx.moveTo(pts[0].x, pts[0].y);
            else ctx.lineTo(pts[i].x + nx, pts[i].y + ny);
        }
        for (let i = n - 1; i >= 0; i--) {
            const t = i / (n - 1), w = Math.pow(t, 0.7) * maxW;
            const nx = normals[i].x * w, ny = normals[i].y * w;
            if (i === n - 1) ctx.lineTo(pts[i].x - nx, pts[i].y - ny);
            else if (i === 0) ctx.lineTo(pts[0].x, pts[0].y);
            else ctx.lineTo(pts[i].x - nx, pts[i].y - ny);
        }
        ctx.closePath();
        const coreGrad = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[n - 1].x, pts[n - 1].y);
        coreGrad.addColorStop(0, 'rgba(255,255,255,0)');
        coreGrad.addColorStop(0.3, 'rgba(255,245,225,0.55)');
        coreGrad.addColorStop(0.78, 'rgba(255,252,240,0.90)');
        coreGrad.addColorStop(1, 'rgba(255,255,255,1)');
        ctx.fillStyle = coreGrad; ctx.fill();

        // Tip dot
        const tip = pts[n - 1];
        const tipR = 2.6 + spd * 3.6;
        const tipGrad = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, tipR * 2);
        tipGrad.addColorStop(0, 'rgba(255,255,255,0.95)');
        tipGrad.addColorStop(0.4, 'rgba(255,225,170,0.62)');
        tipGrad.addColorStop(1, 'rgba(255,170,80,0)');
        ctx.beginPath(); ctx.arc(tip.x, tip.y, tipR * 2, 0, Math.PI * 2);
        ctx.fillStyle = tipGrad; ctx.fill();
        ctx.restore();
    }

    // ─── DRAW GAME ───────────────────────────────────────────────────────────────
    function drawGame(frameScale) {
        const sx = shakeAmt > .3 ? (Math.random() - .5) * shakeAmt * 2 : 0;
        const sy = shakeAmt > .3 ? (Math.random() - .5) * shakeAmt * 2 : 0;
        ctx.clearRect(0, 0, W, H); ctx.save();
        if (sx || sy) ctx.translate(sx, sy);

        // Particles
        ctx.save();
        for (const p of particles) {
            ctx.globalAlpha = p.life * .92; ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r, 0, 6.2832); ctx.fill();
        }
        ctx.restore();

        // Slash marks
        ctx.save(); ctx.lineCap = 'round';
        for (const sm of slashMarks) {
            const a = Math.min(1, sm.life), len = sm.len * (.2 + a * .8);
            const ex = sm.x + Math.cos(sm.angle) * len, ey = sm.y + Math.sin(sm.angle) * len;
            if (USE_SHADOW) {
                ctx.globalAlpha = a * .28; ctx.lineWidth = (sm.w + 5) * a; ctx.strokeStyle = sm.color;
                ctx.beginPath(); ctx.moveTo(sm.x, sm.y); ctx.lineTo(ex, ey); ctx.stroke();
            }
            ctx.globalAlpha = a * .95; ctx.lineWidth = sm.w * a; ctx.strokeStyle = '#ffffff';
            ctx.beginPath(); ctx.moveTo(sm.x, sm.y); ctx.lineTo(ex, ey); ctx.stroke();
        }
        ctx.restore();

        // Shockwaves
        ctx.save(); ctx.lineCap = 'round';
        for (const sw of shockwaves) {
            if (sw.r <= 0 || sw.life <= 0) continue;
            const a = sw.life * (1 - sw.r / (sw.maxR || 100));
            ctx.globalAlpha = Math.max(0, a * .85);
            ctx.strokeStyle = sw.color;
            ctx.lineWidth = sw.lineW * sw.life;
            if (USE_SHADOW) { ctx.shadowColor = sw.color; ctx.shadowBlur = 10 * sw.life; }
            ctx.beginPath(); ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2); ctx.stroke();
            if (USE_SHADOW) ctx.shadowBlur = 0;
        }
        ctx.restore();

        // Blade trail
        if (trail.length > 1) {
            const validTrail = [trail[0]];
            for (let i = 1; i < trail.length; i++) {
                const prev = validTrail[validTrail.length - 1];
                const dx = trail[i].x - prev.x, dy = trail[i].y - prev.y;
                if (Math.sqrt(dx * dx + dy * dy) < 0.22) validTrail.push(trail[i]);
                else validTrail.push({ x: trail[i].x, y: trail[i].y });
            }
            if (validTrail.length > 1) {
                const n = validTrail.length;
                const tn = validTrail[n - 1], tp = validTrail[n - 2];
                const dxS = (tn.x - tp.x) * W, dyS = (tn.y - tp.y) * H;
                fingerSpeed = Math.hypot(dxS, dyS);
                const spd = Math.min(0.35, fingerSpeed / 120);
                const pxPts = validTrail.map(p => ({ x: p.x * W, y: p.y * H }));
                drawBladeTail(pxPts, spd);
            }
        } else {
            fingerSpeed = 0;
        }

        // Finger tip dot
        if (trail.length > 0) {
            const tip = trail[trail.length - 1], tx = tip.x * W, ty = tip.y * H;
            ctx.save();
            ctx.globalAlpha = .45;
            ctx.beginPath(); ctx.arc(tx, ty, 3.8, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,194,100,0.95)';
            ctx.lineWidth = .7; ctx.stroke();
            ctx.globalAlpha = .92;
            ctx.beginPath(); ctx.arc(tx, ty, 1.2, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff'; ctx.fill();
            ctx.restore();
        }

        // Fruits
        const S = SPRITE_SIZE, hw = S * .5;
        ctx.save();
        for (const f of fruits) {
            const px = f.x * W, py = f.y * H;
            if (py < -130 || py > H + 90 || px < -90 || px > W + 90) continue;
            const sp = getSprite(f.emoji);
            if (f.sliced) {
                const a = Math.max(0, 1 - f.sliceT * 1.5); if (a <= 0) continue;
                ctx.globalAlpha = a;
                const off = f.sliceT * 90, dy2 = f.sliceT * H * .06;
                ctx.save(); ctx.translate(px - off, py - dy2); ctx.rotate(f.rot + f.sliceT * 1.8); ctx.drawImage(sp, -hw, -hw, S, S); ctx.restore();
                ctx.save(); ctx.translate(px + off, py - dy2); ctx.rotate(f.rot - f.sliceT * 1.8); ctx.drawImage(sp, -hw, -hw, S, S); ctx.restore();
            } else {
                const isSpecial = SPECIAL_FRUITS.includes(f.emoji);
                ctx.globalAlpha = 1; ctx.save(); ctx.translate(px, py); ctx.rotate(f.rot);
                if (isSpecial && USE_SHADOW) { ctx.shadowColor = '#f9a826'; ctx.shadowBlur = 14 + Math.sin(Date.now() * .005) * 7; }
                else if (isSpecial && !USE_SHADOW) { const p2 = .97 + Math.sin(Date.now() * .006) * .03; ctx.scale(p2, p2); }
                ctx.drawImage(sp, -hw, -hw, S, S); ctx.restore();
                if (USE_SHADOW) ctx.shadowBlur = 0;
            }
        }
        ctx.restore();

        // Bombs
        const bT = Date.now() * .005;
        ctx.save();
        for (const b of bombs) {
            const bx = b.x * W, by = b.y * H; if (by < -130 || by > H + 90) continue;
            if (b.sliced) {
                const a = Math.max(0, 1 - b.sliceT * 1.4); if (a <= 0) continue;
                ctx.globalAlpha = a; const off = b.sliceT * 75;
                ctx.save(); ctx.translate(bx - off, by); ctx.rotate(b.rot); ctx.drawImage(getSprite('💥'), -hw, -hw, S, S); ctx.restore();
                ctx.save(); ctx.translate(bx + off, by); ctx.rotate(-b.rot); ctx.drawImage(getSprite('💥'), -hw, -hw, S, S); ctx.restore();
            } else {
                const pulse = .93 + Math.sin(bT) * .07;
                ctx.globalAlpha = 1; ctx.save(); ctx.translate(bx, by); ctx.rotate(b.rot); ctx.scale(pulse, pulse);
                if (bombShield && USE_SHADOW) { ctx.shadowColor = '#22d46e'; ctx.shadowBlur = 18; }
                ctx.drawImage(getSprite('💣'), -hw, -hw, S, S); ctx.restore();
                if (USE_SHADOW) ctx.shadowBlur = 0;
            }
        }
        ctx.restore();

        ctx.restore(); // end shake

        // Screen flash
        if (screenFlash && screenFlash.life > 0) {
            ctx.save();
            const a = Math.min(.5, screenFlash.life * .44);
            ctx.globalAlpha = a; ctx.fillStyle = screenFlash.color; ctx.fillRect(0, 0, W, H);
            ctx.restore();
        }
        ctx.globalAlpha = 1;
    }

    // ─── GAME OVER / RESTART ─────────────────────────────────────────────────────
    function gameOver(bomb) {
        if (!active) return;
        active = false; clearInterval(spawnTimer); clearTimeout(comboTimer);
        superSliceMode = false; doubleScore = false; comboFreeze = false; bombShield = false;
        clearTimeout(superSliceTimer); clearTimeout(doubleScoreTimer); clearTimeout(comboFreezeTimer); clearTimeout(slowMoTimer);
        clearInterval(autoSliceTimer); clearTimeout(autoSliceStopTimer);
        Object.keys(activePowers).forEach(k => delete activePowers[k]); renderPowerBar(); timeScale = 1;
        if (score > bestScore) bestScore = score;
        ovTitle.textContent = bomb ? '💣 BOOM!' : '💔 GAME OVER';
        ovSub.textContent = bomb ? 'You sliced a bomb! Be careful.' : 'You missed three fruits.';
        ovScore.textContent = '🏆 ' + score + ' pts'; ovScore.classList.remove('hidden');
        statSliced.textContent = slicedCount; statMissed.textContent = missedCount;
        statBest.textContent = 'x' + bestCombo; statHigh.textContent = bestScore;
        ovStats.classList.remove('hidden');
        startBtn.textContent = '↻ Play Again'; loadBar.style.display = 'none';
        overlay.classList.remove('hidden');
    }
    function resetPowers() {
        superSliceMode = false; doubleScore = false; comboFreeze = false; bombShield = false;
        clearTimeout(superSliceTimer); clearTimeout(doubleScoreTimer); clearTimeout(comboFreezeTimer); clearTimeout(slowMoTimer);
        clearInterval(autoSliceTimer); clearTimeout(autoSliceStopTimer);
        autoSliceTimer = null; autoSliceStopTimer = null; shieldSpawnedThisGame = false;
        Object.keys(activePowers).forEach(k => delete activePowers[k]); renderPowerBar(); timeScale = 1;
    }
    function restartGame() {
        resetStartGate();
        score = 0; lives = 3; combo = 1; slicedCount = 0; missedCount = 0; bestCombo = 1;
        fruits = []; bombs = []; particles = []; trail = []; slashMarks = []; shockwaves = []; splashes.length = 0;
        screenFlash = null; shakeAmt = 0; fingerSpeed = 0; mpFrameCount = 0;
        // Reset smoothing + tracking state on game restart
        smoothX = null; smoothY = null;
        lastKnownX = null; lastKnownY = null;
        lastDetectionTs = 0; missedFrames = 0;
        clearTimeout(detectionLostTimer); clearInterval(trailDecayInterval);
        detectionLostTimer = null; trailDecayInterval = null;
        lastFrameTs = 0; gameStartTs = performance.now(); lastSpawnAt = gameStartTs;
        resetPowers(); updateHearts();
        comboPill.textContent = 'x1'; comboPill.style.color = ''; comboPill.style.borderColor = '';
        active = true; overlay.classList.add('hidden'); startSpawning();
    }
    function showComboFlash(text) {
        const el = document.createElement('div'); el.className = 'combo-flash'; el.textContent = text;
        wrap.appendChild(el); setTimeout(() => el.remove(), 900);
    }

    function setStartBtnDisabled(disabled) {
        startBtn.disabled = disabled;
        startBtn.style.opacity = disabled ? '0.6' : '';
        startBtn.style.pointerEvents = disabled ? 'none' : '';
    }

    function resetStartGate() {
        startGateWaiting = false;
        startGateCounting = false;
        startGateCountdownVal = 0;
        startGateFirstSeenTs = 0;
        startGateLastSeenTs = 0;
        if (startGateTimer) { clearInterval(startGateTimer); startGateTimer = null; }
        if (startCountdown) {
            startCountdown.classList.add('hidden');
            startCountdown.textContent = '1';
        }
        if (startGate) startGate.classList.add('hidden');
        setStartBtnDisabled(false);
    }

    function beginStartGate() {
        if (active) return;
        resetStartGate();
        startGateWaiting = true;
        if (startGate) startGate.classList.remove('hidden');
        if (startHint) startHint.textContent = '☝️ Show your index finger to start';
        if (startCountdown) startCountdown.classList.add('hidden');
        if (ovScore) ovScore.classList.add('hidden');
        if (ovStats) ovStats.classList.add('hidden');
        if (ovSub) ovSub.textContent = 'Show your index finger to start. Keep it visible for the count.';
        setStartBtnDisabled(true);

        if (usingPointerFallback) {
            startGateLastSeenTs = performance.now();
            startCountdownFromFinger();
        }
    }

    function bumpCountdownAnim() {
        if (!startCountdown) return;
        startCountdown.classList.remove('count-pop');
        // Force reflow to restart animation
        void startCountdown.offsetWidth;
        startCountdown.classList.add('count-pop');
    }

    function startCountdownFromFinger() {
        if (!startGateWaiting || startGateCounting) return;
        startGateCounting = true;
        startGateWaiting = false;
        startGateCountdownVal = 1;
        if (startCountdown) {
            startCountdown.textContent = '1';
            startCountdown.classList.remove('hidden');
            bumpCountdownAnim();
        }
        if (startHint) startHint.textContent = 'Keep it steady...';

        startGateTimer = setInterval(() => {
            const now = performance.now();
            if (now - startGateLastSeenTs > 700) {
                cancelStartCountdown();
                return;
            }
            if (startGateCountdownVal >= 3) {
                finishStartCountdown();
                return;
            }
            startGateCountdownVal += 1;
            if (startCountdown) {
                startCountdown.textContent = String(startGateCountdownVal);
                bumpCountdownAnim();
            }
        }, 1000);
    }

    function cancelStartCountdown() {
        if (startGateTimer) { clearInterval(startGateTimer); startGateTimer = null; }
        startGateCounting = false;
        startGateWaiting = true;
        startGateCountdownVal = 0;
        startGateFirstSeenTs = 0;
        if (startHint) startHint.textContent = '☝️ Show your index finger to start';
        if (startCountdown) {
            startCountdown.classList.add('hidden');
            startCountdown.textContent = '1';
        }
    }

    function finishStartCountdown() {
        if (startGateTimer) { clearInterval(startGateTimer); startGateTimer = null; }
        startGateCounting = false;
        startGateWaiting = false;
        startGateCountdownVal = 0;
        restartGame();
    }

    function noteStartGateSeen() {
        if (!startGateWaiting && !startGateCounting) return;
        const now = performance.now();
        startGateLastSeenTs = now;
        if (startGateWaiting && !startGateCounting) {
            if (!startGateFirstSeenTs) startGateFirstSeenTs = now;
            if (now - startGateFirstSeenTs >= 200) startCountdownFromFinger();
        }
    }

    // ─── MEDIAPIPE ───────────────────────────────────────────────────────────────
    // FIX: Use smaller offscreen canvas to reduce GPU pressure on mobile
    const mpW = isMobile ? 256 : 640;
    const mpH = isMobile ? 192 : 480;
    const mpCanvas = document.createElement('canvas');
    mpCanvas.width = mpW; mpCanvas.height = mpH;
    const mpCtx = mpCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

    const hands = new Hands({ locateFile: f => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + f });
    hands.setOptions({
        selfieMode: true,
        maxNumHands: 1,
        // FIX: Use complexity 0 on mobile for speed, 1 on desktop for accuracy
        modelComplexity: isMobile ? 0 : 1,
        // FIX: Tuned confidence values — higher detection, lower tracking
        // so it reacquires quickly when briefly lost
        minDetectionConfidence: isMobile ? 0.55 : 0.65,
        minTrackingConfidence: isMobile ? 0.40 : 0.55,
    });

    hands.onResults(results => {
        const startGateActive = startGateWaiting || startGateCounting;
        if (!active && !startGateActive) return;

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const lm = results.multiHandLandmarks[0];
            const tip = lm[8]; // index finger tip
            if (tip) {
                if (startGateActive) noteStartGateSeen();
                if (!active) return;

                const norm = landmarkToNorm(tip.x, tip.y);

                // KEY FIX: If we had many missed frames (e.g. during/after a slice),
                // SNAP to new position immediately instead of slowly lerping from old one.
                // Without this, the trail "rubber-bands" from old pos → new pos and
                // looks like a worm, not a blade.
                if (smoothX === null || missedFrames > 4) {
                    smoothX = norm.x;
                    smoothY = norm.y;
                    // Also clear trail so old ghost points don't linger
                    if (missedFrames > 4) trail.length = 0;
                } else {
                    smoothX = smoothX * SMOOTH_ALPHA + norm.x * (1 - SMOOTH_ALPHA);
                    smoothY = smoothY * SMOOTH_ALPHA + norm.y * (1 - SMOOTH_ALPHA);
                }

                lastKnownX = smoothX;
                lastKnownY = smoothY;
                lastDetectionTs = performance.now();
                missedFrames = 0;

                trail.push({ x: smoothX, y: smoothY });
                if (trail.length > CFG.trailLen) trail.shift();

                // Cancel any pending trail decay
                clearTimeout(detectionLostTimer);
                clearInterval(trailDecayInterval);
                detectionLostTimer = null;
                trailDecayInterval = null;
            }
        } else {
            if (!active) return;
            missedFrames++;

            // Only start decay after a meaningful absence (>12 missed frames AND 500ms)
            if (missedFrames > 12 && !detectionLostTimer && !trailDecayInterval) {
                detectionLostTimer = setTimeout(() => {
                    detectionLostTimer = null;
                    // Very slow decay: 1 point per 100ms
                    trailDecayInterval = setInterval(() => {
                        if (trail.length > 0) {
                            trail.shift();
                        } else {
                            clearInterval(trailDecayInterval);
                            trailDecayInterval = null;
                            smoothX = null; smoothY = null;
                            lastKnownX = null; lastKnownY = null;
                        }
                    }, 100);
                }, 500);
            }
        }
    });

    let video = null;
    async function initCamera() {
        video = document.createElement('video');
        video.style.display = 'none';
        // FIX: These attributes are critical for iOS Safari
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.setAttribute('autoplay', '');
        video.playsInline = true;
        video.muted = true;
        video.autoplay = true;
        document.body.appendChild(video);

        // FIX: Listen for video metadata to update transform ASAP
        video.addEventListener('loadedmetadata', () => updateVideoTransform(video));
        video.addEventListener('playing', () => updateVideoTransform(video));

        const cam = new Camera(video, {
            onFrame: async () => {
                if (!video || video.readyState < 2) return;
                if (!vt.ready && video.videoWidth) updateVideoTransform(video);

                // ─── FIX: CAMERA DISPLAY ───────────────────────────────────────
                // The mirror transform is: translate(W,0) + scale(-1,1)
                // In this flipped coordinate system, drawImage(img, cx, cy, cw, ch)
                // places the image at screen x: [W - cx - cw, W - cx]
                // For cover-crop with offset ox (always ≤ 0):
                //   We need: W - cx - drawW = ox  →  cx = W - ox - drawW
                //   Since ox = (W - drawW)/2:  cx = (W - drawW)/2 = ox
                // Therefore cx = vt.ox (NOT -vt.ox which was the original bug)
                // ──────────────────────────────────────────────────────────────
                cCam.save();
                cCam.translate(W, 0);
                cCam.scale(-1, 1);
                if (vt.ready) {
                    cCam.drawImage(video, vt.ox, vt.oy, vt.drawW, vt.drawH); // FIX: vt.ox not -vt.ox
                } else {
                    cCam.drawImage(video, 0, 0, W, H);
                }
                cCam.restore();

                mpFrameCount++;
                if (mpFrameCount % MP_SKIP !== 0) return;
                mpCtx.drawImage(video, 0, 0, mpW, mpH);
                await hands.send({ image: mpCanvas });
            },
            // FIX: Request higher resolution for better hand detection on mobile
            width: { ideal: isMobile ? 1280 : 1920 },
            height: { ideal: isMobile ? 720 : 1080 },
            facingMode: 'user',
        });

        try {
            await cam.start();
            loadBar.style.display = 'none';
        } catch (e) {
            console.warn('Camera fail:', e);
            loadBar.style.display = 'none';
            enablePointerFallback();
        }
    }

    function enablePointerFallback() {
        usingPointerFallback = true;
        vt = { ox: 0, oy: 0, drawW: W, drawH: H, ready: true };
        const el = document.getElementById('gc');
        el.style.pointerEvents = 'auto';
        // Mouse fallback
        el.addEventListener('mousemove', e => {
            if (startGateWaiting || startGateCounting) noteStartGateSeen();
            if (!active) return;
            trail.push({ x: e.clientX / W, y: e.clientY / H });
            if (trail.length > CFG.trailLen) trail.shift();
        }, { passive: true });
        // Touch fallback — multi-touch aware
        el.addEventListener('touchmove', e => {
            e.preventDefault();
            if (startGateWaiting || startGateCounting) noteStartGateSeen();
            if (!active) return;
            const t = e.touches[0];
            trail.push({ x: t.clientX / W, y: t.clientY / H });
            if (trail.length > CFG.trailLen) trail.shift();
        }, { passive: false });
        el.addEventListener('touchend', () => {
            // Decay trail on touch end
            const decay = setInterval(() => {
                if (trail.length > 0) trail.shift();
                else clearInterval(decay);
            }, 30);
        }, { passive: true });
    }

    // ─── GAME LOOP ───────────────────────────────────────────────────────────────
    function loop(ts) {
        if (typeof ts !== 'number') ts = performance.now();
        if (!lastFrameTs) lastFrameTs = ts;
        const frameMs = Math.max(8, Math.min(50, ts - lastFrameTs));
        gameTime += frameMs;
        const frameScale = frameMs / (1000 / 60);
        lastFrameTs = ts;
        if (active) { updatePhysics(frameScale); detectSlices(); }
        drawGame(frameScale);
        drawSplashes(frameScale);
        requestAnimationFrame(loop);
    }

    // ─── EVENT LISTENERS ─────────────────────────────────────────────────────────
    startBtn.addEventListener('click', () => { initAudio(); beginStartGate(); });
    restartBtn.addEventListener('click', () => { initAudio(); restartGame(); });
    document.body.addEventListener('click', () => {
        if (!audioCtx) initAudio(); else resumeAudio();
    }, { once: true });

    // ─── INIT ─────────────────────────────────────────────────────────────────────
    window.addEventListener('load', async () => {
        preWarmSprites();
        await initCamera();
        requestAnimationFrame(loop);
    });
    window.addEventListener('beforeunload', () => {
        clearInterval(spawnTimer);
        clearTimeout(comboTimer);
    });

})();
