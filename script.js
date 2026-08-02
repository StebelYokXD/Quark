// ==================== FIREBASE INIT ====================
const firebaseConfig = {
    apiKey: "AIzaSyDjuPQ1WX69DvTJJN74CC6L1HAcw5ill2I",
    authDomain: "massanger-2413e.firebaseapp.com",
    projectId: "massanger-2413e",
    storageBucket: "massanger-2413e.firebasestorage.app",
    messagingSenderId: "398845897154",
    appId: "1:398845897154:web:f15d2b9c3fed4eb22f0e5b"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
db.settings({ ignoreUndefinedProperties: true });

const GENERAL_CHAT_ID = 'general';

// ==================== GLOBAL STATE ====================
// Hand-drawn checkmark ticks matching WhatsApp/Telegram's actual look
// (thin round-capped stroke, second check overlapping the first) — a
// generic checkmark icon font glyph doesn't replicate this shape.
// The double-check's right-hand stroke is the exact same shape as the
// single check (just shifted right), and both SVGs share the same
// vertical range, so read/unread ticks always render at the identical
// size — only the double one is wider because it has a second stroke.
const TICK_SINGLE_SVG = '<svg viewBox="-0.75 -0.75 10.5 9.5" width="10" height="9"><polyline points="0,5 3,8 9,0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TICK_DOUBLE_SVG = '<svg viewBox="-0.75 -0.75 15.5 9.5" width="15" height="9"><polyline points="0,5 3,8 9,0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="5,5 8,8 14,0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let currentUser = null;
let currentProfile = null;
let allUsers = {};
let allChats = {};              // group/channel/general chat docs, keyed by chat id
let activeChats = new Set();    // DM partner uids
let myChatIds = new Set();      // group/channel ids I'm a member of
let currentChat = null;         // either a uid (DM) or a chat id (group/channel/general)
let messageCache = {};
// Which message ids have already been shown (at least once) in each chat's
// current render pass — lets renderMessagesSnapshot tell a genuinely new
// message apart from the rest of the chat re-rendering around it, so only
// the new one gets the appear animation.
let renderedMsgIds = {};
let lastMessagePreviews = {};
let lastMessageTimes = {};
let unreadCounts = {};
let typingTimers = {};
let selectedMessages = new Set();
let selectionMode = false;
let darkMode = localStorage.getItem('quark_dark') === '1';
let quickReactionEmoji = localStorage.getItem('quark_quick_reaction') || '👍';
let accentTheme = localStorage.getItem('quark_accent') || 'purple';
let amoledMode = localStorage.getItem('quark_amoled') === '1';
let chatWallpaper = localStorage.getItem('quark_wallpaper') || null;
let fontSize = localStorage.getItem('quark_font') || 'medium';
// Desktop two-pane layout (chat list + open chat side by side, like
// Telegram Desktop) kicks in above this width; below it we keep the
// single-screen mobile navigation. Interface scale on desktop is picked
// independently from the mobile "font size" setting below, via the
// zoom control in the desktop sidebar rail.
const DESKTOP_BREAKPOINT = 980;
const DESKTOP_SCALES = [0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6];
let desktopScale = parseFloat(localStorage.getItem('quark_desktop_scale')) || 1.0;
function isDesktopLayout() { return window.innerWidth >= DESKTOP_BREAKPOINT; }
let soundEnabled = localStorage.getItem('quark_sound') !== 'false';
let readReceiptsEnabled = localStorage.getItem('quark_read_receipts') !== 'false';
let unsubscribeMessages = null;
let shouldScrollDown = true;
let replyTo = null;
let savedAccounts = JSON.parse(localStorage.getItem('quark_accounts') || '[]');

// --- pinned messages (per chat, "chatMeta" collection keyed by chat id) ---
let currentPinnedIds = new Set();   // ids of messages pinned in the currently open chat
let currentPinnedList = [];         // ordered list of pinned message ids for the open chat
let pinnedShownIndex = 0;           // which pinned message the banner currently shows
let unsubscribePinned = null;

// --- post comments (channel posts) ---
let unsubscribeComments = null;

// --- stories ---
let storiesByUser = {};
let unsubscribeStories = null;
let storyViewerTimer = null;

// --- presence / typing realtime plumbing ---
let unsubscribeUserStatus = null;
let unsubscribeChatMeta = null;
let unsubscribeTyping = null;
let heartbeatInterval = null;
let statusTickInterval = null;

// --- messages listener plumbing (scoped, leak-safe) ---
let unsubscribeMyMessages = null;
let unsubscribeGeneralMessages = null;
let unsubscribeAllUsers = null;
let unsubscribeMyChats = null;

const ONLINE_THRESHOLD_MS = 45000;
const HEARTBEAT_INTERVAL_MS = 20000;
const TYPING_TTL_MS = 4000;
const TYPING_STOP_DELAY_MS = 2500;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ==================== UTILS ====================
function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    if (d.getDate() === now.getDate() && d.getMonth() === now.getMonth()) {
        return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (d.getDate() === y.getDate() && d.getMonth() === y.getMonth()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

// A message that was just sent locally hasn't had its serverTimestamp()
// resolved yet (Firestore delivers it as a pending write with a null
// timestamp before the real one arrives) — new Date(null) would show it
// as 1970. Falling back to "now" instead keeps it looking normal until
// the follow-up "modified" event fills in the real timestamp.
// Only the fields a bubble actually renders — used to skip rebuilding a
// message's DOM node on a 'modified' event that didn't change anything
// visible (most commonly: our own just-sent message getting its pending
// serverTimestamp() resolved a moment after the optimistic local write).
function msgVisualsEqual(a, b) {
    return a.text === b.text &&
        a.imageUrl === b.imageUrl &&
        a.fileName === b.fileName &&
        a.replyTo === b.replyTo &&
        (a.commentCount || 0) === (b.commentCount || 0) &&
        (a.viewedBy || []).length === (b.viewedBy || []).length &&
        JSON.stringify(a.reactions || {}) === JSON.stringify(b.reactions || {}) &&
        JSON.stringify(a.readBy || []) === JSON.stringify(b.readBy || []);
}

function msgDateOf(msg) {
    if (msg.timestamp && msg.timestamp.toDate) return msg.timestamp.toDate();
    if (msg.timestamp) return new Date(msg.timestamp);
    return new Date();
}

function toMillis(value) {
    if (!value) return 0;
    return value.toDate ? value.toDate().getTime() : new Date(value).getTime();
}

function isUserOnline(user) {
    if (!user || !user.online) return false;
    if (!user.lastSeen) return true;
    return (Date.now() - toMillis(user.lastSeen)) < ONLINE_THRESHOLD_MS;
}

// Whether a user has opted to let others see their online/last-seen status
// (their own "Показывать время захода" setting — defaults to true).
function canShowLastSeen(user) {
    return !!user && user.lastSeenEnabled !== false;
}

// A "chat-like" object (group/channel/general) as opposed to a DM with a plain user.
function isGroupLike(id) {
    return id === GENERAL_CHAT_ID || !!allChats[id];
}

function chatIdFor(id) {
    return isGroupLike(id) ? id : [currentUser.uid, id].sort().join('_');
}

function otherDmUid(cid) {
    const parts = cid.split('_');
    return parts.find(p => p !== currentUser.uid);
}

// Usernames are one shared namespace across people AND chats/channels —
// a person and a channel can't both be @something. Checks both
// collections and excludes the doc currently being saved (if any).
async function isUsernameTaken(username, opts) {
    opts = opts || {};
    const [userSnap, chatSnap] = await Promise.all([
        db.collection('users').where('username', '==', username).get(),
        db.collection('chats').where('username', '==', username).get()
    ]);
    const userConflict = userSnap.docs.some(d => d.id !== opts.excludeUserId);
    const chatConflict = chatSnap.docs.some(d => d.id !== opts.excludeChatId);
    return userConflict || chatConflict;
}

// Finds the user or chat/channel behind an @username for mention
// rendering and autocomplete. Case-insensitive.
function findMentionTarget(username) {
    const uname = username.toLowerCase();
    const user = Object.values(allUsers).find(u => (u.username || '').toLowerCase() === uname);
    if (user) return { kind: 'user', id: user.id, obj: user };
    const chat = Object.values(allChats).find(c => (c.username || '').toLowerCase() === uname);
    if (chat) return { kind: 'chat', id: chat.id, obj: chat };
    return null;
}

// Jumps to whatever a mention points at — same behavior as tapping that
// user/chat in search results. Also closes the comments overlay first,
// since mentions can be tapped from inside it.
function goToMention(kind, id) {
    document.querySelectorAll('.comments-overlay').forEach(o => o.remove());
    if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
    if (kind === 'user') {
        if (!activeChats.has(id)) {
            activeChats.add(id);
            loadChatPreview(id, chatIdFor(id));
        }
    }
    openChat(id);
    showScreen('screenMessages');
}

const MENTION_RE = /(^|[^\w@])@([a-zA-Z0-9_]{3,32})\b/g;

// Builds message text as a DOM fragment (never innerHTML, to stay
// injection-safe) with any @username that resolves to a known user or
// chat/channel turned into a clickable mention span.
function renderTextWithMentions(text) {
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    MENTION_RE.lastIndex = 0;
    while ((match = MENTION_RE.exec(text))) {
        const prefix = match[1];
        const uname = match[2];
        const start = match.index + prefix.length;
        const end = start + 1 + uname.length;
        const target = findMentionTarget(uname);
        if (!target) {
            MENTION_RE.lastIndex = end;
            continue;
        }
        if (start > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
        const span = document.createElement('span');
        span.className = 'msg-mention';
        span.textContent = '@' + uname;
        span.onclick = function (e) {
            e.stopPropagation();
            goToMention(target.kind, target.id);
        };
        frag.appendChild(span);
        lastIndex = end;
    }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    return frag;
}

// ==================== MENTION AUTOCOMPLETE ====================
// While typing, finds the @token touching the cursor (if any — no
// whitespace between the @ and the caret) and shows matching users and
// chats/channels by username so you can tap to insert it.
function activeMentionToken(input) {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at === -1) return null;
    const token = before.slice(at + 1);
    if (/\s/.test(token)) return null;
    if (at > 0 && /\w/.test(before[at - 1])) return null; // "email@x" isn't a mention
    return { start: at, query: token };
}

function hideMentionSuggestions() {
    const box = $('#mentionSuggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function updateMentionSuggestions(input) {
    const box = $('#mentionSuggestions');
    if (!box) return;
    const active = activeMentionToken(input);
    if (!active) return hideMentionSuggestions();

    const q = active.query.toLowerCase();
    const results = [];
    Object.values(allUsers).forEach(u => {
        if (u.id === currentUser.uid) return;
        if (u.username && u.username.toLowerCase().startsWith(q)) results.push({ kind: 'user', obj: u });
    });
    Object.values(allChats).forEach(c => {
        if (c.id === GENERAL_CHAT_ID) return;
        if (c.username && c.username.toLowerCase().startsWith(q)) results.push({ kind: 'chat', obj: c });
    });
    if (!results.length) return hideMentionSuggestions();

    box.innerHTML = '';
    results.slice(0, 6).forEach(r => {
        const name = r.kind === 'user' ? (r.obj.displayName || 'Пользователь') : (r.obj.name || 'Чат');
        const avatarUrl = r.obj.avatarUrl;
        const row = document.createElement('div');
        row.className = 'mention-suggestion-row';
        row.innerHTML =
            '<div class="avatar">' + (avatarUrl ? '<img src="' + avatarUrl + '">' : initials(name)) + '</div>' +
            '<div class="mention-suggestion-info"><div class="mention-suggestion-name">' + name + '</div>' +
            '<div class="mention-suggestion-uname">@' + r.obj.username + '</div></div>';
        row.onmousedown = function (e) {
            // mousedown (not click) fires before the textarea's blur, so
            // we can still read/replace its content correctly.
            e.preventDefault();
            const before = input.value.slice(0, active.start);
            const after = input.value.slice(active.start + 1 + active.query.length);
            input.value = before + '@' + r.obj.username + ' ' + after;
            const caret = (before + '@' + r.obj.username + ' ').length;
            input.focus();
            input.setSelectionRange(caret, caret);
            hideMentionSuggestions();
        };
        box.appendChild(row);
    });
    box.classList.remove('hidden');
}

function initials(name) {
    return (name || 'П')[0].toUpperCase();
}

const ACCENT_THEMES = ['purple', 'blue', 'green', 'pink', 'orange', 'teal', 'red'];
const ACCENT_COLORS = { purple: '#7C4DFF', blue: '#2F80ED', green: '#10B981', pink: '#EC4899', orange: '#F97316', teal: '#14B8A6', red: '#EF4444' };

function applyTheme() {
    const app = $('#app');
    if (app) {
        if (darkMode) {
            app.classList.add('dark-theme');
            document.body.classList.add('dark-theme');
        } else {
            app.classList.remove('dark-theme');
            document.body.classList.remove('dark-theme');
        }
        ACCENT_THEMES.forEach(t => {
            app.classList.remove('accent-' + t);
            document.body.classList.remove('accent-' + t);
        });
        if (accentTheme && accentTheme !== 'purple') {
            app.classList.add('accent-' + accentTheme);
            document.body.classList.add('accent-' + accentTheme);
        }
        app.classList.toggle('amoled-mode', darkMode && amoledMode);
        document.body.classList.toggle('amoled-mode', darkMode && amoledMode);
    }
    const dt = $('#darkToggle');
    if (dt) dt.classList.toggle('active', darkMode);
    const amt = $('#amoledToggle');
    if (amt) amt.classList.toggle('active', amoledMode);
    const bg = darkMode ? (amoledMode ? '#000000' : '#0F0F1A') : '#F0EDF7';
    document.body.style.background = bg;
    applyWallpaper();
}

function applyWallpaper() {
    const area = $('#msgArea');
    if (!area) return;
    if (chatWallpaper) {
        area.style.backgroundImage = 'url(' + chatWallpaper + ')';
        area.style.backgroundSize = 'cover';
        area.style.backgroundPosition = 'center';
        area.style.backgroundAttachment = 'scroll';
    } else {
        area.style.backgroundImage = '';
    }
}

function applyFontSize() {
    localStorage.setItem('quark_font', fontSize);
    applyUiScale();
}

// Single source of truth for --ui-scale (used everywhere via calc(Npx *
// var(--ui-scale,1))): on desktop it comes from the zoom control in the
// sidebar rail, on mobile from the "font size" setting. Re-run on resize
// so crossing the breakpoint immediately switches which one applies.
function applyUiScale() {
    const scales = { small: '0.88', medium: '1.0', large: '1.18' };
    const scale = isDesktopLayout() ? desktopScale : parseFloat(scales[fontSize] || '1.0');
    document.documentElement.style.setProperty('--ui-scale', scale);
    const label = $('#scaleValueLabel');
    if (label) label.textContent = Math.round(desktopScale * 100) + '%';
}

function applyDesktopScale(newScale) {
    desktopScale = Math.max(DESKTOP_SCALES[0], Math.min(DESKTOP_SCALES[DESKTOP_SCALES.length - 1], newScale));
    localStorage.setItem('quark_desktop_scale', desktopScale);
    applyUiScale();
}

window.addEventListener('resize', applyUiScale);

function playSound() {
    if (!soundEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.frequency.setValueAtTime(1000, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
}

function showCustomAlert(message) {
    const overlay = document.createElement('div');
    // z-index 500: must stay above .story-viewer-overlay (400) so this can be
    // opened on top of the story viewer (e.g. "failed to load story" alerts).
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:500;';

    const bg = getComputedStyle(document.body).getPropertyValue('--glass').trim();
    const textColor = getComputedStyle(document.body).getPropertyValue('--text').trim();
    const borderColor = getComputedStyle(document.body).getPropertyValue('--glass-border').trim();
    const shadowColor = getComputedStyle(document.body).getPropertyValue('--shadow-lg').trim();
    const primaryColor = getComputedStyle(document.body).getPropertyValue('--primary').trim();

    const modal = document.createElement('div');
    modal.style.cssText = 'background:' + bg + ';backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);' +
        'border-radius:16px;padding:24px;max-width:300px;text-align:center;border:1px solid ' + borderColor + ';' +
        'box-shadow:' + shadowColor + ';color:' + textColor + ';';
    modal.innerHTML =
        '<p style="margin-bottom:16px;font-size:15px;">' + message + '</p>' +
        '<button style="background:' + primaryColor + ';color:white;border:none;padding:10px 24px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;">OK</button>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    modal.querySelector('button').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

function showCustomConfirm(message, onConfirm) {
    const overlay = document.createElement('div');
    // z-index 500: must stay above .story-viewer-overlay (400) so the
    // "Удалить эту историю?" confirm shows on top of the story, not behind it.
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:500;';

    const bg = getComputedStyle(document.body).getPropertyValue('--glass').trim();
    const textColor = getComputedStyle(document.body).getPropertyValue('--text').trim();
    const borderColor = getComputedStyle(document.body).getPropertyValue('--glass-border').trim();
    const shadowColor = getComputedStyle(document.body).getPropertyValue('--shadow-lg').trim();
    const dangerColor = getComputedStyle(document.body).getPropertyValue('--danger').trim();

    const modal = document.createElement('div');
    modal.style.cssText = 'background:' + bg + ';backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);' +
        'border-radius:16px;padding:24px;max-width:300px;text-align:center;border:1px solid ' + borderColor + ';' +
        'box-shadow:' + shadowColor + ';color:' + textColor + ';';
    modal.innerHTML =
        '<p style="margin-bottom:16px;font-size:15px;">' + message + '</p>' +
        '<div style="display:flex;gap:10px;">' +
        '<button class="custom-confirm-yes" style="flex:1;background:' + dangerColor + ';color:white;border:none;padding:10px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;">Да</button>' +
        '<button class="custom-confirm-no" style="flex:1;background:rgba(128,128,128,0.2);color:' + textColor + ';border:none;padding:10px;border-radius:10px;cursor:pointer;font-size:14px;">Нет</button>' +
        '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    modal.querySelector('.custom-confirm-yes').onclick = () => { overlay.remove(); if (onConfirm) onConfirm(); };
    modal.querySelector('.custom-confirm-no').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// A bottom action-sheet: list of {label, icon, danger, onClick}
function showActionSheet(actions) {
    const overlay = document.createElement('div');
    overlay.className = 'action-sheet-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'action-sheet';
    actions.forEach(a => {
        const item = document.createElement('div');
        item.className = 'action-sheet-item' + (a.danger ? ' danger' : '');
        item.innerHTML = (a.icon ? '<i class="fas ' + a.icon + '"></i>' : '') + '<span>' + a.label + '</span>';
        item.onclick = () => { overlay.remove(); if (a.onClick) a.onClick(); };
        sheet.appendChild(item);
    });
    overlay.appendChild(sheet);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
}

// ==================== AUTH ====================
function showAuthScreen() {
    $('#bottomNav').classList.add('hidden');
    $('#mainContent').innerHTML = `
        <div class="screen active" id="authScreen">
            <div class="auth-container">
                <div class="auth-card" id="loginForm">
                    <h2>Вход в Quark</h2>
                    <input type="email" class="auth-input" id="loginEmail" placeholder="Email">
                    <input type="password" class="auth-input" id="loginPassword" placeholder="Пароль">
                    <button class="btn btn-primary" id="loginBtn">Войти</button>
                    <div class="auth-link" id="showRegister">Нет аккаунта? Регистрация</div>
                </div>
                <div class="auth-card hidden" id="registerForm">
                    <h2>Регистрация</h2>
                    <input type="text" class="auth-input" id="regName" placeholder="Имя">
                    <input type="email" class="auth-input" id="regEmail" placeholder="Email">
                    <input type="password" class="auth-input" id="regPassword" placeholder="Пароль">
                    <button class="btn btn-primary" id="registerBtn">Создать</button>
                    <div class="auth-link" id="showLogin">Есть аккаунт? Войти</div>
                </div>
            </div>
        </div>`;

    $('#loginBtn').onclick = login;
    $('#registerBtn').onclick = register;
    $('#showRegister').onclick = () => {
        $('#loginForm').classList.add('hidden');
        $('#registerForm').classList.remove('hidden');
    };
    $('#showLogin').onclick = () => {
        $('#registerForm').classList.add('hidden');
        $('#loginForm').classList.remove('hidden');
    };
}

async function login() {
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    if (!email || !password) return showCustomAlert('Заполните все поля');
    try {
        const result = await auth.signInWithEmailAndPassword(email, password);
        currentUser = result.user;
        await loadProfile();
        buildMainUI();
        await initChats();
    } catch (err) {
        showCustomAlert('Ошибка: ' + err.message);
    }
}

async function register() {
    const name = $('#regName').value.trim();
    const email = $('#regEmail').value.trim();
    const password = $('#regPassword').value;
    if (!name || !email || !password) return showCustomAlert('Заполните все поля');
    if (password.length < 6) return showCustomAlert('Пароль минимум 6 символов');
    try {
        const result = await auth.createUserWithEmailAndPassword(email, password);
        currentUser = result.user;
        currentProfile = { id: currentUser.uid, displayName: name, username: '', bio: '', avatarUrl: '' };
        await db.collection('users').doc(currentUser.uid).set(currentProfile);
        buildMainUI();
        await initChats();
    } catch (err) {
        showCustomAlert('Ошибка: ' + err.message);
    }
}

// Tears down everything tied to the current session: live listeners,
// heartbeat/status timers and our own typing flag.
function teardownSession() {
    if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
    if (unsubscribeMyMessages) { unsubscribeMyMessages(); unsubscribeMyMessages = null; }
    if (unsubscribeGeneralMessages) { unsubscribeGeneralMessages(); unsubscribeGeneralMessages = null; }
    if (unsubscribeAllUsers) { unsubscribeAllUsers(); unsubscribeAllUsers = null; }
    if (unsubscribeMyChats) { unsubscribeMyChats(); unsubscribeMyChats = null; }
    if (unsubscribeUserStatus) { unsubscribeUserStatus(); unsubscribeUserStatus = null; }
    if (unsubscribeChatMeta) { unsubscribeChatMeta(); unsubscribeChatMeta = null; }
    if (unsubscribeTyping) { unsubscribeTyping(); unsubscribeTyping = null; }
    if (unsubscribeStories) { unsubscribeStories(); unsubscribeStories = null; }
    if (unsubscribePinned) { unsubscribePinned(); unsubscribePinned = null; }
    if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
    currentPinnedIds = new Set();
    currentPinnedList = [];
    pinnedShownIndex = 0;
    storiesByUser = {};
    stopHeartbeat();
    if (statusTickInterval) { clearInterval(statusTickInterval); statusTickInterval = null; }
    if (currentUser && currentChat && !isGroupLike(currentChat)) {
        clearTyping(chatIdFor(currentChat));
    }
    currentUser = null;
    currentProfile = null;
    allUsers = {};
    allChats = {};
    activeChats = new Set();
    myChatIds = new Set();
    currentChat = null;
    messageCache = {};
    renderedMsgIds = {};
    chatListRowSig = {};
    lastMessageTimes = {};
    unreadCounts = {};
}

async function logout() {
    showCustomConfirm('Выйти из аккаунта?', async () => {
        const uid = currentUser.uid;
        teardownSession();
        try {
            await db.collection('users').doc(uid).update({
                online: false,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) {}
        await auth.signOut();
        showAuthScreen();
    });
}

// A single hardcoded account gets a TikTok-style verification checkmark
// next to its name everywhere. Tagged once (client-side, on that
// account's own login) by writing verified:true to its own user doc, so
// every other client just reads it like any other profile field.
const VERIFIED_EMAIL = 'kreys.tt.tt@gmail.com';
const VERIFIED_BADGE_HTML = '<i class="fas fa-check-circle verified-badge" title="Подтверждённый аккаунт"></i>';
function verifiedBadge(isVerified) {
    return isVerified ? ' ' + VERIFIED_BADGE_HTML : '';
}

async function loadProfile() {
    const doc = await db.collection('users').doc(currentUser.uid).get();
    if (doc.exists) {
        currentProfile = { id: currentUser.uid, ...doc.data() };
    } else {
        currentProfile = { id: currentUser.uid, displayName: currentUser.email.split('@')[0], username: '', bio: '', avatarUrl: '' };
        await db.collection('users').doc(currentUser.uid).set(currentProfile);
    }
    if (currentUser.email === VERIFIED_EMAIL && !currentProfile.verified) {
        currentProfile.verified = true;
        await db.collection('users').doc(currentUser.uid).update({ verified: true }).catch(() => {});
    }
    await db.collection('users').doc(currentUser.uid).update({
        lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
        online: true
    });
    startHeartbeat();
    saveCurrentAccount();
}

// ==================== PRESENCE ====================
function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (!currentUser || document.hidden) return;
        db.collection('users').doc(currentUser.uid).update({
            online: true,
            lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function setPresence(online) {
    if (!currentUser) return;
    db.collection('users').doc(currentUser.uid).update({
        online: online,
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
    if (!currentUser) return;
    setPresence(!document.hidden);
});

window.addEventListener('pagehide', () => setPresence(false));
window.addEventListener('beforeunload', () => setPresence(false));

// ==================== MOBILE KEYBOARD / VIEWPORT FIX ====================
// Without this, opening the on-screen keyboard resizes the *layout*
// viewport in some mobile browsers, so the whole page (header + list)
// slides up with it instead of just the input/message area resizing —
// unlike Telegram, where only the composer moves.
function setupViewportFix() {
    const app = $('#app');
    if (!app || !window.visualViewport) return;

    const vv = window.visualViewport;
    function update() {
        app.style.height = vv.height + 'px';
        window.scrollTo(0, 0);
        const area = $('#msgArea');
        if (area && shouldScrollDown) area.scrollTop = 999999;
    }
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
}

// ==================== MAIN UI ====================
function buildMainUI() {
    $('#bottomNav').classList.remove('hidden');
    $('#mainContent').innerHTML = `
        <div class="screen active" id="screenChats">
            <div class="header">
                <span style="font-weight:700;font-size:19px;color:var(--text);">Quark</span>
                <div class="desktop-header-actions" id="desktopHeaderActions">
                    <button class="dt-nav-btn active" data-sc="screenChats" title="Чаты"><i class="fas fa-comment"></i></button>
                    <button class="dt-nav-btn" data-sc="screenProfile" title="Профиль"><i class="fas fa-user"></i></button>
                    <button class="dt-nav-btn" data-sc="screenSettings" title="Настройки"><i class="fas fa-cog"></i></button>
                    <div class="desktop-scale-control" id="desktopScaleControl" title="Масштаб интерфейса">
                        <button class="scale-btn" id="scaleDownBtn"><i class="fas fa-minus"></i></button>
                        <span class="scale-value" id="scaleValueLabel">100%</span>
                        <button class="scale-btn" id="scaleUpBtn"><i class="fas fa-plus"></i></button>
                    </div>
                </div>
            </div>
            <div class="stories-row" id="storiesRow">
                <div class="stories-row-bg"></div>
                <div class="stories-row-content" id="storiesRowContent"></div>
            </div>
            <div class="chat-scroll">
                <div class="search-box">
                    <div class="search-wrapper"><i class="fas fa-search"></i><input type="text" class="search-input" id="searchInput" placeholder="Поиск людей, групп, каналов..."></div>
                </div>
                <div id="chatList"></div>
            </div>
            <button class="fab-new-chat" id="newChatBtn"><i class="fas fa-plus"></i></button>
        </div>
        <div class="screen" id="screenMessages">
            <div class="header">
                <button class="icon-button" id="backBtn"><i class="fas fa-arrow-left"></i></button>
                <button class="icon-button" id="cancelSelectBtn" style="display:none;"><i class="fas fa-times"></i></button>
                <div class="avatar chat-header-avatar" id="msgAv"></div>
                <div class="chat-header-info" id="msgInfo">
                    <div class="chat-header-name" id="msgName"></div>
                    <div class="chat-header-typing" id="msgTyping"></div>
                </div>
                <button class="icon-button" id="deleteSelectedBtn" style="display:none;color:var(--danger);"><i class="fas fa-trash"></i></button>
            </div>
            <div class="pinned-bar hidden" id="pinnedBar">
                <i class="fas fa-thumbtack"></i>
                <div class="pinned-bar-text" id="pinnedBarText"></div>
                <span class="pinned-bar-close" id="pinnedBarClose"><i class="fas fa-times"></i></span>
            </div>
            <div class="msg-area" id="msgArea"><div class="empty-state"><i class="far fa-comments"></i><p>Выберите чат</p></div></div>
            <button class="scroll-bottom-btn" id="scrollBottomBtn"><i class="fas fa-chevron-down"></i></button>
            <div class="input-container" id="inputContainer">
                <div class="mention-suggestions hidden" id="mentionSuggestions"></div>
                <div class="reply-bar hidden" id="replyBar"><div class="reply-preview" id="replyPreview"></div><span class="reply-close" id="replyClose">✕</span></div>
                <div class="input-row" id="inputRow">
                    <button class="icon-button" id="attachBtn"><i class="fas fa-paperclip"></i></button>
                    <textarea class="msg-input" id="msgInput" placeholder="Сообщение..." rows="1"></textarea>
                    <button class="send-btn" id="sendBtn"><i class="fas fa-paper-plane"></i></button>
                </div>
                <div class="channel-locked-input hidden" id="channelLockedNote">Только администраторы канала могут отправлять сообщения</div>
            </div>
        </div>
        <div class="screen" id="screenProfile">
            <div class="header"><span style="font-weight:700;font-size:18px;color:var(--text);"><i class="fas fa-user-circle"></i> Профиль</span></div>
            <div class="info-scroll" id="profileBody"></div>
        </div>
        <div class="screen" id="screenSettings">
            <div class="header"><span style="font-weight:700;font-size:18px;color:var(--text);"><i class="fas fa-cog"></i> Настройки</span></div>
            <div class="settings-scroll">
                <div class="section-label first" style="margin-left:4px;">Внешний вид</div>
                <div class="settings-group">
                    <div class="settings-row" id="darkRow">
                        <div class="settings-left"><div class="settings-icon" style="background:var(--surface);color:var(--text);"><i class="fas fa-moon"></i></div><span class="settings-text">Тёмная тема</span></div>
                        <div class="toggle" id="darkToggle"></div>
                    </div>
                    <div class="settings-row" id="amoledRow">
                        <div class="settings-left"><div class="settings-icon" style="background:#000;color:#fff;"><i class="fas fa-circle"></i></div><span class="settings-text">Чёрный AMOLED</span></div>
                        <div class="toggle" id="amoledToggle"></div>
                    </div>
                    <div class="settings-row" id="accentRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(124,77,255,0.15);color:#7C4DFF;"><i class="fas fa-palette"></i></div><span class="settings-text">Цвет темы</span></div>
                        <span class="settings-value" id="accentValue">Фиолетовый</span>
                    </div>
                    <div class="settings-row" id="wallpaperRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-image"></i></div><span class="settings-text">Обои чата</span></div>
                        <span class="settings-value" id="wallpaperValue">По умолчанию</span>
                    </div>
                    <div class="settings-row" id="fontRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(59,130,246,0.15);color:#3B82F6;"><i class="fas fa-font"></i></div><span class="settings-text">Размер шрифта</span></div>
                        <span class="settings-value" id="fontValue">Средний</span>
                    </div>
                </div>

                <div class="section-label" style="margin-left:4px;">Сообщения</div>
                <div class="settings-group">
                    <div class="settings-row" id="quickReactionRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(124,77,255,0.15);color:#7C4DFF;"><i class="fas fa-bolt"></i></div><span class="settings-text">Быстрая реакция (двойной тап)</span></div>
                        <span class="settings-value" id="quickReactionValue">👍</span>
                    </div>
                </div>

                <div class="section-label" style="margin-left:4px;">Уведомления</div>
                <div class="settings-group">
                    <div class="settings-row" id="soundRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-volume-up"></i></div><span class="settings-text">Звук уведомлений</span></div>
                        <div class="toggle" id="soundToggle"></div>
                    </div>
                </div>

                <div class="section-label" style="margin-left:4px;">Приватность</div>
                <div class="settings-group">
                    <div class="settings-row" id="readReceiptsRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-check-double"></i></div><span class="settings-text">Отметки о прочтении</span></div>
                        <div class="toggle" id="readReceiptsToggle"></div>
                    </div>
                    <div class="settings-row" id="lastSeenRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-clock"></i></div><span class="settings-text">Показывать время захода</span></div>
                        <div class="toggle" id="lastSeenToggle"></div>
                    </div>
                    <div class="settings-row" id="typingRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-keyboard"></i></div><span class="settings-text">Статус «печатает...»</span></div>
                        <div class="toggle" id="typingToggle"></div>
                    </div>
                    <div class="settings-row" id="privateProfileRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(239,68,68,0.15);color:var(--danger);"><i class="fas fa-user-shield"></i></div><span class="settings-text">Скрыть профиль из поиска</span></div>
                        <div class="toggle" id="privateProfileToggle"></div>
                    </div>
                    <div class="settings-row" id="storyForwardRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-share"></i></div><span class="settings-text">Разрешить пересылку моих историй</span></div>
                        <div class="toggle" id="storyForwardToggle"></div>
                    </div>
                </div>

                <div class="section-label" style="margin-left:4px;">Данные</div>
                <div class="settings-group">
                    <div class="settings-row" id="clearCacheRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(59,130,246,0.15);color:#3B82F6;"><i class="fas fa-broom"></i></div><span class="settings-text">Очистить кэш</span></div>
                    </div>
                </div>

                <div class="section-label" style="margin-left:4px;">Аккаунт</div>
                <div class="settings-group">
                    <div class="settings-row" id="switchAccountRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(124,77,255,0.15);color:var(--primary);"><i class="fas fa-exchange-alt"></i></div><span class="settings-text">Сменить аккаунт</span></div>
                    </div>
                    <div class="settings-row" id="aboutRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(128,128,128,0.15);color:var(--text-secondary);"><i class="fas fa-info-circle"></i></div><span class="settings-text">О приложении</span></div>
                    </div>
                    <div class="settings-row" id="settLogout">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(239,68,68,0.15);color:var(--danger);"><i class="fas fa-sign-out-alt"></i></div><span class="settings-text" style="color:var(--danger);">Выйти</span></div>
                    </div>
                </div>
            </div>
        </div>
        <div class="screen" id="screenViewProfile">
            <div class="header">
                <button class="icon-button" id="vpBackBtn"><i class="fas fa-arrow-left"></i></button>
                <span style="font-weight:700;font-size:17px;color:var(--text);">Профиль</span>
            </div>
            <div class="info-scroll" id="viewProfileBody"></div>
        </div>
        <div class="screen" id="screenChatInfo">
            <div class="header">
                <button class="icon-button" id="ciBackBtn"><i class="fas fa-arrow-left"></i></button>
                <span style="font-weight:700;font-size:17px;color:var(--text);">Информация</span>
            </div>
            <div class="info-scroll" id="chatInfoBody"></div>
        </div>`;

    $('#bottomNav').innerHTML = `
        <button class="nav-item active" data-sc="screenChats"><span class="nav-icon-wrap"><i class="fas fa-comments"></i><span class="nav-badge hidden" id="navChatsBadge"></span></span><span>Чаты</span></button>
        <button class="nav-item" data-sc="screenProfile"><i class="fas fa-user"></i><span>Профиль</span></button>
        <button class="nav-item" data-sc="screenSettings"><i class="fas fa-cog"></i><span>Настройки</span></button>`;

    const menu = document.createElement('div');
    menu.className = 'attach-menu';
    menu.id = 'attachMenu';
    menu.innerHTML = '<button class="attach-menu-item" data-accept="image/*"><i class="fas fa-image" style="color:#10B981;"></i> Фото</button>';
    document.body.appendChild(menu);

    renderOwnProfile();
    applyFontSize();
    applyTheme();

    const dt = $('#darkToggle'); if (dt) dt.classList.toggle('active', darkMode);
    const st = $('#soundToggle'); if (st) st.classList.toggle('active', soundEnabled);
    const rt = $('#readReceiptsToggle'); if (rt) rt.classList.toggle('active', readReceiptsEnabled);
    const lt = $('#lastSeenToggle'); if (lt) lt.classList.toggle('active', (currentProfile && currentProfile.lastSeenEnabled) !== false);
    const tt = $('#typingToggle'); if (tt) tt.classList.toggle('active', (currentProfile && currentProfile.typingIndicatorEnabled) !== false);
    const pt = $('#privateProfileToggle'); if (pt) pt.classList.toggle('active', !!(currentProfile && currentProfile.privateProfile));
    const sft = $('#storyForwardToggle'); if (sft) sft.classList.toggle('active', (currentProfile && currentProfile.allowStoryForward) !== false);
    const fv = $('#fontValue'); if (fv) fv.textContent = { small: 'Мелкий', medium: 'Средний', large: 'Крупный' }[fontSize] || 'Средний';
    const av = $('#accentValue'); if (av) av.textContent = { purple: 'Фиолетовый', blue: 'Синий', green: 'Зелёный', pink: 'Розовый', orange: 'Оранжевый', teal: 'Бирюзовый', red: 'Красный' }[accentTheme] || 'Фиолетовый';
    const wv = $('#wallpaperValue'); if (wv) wv.textContent = chatWallpaper ? 'Своё изображение' : 'По умолчанию';
    const qrv = $('#quickReactionValue'); if (qrv) qrv.textContent = quickReactionEmoji;

    setupListeners();
    setupViewportFix();

    if (statusTickInterval) clearInterval(statusTickInterval);
    statusTickInterval = setInterval(() => {
        if (currentChat) updateStatusDisplay();
    }, 15000);
}

let _profAvatarInput = null;
let _profCoverInput = null;

function renderOwnProfile() {
    const body = $('#profileBody');
    if (!body) return;
    const p = currentProfile || {};

    body.innerHTML =
        '<div class="tg-cover' + (p.coverUrl ? ' has-photo' : '') + '"' + (p.coverUrl ? ' style="background-image:url(\'' + p.coverUrl + '\')"' : '') + '>' +
        '<div class="tg-cover-edit" id="coverEditBtn" title="Изменить обложку"><i class="fas fa-camera"></i></div>' +
        '<div class="tg-cover-avatar-wrap">' +
        '<div class="avatar" id="profAv">' + (p.avatarUrl ? '<img src="' + p.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : '<i class="fas fa-user"></i>') + '</div>' +
        '<div class="tg-cover-avatar-edit" id="avEditBtn"><i class="fas fa-camera"></i></div>' +
        '</div>' +
        '<div class="tg-cover-info">' +
        '<div class="tg-cover-name">' + (p.displayName || 'Пользователь') + verifiedBadge(p.verified) + '</div>' +
        '<div class="tg-cover-sub">' + (p.username ? '@' + p.username : '') + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="section-label first" style="margin-left:16px;">Мой канал</div>' +
        '<div id="ownChannelSection"></div>' +
        '<div class="section-label" style="margin-left:16px;">Личные данные</div>' +
        '<div class="tg-edit-list">' +
        '<div class="form-group"><label>Имя</label><input type="text" class="form-input" id="dnInput" value="' + (p.displayName || '').replace(/"/g, '&quot;') + '"></div>' +
        '<div class="form-group"><label>Username</label><input type="text" class="form-input" id="unInput" placeholder="@username" value="' + (p.username || '').replace(/"/g, '&quot;') + '"></div>' +
        '<div class="form-group"><label>О себе</label><textarea class="form-input" id="bioInput" rows="2">' + (p.bio || '') + '</textarea></div>' +
        '<button class="btn btn-primary" id="saveProfBtn" style="margin-bottom:14px;">Сохранить</button>' +
        '</div>' +
        '<div class="tg-danger-list">' +
        '<div class="tg-danger-row" id="logoutBtn"><i class="fas fa-sign-out-alt"></i> Выйти</div>' +
        '</div>';

    renderOwnChannelSection();

    $('#saveProfBtn').onclick = async () => {
        const dn = $('#dnInput')?.value.trim();
        const un = $('#unInput')?.value.trim().replace('@', '');
        if (!dn) return showCustomAlert('Введите имя');
        if (un && !/^[a-zA-Z0-9._]+$/.test(un)) {
            return showCustomAlert('Username может содержать только латинские буквы, цифры, точки и подчёркивания');
        }
        if (un && un !== (currentProfile.username || '')) {
            if (await isUsernameTaken(un, { excludeUserId: currentUser.uid })) return showCustomAlert('Username занят');
        }

        const data = {
            displayName: dn,
            username: un,
            bio: $('#bioInput')?.value.trim() || '',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('users').doc(currentUser.uid).update(data);
        currentProfile = { ...currentProfile, ...data };
        renderOwnProfile();
        renderChatList();
        showCustomAlert('✅ Сохранено');
    };

    if (!_profAvatarInput) {
        _profAvatarInput = document.createElement('input');
        _profAvatarInput.type = 'file';
        _profAvatarInput.accept = 'image/*';
        _profAvatarInput.className = 'hidden';
        document.body.appendChild(_profAvatarInput);
        _profAvatarInput.onchange = async () => {
            const file = _profAvatarInput.files[0];
            if (!file) return;
            const compressed = await compressFile(file);
            const img = new Image();
            img.src = compressed.dataUrl;
            await new Promise(r => img.onload = r);
            const canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 200;
            canvas.getContext('2d').drawImage(img, 0, 0, 200, 200);
            const avatarUrl = canvas.toDataURL('image/jpeg', 0.5);
            currentProfile.avatarUrl = avatarUrl;
            await db.collection('users').doc(currentUser.uid).update({
                avatarUrl: avatarUrl,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            renderOwnProfile();
            renderChatList();
        };
    }
    $('#avEditBtn').onclick = () => _profAvatarInput.click();

    if (!_profCoverInput) {
        _profCoverInput = document.createElement('input');
        _profCoverInput.type = 'file';
        _profCoverInput.accept = 'image/*';
        _profCoverInput.className = 'hidden';
        document.body.appendChild(_profCoverInput);
        _profCoverInput.onchange = async () => {
            const file = _profCoverInput.files[0];
            if (!file) return;
            const compressed = await compressFile(file);
            const img = new Image();
            img.src = compressed.dataUrl;
            await new Promise(r => img.onload = r);
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');
            const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
            const sw = canvas.width / scale;
            const sh = canvas.height / scale;
            const sx = (img.width - sw) / 2;
            const sy = (img.height - sh) / 2;
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            const coverUrl = canvas.toDataURL('image/jpeg', 0.6);
            currentProfile.coverUrl = coverUrl;
            await db.collection('users').doc(currentUser.uid).update({
                coverUrl: coverUrl,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            renderOwnProfile();
        };
    }
    $('#coverEditBtn').onclick = () => _profCoverInput.click();

    $('#logoutBtn').onclick = logout;
}

// Lets you pin one of your channels to your profile — like Telegram's
// "add your channel" — so people viewing your profile see it and can
// jump straight in.
function renderOwnChannelSection() {
    const el = $('#ownChannelSection');
    if (!el) return;
    const p = currentProfile || {};
    const featured = p.featuredChannelId ? allChats[p.featuredChannelId] : null;

    if (featured) {
        el.innerHTML =
            '<div class="tg-info-list"><div class="member-row" id="ownChannelRow">' +
            '<div class="avatar">' + (featured.avatarUrl ? '<img src="' + featured.avatarUrl + '">' : initials(featured.name)) + '</div>' +
            '<div class="member-row-info"><div class="member-row-name">' + (featured.name || 'Канал') + '</div>' +
            '<div class="member-row-sub">' + (featured.username ? '@' + featured.username + ' &middot; ' : '') + (featured.members || []).length + ' подписчиков</div></div>' +
            '</div></div>' +
            '<button class="btn btn-danger" id="removeOwnChannelBtn" style="margin:0 16px 14px;width:calc(100% - 32px);">Убрать канал из профиля</button>';
        $('#ownChannelRow').onclick = () => openChat(p.featuredChannelId);
        $('#removeOwnChannelBtn').onclick = async () => {
            await db.collection('users').doc(currentUser.uid).update({ featuredChannelId: firebase.firestore.FieldValue.delete() });
            delete currentProfile.featuredChannelId;
            renderOwnChannelSection();
        };
    } else {
        el.innerHTML = '<div style="display:flex;justify-content:center;padding:6px 0 20px;"><div class="tg-action-btn" id="addOwnChannelBtn"><div class="circle"><i class="fas fa-bullhorn"></i></div><span>Добавить канал</span></div></div>';
        $('#addOwnChannelBtn').onclick = () => {
            const myChannels = Object.values(allChats).filter(c => c.type === 'channel' && (c.admins || []).includes(currentUser.uid));
            if (!myChannels.length) {
                showCustomConfirm('У вас пока нет своего канала. Создать его?', () => showCreateChatFlow('channel'));
                return;
            }
            showActionSheet(myChannels.map(c => ({
                label: c.name || 'Канал',
                icon: 'fa-bullhorn',
                onClick: async () => {
                    await db.collection('users').doc(currentUser.uid).update({ featuredChannelId: c.id });
                    currentProfile.featuredChannelId = c.id;
                    renderOwnChannelSection();
                }
            })));
        };
    }
}

// ==================== INIT CHATS ====================
async function initChats() {
    await loadAllUsers();
    watchMyChats();
    await loadActiveChats();
    renderChatList();
    listenForMessages();
    watchStories();
    setTimeout(initPush, 2000);
}

// Live-updates the whole users directory instead of a one-time snapshot.
// Without this, someone who messages you for the first time after your
// session started was invisible to allUsers[...] checks, so their chat
// never showed up in the list until you reloaded the app.
function loadAllUsers() {
    return new Promise((resolve) => {
        if (unsubscribeAllUsers) unsubscribeAllUsers();
        let first = true;
        unsubscribeAllUsers = db.collection('users').onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                if (change.type === 'removed') {
                    delete allUsers[change.doc.id];
                } else {
                    allUsers[change.doc.id] = { id: change.doc.id, ...change.doc.data() };
                }
            });
            if (first) {
                first = false;
                resolve();
            } else {
                renderChatList();
                if (currentChat && !isGroupLike(currentChat)) updateStatusDisplay();
            }
        });
    });
}

// Live listener for every group/channel I belong to. New groups I'm added
// to (or create) appear immediately without needing a reload.
function watchMyChats() {
    if (unsubscribeMyChats) unsubscribeMyChats();
    let first = true;
    unsubscribeMyChats = db.collection('chats').where('members', 'array-contains', currentUser.uid).onSnapshot(snap => {
        snap.docChanges().forEach(change => {
            const id = change.doc.id;
            if (change.type === 'removed') {
                delete allChats[id];
                myChatIds.delete(id);
                return;
            }
            allChats[id] = { id, ...change.doc.data() };
            if (!myChatIds.has(id)) {
                myChatIds.add(id);
                loadChatPreview(id, id);
            }
            if (currentChat === id) {
                renderChatHeader(id);
                updateStatusDisplay();
            }
        });
        if (!first) renderChatList();
        first = false;
    });
}

async function loadActiveChats() {
    activeChats = new Set();
    // Scoped to messages I've actually sent OR received — using the
    // participants array (not just my own outgoing messages) is what
    // makes a chat someone started with me show up after I log back in,
    // even if I never replied. We also merge in the older "userId == me"
    // query so DMs from before this field existed (where I sent at least
    // one message) don't vanish from the list after this update.
    const processDocs = (snap) => {
        snap.forEach(doc => {
            const msg = doc.data();
            if (!msg.chatId || isGroupLike(msg.chatId)) return;
            const other = otherDmUid(msg.chatId);
            if (other && allUsers[other]) activeChats.add(other);
        });
    };
    try {
        const snap = await db.collection('messages').where('participants', 'array-contains', currentUser.uid).get();
        processDocs(snap);
    } catch (e) {}
    try {
        const snap2 = await db.collection('messages').where('userId', '==', currentUser.uid).get();
        processDocs(snap2);
    } catch (e) {}
    for (const uid of activeChats) {
        await loadChatPreview(uid, chatIdFor(uid));
    }
}

// Works for both a DM partner uid and a group/channel id — `cid` is always
// the actual Firestore chatId to query, `id` is what we key preview/time
// maps and the UI list by.
async function loadChatPreview(id, cid) {
    if (messageCache[cid]) return;
    try {
        const snap = await db.collection('messages').where('chatId', '==', cid).orderBy('timestamp', 'asc').limit(50).get();
        const msgs = [];
        snap.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
        messageCache[cid] = msgs;
        if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            lastMessagePreviews[id] = last.imageUrl ? '<i class="fas fa-image"></i> Фото' : (last.text || '').substring(0, 30);
            const ts = last.timestamp?.toDate();
            if (ts) lastMessageTimes[id] = ts.getTime();
            renderChatList();
        }
    } catch (e) {}
}

// ==================== CHAT LIST ====================
// cid -> signature string of what was last rendered for that row, so an
// unrelated update (e.g. a reaction added in a different chat) doesn't
// touch rows whose visible content hasn't actually changed.
let chatListRowSig = {};

function buildChatRow(id, isGroup, meta) {
    const name = isGroup ? (meta.name || 'Чат') : (meta.displayName || 'Пользователь');
    const avatarUrl = meta.avatarUrl || '';
    const unread = unreadCounts[id] || 0;
    const preview = lastMessagePreviews[id] || '';
    const time = lastMessageTimes[id] || 0;

    let badge = '';
    if (id === GENERAL_CHAT_ID) badge = '<span class="chat-badge">общий</span>';

    const online = !isGroup && isUserOnline(meta) && canShowLastSeen(meta);

    const div = document.createElement('div');
    div.className = 'chat-item';
    div.dataset.cid = id;
    div.innerHTML =
        '<div class="avatar-wrap"><div class="avatar">' + (avatarUrl ? '<img src="' + avatarUrl + '">' : initials(name)) + '</div>' + (online ? '<span class="online-dot"></span>' : '') + '</div>' +
        '<div class="chat-info">' +
        '<div class="chat-name">' + name + (isGroup ? '' : verifiedBadge(meta.verified)) + badge + '</div>' +
        '<div class="chat-preview">' + preview + '</div>' +
        '</div>' +
        '<div class="chat-meta">' +
        '<div class="chat-time">' + formatTime(time) + '</div>' +
        (unread > 0 ? '<div class="chat-unread-badge">' + (unread > 99 ? '99+' : unread) + '</div>' : '') +
        '</div>';
    div.onclick = () => { unreadCounts[id] = 0; openChat(id); };
    return div;
}

function chatRowSignature(id, isGroup, meta) {
    const name = isGroup ? (meta.name || 'Чат') : (meta.displayName || 'Пользователь');
    const online = !isGroup && isUserOnline(meta) && canShowLastSeen(meta);
    return [
        name, meta.avatarUrl || '', meta.verified ? 1 : 0, online ? 1 : 0,
        unreadCounts[id] || 0, lastMessagePreviews[id] || '', lastMessageTimes[id] || 0
    ].join('\u0001');
}

function renderChatList() {
    const list = $('#chatList');
    if (!list) return;

    const ids = new Set([...activeChats, ...myChatIds]);
    const sorted = [...ids].filter(id => isGroupLike(id) ? !!allChats[id] : !!allUsers[id]);
    sorted.sort((a, b) => {
        if (a === GENERAL_CHAT_ID) return -1;
        if (b === GENERAL_CHAT_ID) return 1;
        return (lastMessageTimes[b] || 0) - (lastMessageTimes[a] || 0);
    });

    // Drop rows for chats that fell out of the list entirely.
    Array.from(list.children).forEach(row => {
        if (!sorted.includes(row.dataset.cid)) {
            delete chatListRowSig[row.dataset.cid];
            row.remove();
        }
    });

    let prevEl = null;
    sorted.forEach(id => {
        const isGroup = isGroupLike(id);
        const meta = isGroup ? allChats[id] : allUsers[id];
        const sig = chatRowSignature(id, isGroup, meta);
        let row = list.querySelector(':scope > [data-cid="' + id + '"]');
        if (!row) {
            row = buildChatRow(id, isGroup, meta);
        } else if (chatListRowSig[id] !== sig) {
            const fresh = buildChatRow(id, isGroup, meta);
            row.replaceWith(fresh);
            row = fresh;
        }
        chatListRowSig[id] = sig;
        const wantedNext = prevEl ? prevEl.nextSibling : list.firstChild;
        if (wantedNext !== row) list.insertBefore(row, wantedNext);
        prevEl = row;
    });

    updateNavBadge();
}

// Total-unread badge on the "Чаты" tab of the bottom nav — sums the
// per-chat counters so there's a single glance-able indicator, like the
// app-icon/tab badges in Telegram or WhatsApp.
function updateNavBadge() {
    const badge = $('#navChatsBadge');
    if (!badge) return;
    const total = Object.values(unreadCounts).reduce((sum, n) => sum + (n || 0), 0);
    if (total > 0) {
        badge.textContent = total > 99 ? '99+' : String(total);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// ==================== STORIES ====================
// Stories live 24h, like Telegram/WhatsApp Status. Images are stored the
// same way chat images are — as compressed data URLs directly on the
// Firestore doc, since this app has no separate file storage.
function watchStories() {
    if (unsubscribeStories) { unsubscribeStories(); unsubscribeStories = null; }
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    unsubscribeStories = db.collection('stories')
        .where('timestamp', '>', dayAgo)
        .orderBy('timestamp', 'asc')
        .onSnapshot(snap => {
            const byUser = {};
            snap.forEach(doc => {
                const s = { id: doc.id, ...doc.data() };
                if (!s.userId) return;
                (byUser[s.userId] = byUser[s.userId] || []).push(s);
            });
            storiesByUser = byUser;
            renderStoriesRow();
        }, () => {});
}

function renderStoriesRow() {
    const row = $('#storiesRowContent');
    if (!row || !currentUser) return;
    row.innerHTML = '';

    const myStories = storiesByUser[currentUser.uid] || [];
    const p = currentProfile || {};
    const mine = document.createElement('div');
    mine.className = 'story-item';
    mine.innerHTML =
        '<div class="story-avatar-wrap' + (myStories.length ? ' has-story' : '') + '">' +
        '<div class="avatar">' + (p.avatarUrl ? '<img src="' + p.avatarUrl + '">' : initials(p.displayName)) + '</div>' +
        (myStories.length ? '' : '<div class="story-add-badge"><i class="fas fa-plus"></i></div>') +
        '</div>' +
        '<div class="story-name">Ваша история</div>';
    mine.onclick = () => {
        if (myStories.length) openStoryViewer(currentUser.uid);
        else triggerStoryUpload();
    };
    row.appendChild(mine);

    Object.keys(storiesByUser).forEach(uid => {
        if (uid === currentUser.uid) return;
        const stories = storiesByUser[uid];
        if (!stories || !stories.length) return;
        const u = allUsers[uid];
        if (!u) return;
        const allViewed = stories.every(s => (s.viewedBy || []).includes(currentUser.uid));
        const item = document.createElement('div');
        item.className = 'story-item';
        item.innerHTML =
            '<div class="story-avatar-wrap has-story' + (allViewed ? ' viewed' : '') + '">' +
            '<div class="avatar">' + (u.avatarUrl ? '<img src="' + u.avatarUrl + '">' : initials(u.displayName)) + '</div>' +
            '</div>' +
            '<div class="story-name">' + (u.displayName || 'Пользователь').split(' ')[0] + '</div>';
        item.onclick = () => openStoryViewer(uid);
        row.appendChild(item);
    });
}

function triggerStoryUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
        const files = Array.from(input.files || []);
        if (files.length) openStoryQueue(files);
    };
    input.click();
}

// Reads a file as-is, with no resizing or recompression — unlike
// compressFile() used elsewhere in the app, on explicit request to keep
// full photo quality for stories. Note: the image still ends up stored
// as a base64 imageUrl directly on the Firestore story document, which
// has a 1MB-per-document limit, so a full-resolution phone photo can
// fail to upload where a compressed one wouldn't.
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Lets you pick several photos in one go and walks through them one at a
// time — each gets its own caption composer, and sending one advances to
// the next automatically, so a multi-photo pick becomes several stories
// (closing a composer early stops the queue instead of skipping ahead).
async function openStoryQueue(files, idx) {
    idx = idx || 0;
    if (idx >= files.length) return;
    let dataUrl;
    try {
        dataUrl = await readFileAsDataUrl(files[idx]);
    } catch (e) {
        showCustomAlert('Не удалось загрузить историю');
        return;
    }
    const progress = files.length > 1 ? { current: idx + 1, total: files.length } : null;
    openStoryComposer(dataUrl, progress, () => openStoryQueue(files, idx + 1));
}

// Pre-publish preview: lets you write a caption over the picked image
// before it goes out, like Telegram's story composer.
function openStoryComposer(dataUrl, progress, onDone) {
    const overlay = document.createElement('div');
    overlay.className = 'story-viewer-overlay story-composer-overlay';
    overlay.innerHTML =
        '<div class="story-viewer-header">' +
        '<span class="story-viewer-name">Новая история' + (progress ? ' (' + progress.current + '/' + progress.total + ')' : '') + '</span>' +
        '<span class="story-viewer-close" id="scClose"><i class="fas fa-times"></i></span>' +
        '</div>' +
        '<img class="story-viewer-img" src="' + dataUrl + '">' +
        '<div class="story-composer-bar">' +
        '<input type="text" class="story-caption-input" id="scCaptionInput" placeholder="Добавить подпись..." maxlength="200">' +
        '<button class="story-composer-send" id="scSend"><i class="fas fa-paper-plane"></i></button>' +
        '</div>';
    document.body.appendChild(overlay);

    // This overlay is appended straight to <body>, outside #app, so the
    // app-wide setupViewportFix() (which resizes #app to visualViewport's
    // height) never reaches it. Left alone, position:fixed + inset:0 sizes
    // this to the *layout* viewport, which iOS/Android often don't shrink
    // when the keyboard opens — so the caption bar stayed pinned to the
    // bottom of that full height, leaving a gap above the real keyboard,
    // and the browser scrolled the page trying to bring the input into
    // view. Resizing the overlay itself to visualViewport's height fixes
    // both.
    const vv = window.visualViewport;
    function fitToViewport() {
        overlay.style.height = vv.height + 'px';
        overlay.style.top = vv.offsetTop + 'px';
        window.scrollTo(0, 0);
    }
    if (vv) {
        vv.addEventListener('resize', fitToViewport);
        vv.addEventListener('scroll', fitToViewport);
        fitToViewport();
    }

    const close = () => {
        if (vv) {
            vv.removeEventListener('resize', fitToViewport);
            vv.removeEventListener('scroll', fitToViewport);
        }
        overlay.remove();
    };
    overlay.querySelector('#scClose').onclick = close;

    const input = overlay.querySelector('#scCaptionInput');
    const sendBtn = overlay.querySelector('#scSend');
    sendBtn.onclick = async () => {
        sendBtn.disabled = true;
        const caption = input.value.trim();
        try {
            await db.collection('stories').add({
                userId: currentUser.uid,
                imageUrl: dataUrl,
                caption: caption,
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                viewedBy: []
            });
            close();
            if (onDone) onDone();
        } catch (e) {
            sendBtn.disabled = false;
            showCustomAlert('Не удалось загрузить историю');
        }
    };
}

// Full-screen story viewer: progress segments across the top (one per
// story), auto-advances every 5s, tap left/right (or the arrows) to
// step through, and lets you delete your own story.
function openStoryViewer(uid) {
    const stories = storiesByUser[uid];
    if (!stories || !stories.length) return;
    let idx = 0;

    const overlay = document.createElement('div');
    overlay.className = 'story-viewer-overlay';
    document.body.appendChild(overlay);

    function close() {
        clearTimeout(storyViewerTimer);
        overlay.remove();
    }

    function go(dir) {
        idx += dir;
        if (idx < 0 || idx >= stories.length) { close(); return; }
        render();
    }

    const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '🔥'];

    function myReaction(story) {
        const reactions = story.reactions || {};
        for (const emoji in reactions) {
            if ((reactions[emoji] || []).includes(currentUser.uid)) return emoji;
        }
        return null;
    }

    async function setStoryReaction(story, emoji) {
        const reactions = story.reactions || {};
        const current = myReaction(story);
        // Remove any previous reaction of mine first — one reaction per
        // story per person, like Telegram.
        if (current && reactions[current]) {
            reactions[current] = reactions[current].filter(u => u !== currentUser.uid);
            if (!reactions[current].length) delete reactions[current];
        }
        if (current !== emoji) {
            if (!reactions[emoji]) reactions[emoji] = [];
            reactions[emoji].push(currentUser.uid);
        }
        story.reactions = reactions;
        try {
            await db.collection('stories').doc(story.id).update({ reactions: reactions });
        } catch (e) { console.error('Story reaction error:', e); }
    }

    function render() {
        clearTimeout(storyViewerTimer);
        const story = stories[idx];
        const u = uid === currentUser.uid ? currentProfile : allUsers[uid];

        const isMine = uid === currentUser.uid;
        const viewerCount = (story.viewedBy || []).length;
        const canForward = isMine || (u && u.allowStoryForward) !== false;
        const myReact = myReaction(story);

        overlay.innerHTML =
            '<div class="story-progress-row">' +
            stories.map((s, i) => '<div class="story-progress-seg"><div class="story-progress-fill' + (i < idx ? ' full' : '') + '"' + (i === idx ? ' style="animation:storyProgress 5s linear forwards;"' : '') + '></div></div>').join('') +
            '</div>' +
            '<div class="story-viewer-header">' +
            '<div class="avatar">' + (u && u.avatarUrl ? '<img src="' + u.avatarUrl + '">' : initials(u ? u.displayName : '')) + '</div>' +
            '<span class="story-viewer-name">' + (u ? (u.displayName || 'Пользователь') : 'Пользователь') + '</span>' +
            '<span class="story-viewer-time">' + formatTime(toMillis(story.timestamp)) + '</span>' +
            (canForward ? '<span class="story-viewer-forward" id="svForward"><i class="fas fa-share"></i></span>' : '') +
            '<span class="story-viewer-close" id="svClose"><i class="fas fa-times"></i></span>' +
            '</div>' +
            '<img class="story-viewer-img" src="' + story.imageUrl + '">' +
            '<div class="story-tap-zone left" id="svPrev"></div>' +
            '<div class="story-tap-zone right" id="svNext"></div>' +
            '<div id="svCaptionSlot"></div>' +
            (isMine ?
                ('<div class="story-bottom-bar">' +
                    '<div class="story-viewers-btn" id="svViewers"><i class="fas fa-eye"></i> <span>' + viewerCount + '</span></div>' +
                    '<div class="story-delete-btn" id="svDelete"><i class="fas fa-trash"></i></div>' +
                    '</div>')
                : ('<div class="story-reply-bar">' +
                    '<input type="text" class="story-reply-input" id="svReplyInput" placeholder="Ответить...">' +
                    '<div class="story-quick-heart' + (myReact ? ' reacted' : '') + '" id="svHeart">' + (myReact || '<i class="far fa-heart"></i>') + '</div>' +
                    '<button class="story-reply-send" id="svReplySend"><i class="fas fa-paper-plane"></i></button>' +
                    '</div>'));

        // Built via textContent (not string-concatenated into the HTML
        // above) so a caption can never inject markup into the overlay.
        if (story.caption) {
            const cap = document.createElement('div');
            cap.className = 'story-caption';
            cap.textContent = story.caption;
            overlay.querySelector('#svCaptionSlot').replaceWith(cap);
        } else {
            overlay.querySelector('#svCaptionSlot').remove();
        }

        overlay.querySelector('#svClose').onclick = close;
        overlay.querySelector('#svPrev').onclick = () => go(-1);
        overlay.querySelector('#svNext').onclick = () => go(1);

        const fwdBtn = overlay.querySelector('#svForward');
        if (fwdBtn) {
            fwdBtn.onclick = (e) => {
                e.stopPropagation();
                clearTimeout(storyViewerTimer);
                const ownerName = u ? (u.displayName || 'Пользователь') : 'Пользователь';
                openForwardPicker({ id: story.id, text: story.caption || '', imageUrl: story.imageUrl }, ownerName);
            };
        }

        const delBtn = overlay.querySelector('#svDelete');
        if (delBtn) {
            delBtn.onclick = (e) => {
                e.stopPropagation();
                clearTimeout(storyViewerTimer);
                showCustomConfirm('Удалить эту историю?', async () => {
                    try { await db.collection('stories').doc(story.id).delete(); } catch (e) {}
                    stories.splice(idx, 1);
                    if (!stories.length) { close(); return; }
                    if (idx >= stories.length) idx = stories.length - 1;
                    render();
                });
            };
        }

        const viewersBtn = overlay.querySelector('#svViewers');
        if (viewersBtn) {
            viewersBtn.onclick = (e) => {
                e.stopPropagation();
                clearTimeout(storyViewerTimer);
                openStoryViewersList(story, () => { storyViewerTimer = setTimeout(() => go(1), 5000); });
            };
        }

        // Reply input: pauses the auto-advance timer while focused/typing
        // so you don't get bumped to the next story mid-message, and
        // sends a DM back to the story's owner with a story reference so
        // it renders as a reply-to-story bubble in the chat.
        const replyInput = overlay.querySelector('#svReplyInput');
        const replySend = overlay.querySelector('#svReplySend');
        if (replyInput) {
            replyInput.onfocus = () => clearTimeout(storyViewerTimer);
            replyInput.onblur = () => { if (!replyInput.value.trim()) storyViewerTimer = setTimeout(() => go(1), 5000); };
            const send = async () => {
                const text = replyInput.value.trim();
                if (!text) return;
                replyInput.value = '';
                replyInput.disabled = true;
                try {
                    await sendStoryReply(uid, story, text);
                    showCustomAlert('Ответ отправлен');
                } catch (e) {
                    showSendErrorModal(e);
                } finally {
                    replyInput.disabled = false;
                    storyViewerTimer = setTimeout(() => go(1), 5000);
                }
            };
            replyInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
            if (replySend) replySend.onclick = (e) => { e.stopPropagation(); send(); };
        }

        // Heart quick-react (tap = react/un-react with ❤️) and a small
        // long-press popup to pick a different emoji, like Telegram.
        const heartBtn = overlay.querySelector('#svHeart');
        if (heartBtn) {
            let pressTimer = null;
            let longPressed = false;
            const openEmojiPopup = () => {
                document.querySelectorAll('.story-quick-emoji-popup').forEach(p => p.remove());
                const popup = document.createElement('div');
                popup.className = 'story-quick-emoji-popup';
                QUICK_EMOJIS.forEach(emoji => {
                    const chip = document.createElement('span');
                    chip.className = 'story-quick-emoji-popup-item';
                    chip.textContent = emoji;
                    chip.onclick = (e) => {
                        e.stopPropagation();
                        setStoryReaction(story, emoji);
                        popup.remove();
                        render();
                    };
                    popup.appendChild(chip);
                });
                heartBtn.appendChild(popup);
                setTimeout(() => {
                    document.addEventListener('click', function closeP(ev) {
                        if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', closeP); }
                    });
                }, 50);
            };
            heartBtn.onpointerdown = () => {
                longPressed = false;
                pressTimer = setTimeout(() => { longPressed = true; openEmojiPopup(); }, 450);
            };
            heartBtn.onpointerup = (e) => {
                clearTimeout(pressTimer);
                if (longPressed) return;
                e.stopPropagation();
                setStoryReaction(story, '❤️').then(render);
            };
            heartBtn.onpointerleave = () => clearTimeout(pressTimer);
        }

        if (uid !== currentUser.uid && !(story.viewedBy || []).includes(currentUser.uid)) {
            db.collection('stories').doc(story.id).update({
                viewedBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
            }).catch(() => {});
        }

        storyViewerTimer = setTimeout(() => go(1), 5000);
    }

    render();
}

// Sends a DM to the story owner referencing the story being replied to —
// renders in chat as a normal message with a small "reply to story"
// preview above it (same visual language as a normal message reply).
async function sendStoryReply(ownerUid, story, text) {
    const cid = chatIdFor(ownerUid);
    const payload = {
        text: text,
        imageUrl: '',
        fileName: '',
        fileType: '',
        fileUrl: '',
        userId: currentUser.uid,
        chatId: cid,
        readBy: [],
        replyTo: null,
        reactions: {},
        storyReply: { storyId: story.id, imageUrl: story.imageUrl || '', caption: story.caption || '' },
        participants: [currentUser.uid, ownerUid],
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('messages').add(payload);
    if (!activeChats.has(ownerUid)) {
        activeChats.add(ownerUid);
        await loadChatPreview(ownerUid, cid);
    }
}

// Bottom sheet listing who has viewed one of your own stories — like
// Telegram/Instagram's "seen by" list. Shows each viewer's reaction next
// to their name when they left one.
function openStoryViewersList(story, onClose) {
    const viewers = story.viewedBy || [];
    const reactions = story.reactions || {};
    const reactionByUid = {};
    for (const emoji in reactions) {
        (reactions[emoji] || []).forEach(u => { reactionByUid[u] = emoji; });
    }

    const overlay = document.createElement('div');
    overlay.className = 'action-sheet-overlay';
    overlay.style.zIndex = '410';
    const sheet = document.createElement('div');
    sheet.className = 'action-sheet story-viewers-sheet';

    const title = document.createElement('div');
    title.className = 'story-viewers-title';
    title.textContent = viewers.length
        ? ('Просмотрели: ' + viewers.length)
        : 'Пока никто не посмотрел';
    sheet.appendChild(title);

    if (viewers.length) {
        const list = document.createElement('div');
        list.className = 'tg-info-list';
        // Whoever reacted shows up first, like Telegram — the reaction is
        // the more interesting signal than a plain view.
        const sorted = [...viewers].sort((a, b) => (reactionByUid[b] ? 1 : 0) - (reactionByUid[a] ? 1 : 0));
        sorted.forEach(vuid => {
            const u = vuid === currentUser.uid ? currentProfile : allUsers[vuid];
            const row = document.createElement('div');
            row.className = 'member-row';
            const avatarWrap = document.createElement('div');
            avatarWrap.className = 'avatar';
            if (u && u.avatarUrl) {
                const img = document.createElement('img');
                img.src = u.avatarUrl;
                avatarWrap.appendChild(img);
            } else {
                avatarWrap.innerHTML = initials(u ? u.displayName : '');
            }
            const info = document.createElement('div');
            info.className = 'member-row-info';
            const name = document.createElement('div');
            name.className = 'member-row-name';
            name.textContent = u ? (u.displayName || 'Пользователь') : 'Пользователь';
            info.appendChild(name);
            row.appendChild(avatarWrap);
            row.appendChild(info);
            if (reactionByUid[vuid]) {
                const reactEl = document.createElement('div');
                reactEl.className = 'story-viewer-reaction-mark';
                reactEl.textContent = reactionByUid[vuid];
                row.appendChild(reactEl);
            }
            list.appendChild(row);
        });
        sheet.appendChild(list);
    }

    const close = () => { overlay.remove(); if (onClose) onClose(); };
    overlay.appendChild(sheet);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.body.appendChild(overlay);
}

// ==================== POST COMMENTS (channels) ====================
// Comments live in their own collection, keyed to the post by postId.
// No orderBy in the query on purpose — combined with the postId equality
// filter it would need a composite Firestore index this project doesn't
// have (the same issue that broke shared media before), so comments are
// fetched by postId alone and sorted client-side instead.
function openPostComments(msg, cid) {
    const overlay = document.createElement('div');
    overlay.className = 'comments-overlay';
    overlay.innerHTML =
        '<div class="comments-header">' +
        '<span class="comments-close" id="cmClose"><i class="fas fa-arrow-left"></i></span>' +
        '<span class="comments-title">Комментарии</span>' +
        '</div>' +
        '<div class="comments-post-preview" id="cmPostPreview"></div>' +
        '<div class="comments-list" id="cmList"></div>' +
        '<div class="comments-input-row">' +
        '<textarea class="comments-input" id="cmInput" placeholder="Написать комментарий..." rows="1"></textarea>' +
        '<button class="comments-send-btn" id="cmSend"><i class="fas fa-paper-plane"></i></button>' +
        '</div>';
    document.body.appendChild(overlay);

    // Same fix as the story composer overlay: this is appended straight to
    // <body>, outside #app, so it doesn't get the app-wide viewport-fix
    // resize. Left at position:fixed + inset:0, iOS/Android often don't
    // shrink the *layout* viewport when the keyboard opens, so the input
    // row stayed pinned below the real keyboard and the browser scrolled
    // the whole page up trying to bring the focused textarea into view.
    // Resizing the overlay itself to the *visual* viewport fixes both.
    const vv = window.visualViewport;
    function fitCommentsToViewport() {
        overlay.style.height = vv.height + 'px';
        overlay.style.top = vv.offsetTop + 'px';
        window.scrollTo(0, 0);
    }
    if (vv) {
        vv.addEventListener('resize', fitCommentsToViewport);
        vv.addEventListener('scroll', fitCommentsToViewport);
        fitCommentsToViewport();
    }

    const chMeta = allChats[cid] || {};
    const previewEl = overlay.querySelector('#cmPostPreview');
    const previewAvatar = document.createElement('div');
    previewAvatar.className = 'avatar';
    previewAvatar.innerHTML = chMeta.avatarUrl ? '<img src="' + chMeta.avatarUrl + '">' : initials(chMeta.name || 'Канал');
    const previewBody = document.createElement('div');
    previewBody.className = 'comments-post-body';
    const previewName = document.createElement('div');
    previewName.className = 'comments-post-name';
    previewName.textContent = chMeta.name || 'Канал';
    const previewText = document.createElement('div');
    previewText.className = 'comments-post-text';
    previewText.textContent = msg.text || (msg.imageUrl ? 'Фото' : '');
    previewBody.appendChild(previewName);
    previewBody.appendChild(previewText);
    previewEl.appendChild(previewAvatar);
    previewEl.appendChild(previewBody);

    const close = () => {
        if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
        if (vv) {
            vv.removeEventListener('resize', fitCommentsToViewport);
            vv.removeEventListener('scroll', fitCommentsToViewport);
        }
        overlay.remove();
    };
    overlay.querySelector('#cmClose').onclick = close;

    const listEl = overlay.querySelector('#cmList');
    listEl.innerHTML = '<div class="empty-state"><i class="far fa-comments"></i><p>Загрузка...</p></div>';

    if (unsubscribeComments) unsubscribeComments();
    unsubscribeComments = db.collection('comments').where('postId', '==', msg.id).onSnapshot(snap => {
        const items = [];
        snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
        items.sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
        renderComments(listEl, items);
    }, () => {
        listEl.innerHTML = '<div class="empty-state"><i class="far fa-comments"></i><p>Не удалось загрузить</p></div>';
    });

    const input = overlay.querySelector('#cmInput');
    const sendBtn = overlay.querySelector('#cmSend');
    input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
    const send = async () => {
        const text = input.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        try {
            await db.collection('comments').add({
                postId: msg.id,
                chatId: cid,
                userId: currentUser.uid,
                text: text,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
            await db.collection('messages').doc(msg.id).update({
                commentCount: firebase.firestore.FieldValue.increment(1)
            });
            input.value = '';
            input.style.height = 'auto';
        } catch (e) {
            console.error('Comment error:', e);
        }
        sendBtn.disabled = false;
    };
    sendBtn.onclick = send;
    input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
}

function renderComments(listEl, items) {
    listEl.innerHTML = '';
    if (!items.length) {
        listEl.innerHTML = '<div class="empty-state"><i class="far fa-comments"></i><p>Пока нет комментариев</p></div>';
        return;
    }
    items.forEach(c => {
        const u = c.userId === currentUser.uid ? currentProfile : allUsers[c.userId];
        const row = document.createElement('div');
        row.className = 'comment-row';
        const av = document.createElement('div');
        av.className = 'avatar';
        av.innerHTML = u && u.avatarUrl ? '<img src="' + u.avatarUrl + '">' : initials(u ? u.displayName : '');
        const body = document.createElement('div');
        body.className = 'comment-body';
        const nameEl = document.createElement('div');
        nameEl.className = 'comment-name';
        nameEl.innerHTML = (u ? (u.displayName || 'Пользователь') : 'Пользователь') + (u ? verifiedBadge(u.verified) : '');
        const textEl = document.createElement('div');
        textEl.className = 'comment-text';
        textEl.appendChild(renderTextWithMentions(c.text || ''));
        body.appendChild(nameEl);
        body.appendChild(textEl);
        row.appendChild(av);
        row.appendChild(body);
        listEl.appendChild(row);
    });
    listEl.scrollTop = listEl.scrollHeight;
}

// ==================== OPEN CHAT ====================
function openChat(id) {
    // Leaving the previous DM: stop announcing "typing" there and drop the
    // stale typing-listener before wiring up the new one.
    if (currentUser && currentChat && currentChat !== id && !isGroupLike(currentChat)) {
        clearTyping(chatIdFor(currentChat));
    }

    currentChat = id;
    unreadCounts[id] = 0;
    selectionMode = false;
    selectedMessages.clear();

    renderChatHeader(id);

    if (unsubscribeUserStatus) { unsubscribeUserStatus(); unsubscribeUserStatus = null; }
    if (unsubscribeChatMeta) { unsubscribeChatMeta(); unsubscribeChatMeta = null; }
    if (isGroupLike(id)) {
        if (id !== GENERAL_CHAT_ID) watchChatMeta(id);
    } else {
        watchUserStatus(id);
    }
    updateStatusDisplay();

    $('#cancelSelectBtn').style.display = 'none';
    $('#deleteSelectedBtn').style.display = 'none';

    updateComposerAvailability(id);

    const cid = chatIdFor(id);
    watchPinned(cid);
    if (messageCache[cid]) {
        renderFromCache(cid);
        setTimeout(() => { const area = $('#msgArea'); if (area) area.scrollTop = 999999; }, 200);
    } else {
        $('#msgArea').innerHTML = '<div class="empty-state"><i class="far fa-comments"></i><p>Загрузка...</p></div>';
    }

    subscribe(cid);
    showScreen('screenMessages');
    markRead(cid);
    renderChatList();
}

function renderChatHeader(id) {
    const isGroup = isGroupLike(id);
    const meta = isGroup ? allChats[id] : allUsers[id];
    if (!meta) return;
    const name = isGroup ? (meta.name || 'Чат') : (meta.displayName || 'Пользователь');
    $('#msgAv').innerHTML = meta.avatarUrl ? '<img src="' + meta.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : initials(name);
    $('#msgName').innerHTML = name + (isGroup ? '' : verifiedBadge(meta.verified));

    const info = $('#msgInfo');
    const av = $('#msgAv');
    if (info) info.onclick = () => (isGroup ? showChatInfo(id) : viewUserProfile(id));
    if (av) av.onclick = () => (isGroup ? showChatInfo(id) : viewUserProfile(id));
}

// Hides the composer for channels where the current user can't post —
// either because they're not an admin, or because they're just browsing
// the channel without having subscribed yet (e.g. opened via a profile's
// featured-channel card or search, which lands here without joining
// first). Offers the matching action button in the composer's place
// instead of just a locked note.
function updateComposerAvailability(id) {
    const row = $('#inputRow');
    const lockedNote = $('#channelLockedNote');
    const replyBar = $('#replyBar');
    if (!row || !lockedNote) return;

    const meta = allChats[id];
    if (!meta && !isGroupLike(id)) {
        // Definitely a DM, not a channel — posting is always allowed there.
        row.classList.remove('hidden');
        lockedNote.classList.add('hidden');
        lockedNote.innerHTML = '';
        return;
    }
    if (!meta) {
        // isGroupLike(id) said this IS a group/channel id, but its data
        // hasn't synced into allChats yet (e.g. a channel you just
        // subscribed to that you'd never loaded before) — don't guess:
        // hide the composer until we actually know whether posting is
        // allowed, instead of defaulting to "yes" and showing a real
        // input box to someone who isn't an admin.
        row.classList.add('hidden');
        lockedNote.classList.add('hidden');
        db.collection('chats').doc(id).get().then(doc => {
            if (doc.exists) {
                allChats[id] = { id: doc.id, ...doc.data() };
                if (chatIdFor(currentChat) === chatIdFor(id) || currentChat === id) updateComposerAvailability(id);
            }
        }).catch(() => {});
        return;
    }

    const isChannel = !!(meta && meta.type === 'channel');
    const isMember = !isChannel || (meta.members || []).includes(currentUser.uid);
    const isAdmin = isChannel && (meta.admins || []).includes(currentUser.uid);
    const canPost = !isChannel || isAdmin;

    if (canPost) {
        row.classList.remove('hidden');
        lockedNote.classList.add('hidden');
        lockedNote.innerHTML = '';
        return;
    }

    row.classList.add('hidden');
    lockedNote.classList.remove('hidden');
    if (replyBar) replyBar.classList.add('hidden');

    if (!isMember) {
        lockedNote.innerHTML = '<button class="btn btn-primary" id="channelJoinBtn" style="width:auto;padding:9px 20px;margin:0;"><i class="fas fa-bullhorn"></i> Подписаться на канал</button>';
        const joinBtn = $('#channelJoinBtn');
        if (joinBtn) {
            joinBtn.onclick = async () => {
                try {
                    await db.collection('chats').doc(id).update({
                        members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
                    });
                } catch (e) { console.error('Subscribe error:', e); }
                updateComposerAvailability(id);
                renderChatList();
            };
        }
        return;
    }

    lockedNote.innerHTML = '<button class="btn btn-danger" id="channelUnsubBtn" style="width:auto;padding:9px 20px;margin:0;"><i class="fas fa-user-minus"></i> Отписаться от канала</button>';
    const unsubBtn = $('#channelUnsubBtn');
    if (unsubBtn) {
        unsubBtn.onclick = () => {
            showCustomConfirm('Отписаться от этого канала?', async () => {
                try {
                    await db.collection('chats').doc(id).update({
                        members: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
                        admins: firebase.firestore.FieldValue.arrayRemove(currentUser.uid)
                    });
                } catch (e) { console.error('Unsubscribe error:', e); }
                activeChats.delete(id);
                showScreen('screenChats');
                renderChatList();
            });
        };
    }
}

function renderFromCache(cid) {
    const area = $('#msgArea');
    if (!area) return;
    const msgs = messageCache[cid] || [];
    area.innerHTML = '';
    if (!msgs.length) {
        area.innerHTML = '<div class="empty-state"><i class="far fa-comments"></i><p>Нет сообщений</p></div>';
        return;
    }
    let lastDate = null;
    const chatMeta = allChats[currentChat];
    const isChannel = !!(chatMeta && chatMeta.type === 'channel');
    const groupChat = isChannel || (isGroupLike(currentChat) && currentChat !== GENERAL_CHAT_ID ? (chatMeta && chatMeta.type === 'group') : (currentChat === GENERAL_CHAT_ID));
    msgs.forEach((msg, idx) => {
        const dt = msgDateOf(msg);
        const ds = dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        if (ds !== lastDate) {
            const dv = document.createElement('div');
            dv.className = 'date-divider';
            dv.textContent = ds;
            area.appendChild(dv);
            lastDate = ds;
        }
        const nextMsg = msgs[idx + 1];
        // Channel posts all share one visual identity (the channel), so
        // consecutive posts group together even when different admins
        // wrote them — only the sender's own userId matters elsewhere.
        const showAvatar = !nextMsg || (isChannel ? false : nextMsg.userId !== msg.userId);
        appendMsg(msg, dt, area, cid, groupChat, showAvatar, isChannel, false);
    });
    area.scrollTop = 999999;
    renderedMsgIds[cid] = new Set(msgs.map(m => m.id));
}

// ==================== SUBSCRIBE (foreground: the chat that's open) ====================
function subscribe(cid) {
    if (unsubscribeMessages) unsubscribeMessages();
    if (!isGroupLike(currentChat)) watchTyping(cid);

    // openChat() already left #msgArea in a known-correct state before
    // calling this — painted from messageCache via renderFromCache(), or
    // a loading placeholder if there was no cache. So even Firestore's
    // *first* snapshot (delivered as one 'added' docChange per doc) can
    // go through the same incremental path as every later one: ids
    // already in messageCache just get their data silently refreshed
    // with no DOM touch, and only genuinely new ones get appended. That
    // removes the double full-rebuild (once from the cache paint, once
    // from this "first" snapshot) that was flashing the whole chat every
    // time it was opened.
    unsubscribeMessages = db.collection('messages').where('chatId', '==', cid).orderBy('timestamp', 'asc').limit(2000).onSnapshot(snap => {
        applyMessageChanges(snap.docChanges(), cid);
    }, err => {
        unsubscribeMessages = db.collection('messages').orderBy('timestamp', 'asc').limit(400).onSnapshot(snap2 => {
            const filtered = { docs: snap2.docs.filter(d => d.data().chatId === cid), forEach(fn) { this.docs.forEach(fn); } };
            renderMessagesSnapshot(filtered, cid);
        });
    });
}

// Applies added/modified/removed message changes onto the already-
// rendered chat without touching any bubble that didn't actually change.
// Rebuilds just the one bubble for `id`, in place — the same targeted
// technique applyMessageChanges uses for incoming snapshot changes.
// For local actions (toggling a reaction, pinning) that already know
// exactly which message changed, this avoids the full-chat blank-and-
// rebuild that renderFromCache does, which is what caused the reaction/
// pin flicker.
function patchSingleMessage(cid, id) {
    const area = (currentChat !== null && chatIdFor(currentChat) === cid) ? $('#msgArea') : null;
    if (!area) return;
    const msgs = messageCache[cid] || [];
    const pos = msgs.findIndex(x => x.id === id);
    if (pos === -1) return;

    const chatMeta = allChats[currentChat];
    const isChannel = !!(chatMeta && chatMeta.type === 'channel');
    const groupChat = isChannel || currentChat === GENERAL_CHAT_ID || (chatMeta && chatMeta.type === 'group');
    const data = msgs[pos];
    const nextMsg = msgs[pos + 1];
    const showAvatar = !nextMsg || (isChannel ? false : nextMsg.userId !== data.userId);
    const fresh = buildMsgWrapper(data, msgDateOf(data), cid, groupChat, showAvatar, isChannel, false);
    const el = document.getElementById('msg-' + id);
    if (el) el.replaceWith(fresh); else area.appendChild(fresh);
}

function applyMessageChanges(changes, cid) {
    const msgs = messageCache[cid] || [];
    const area = (currentChat !== null && chatIdFor(currentChat) === cid) ? $('#msgArea') : null;

    const chatMeta = allChats[currentChat];
    const isChannel = !!(chatMeta && chatMeta.type === 'channel');
    const groupChat = isChannel || currentChat === GENERAL_CHAT_ID || (chatMeta && chatMeta.type === 'group');

    let tailMsg = msgs.length ? msgs[msgs.length - 1] : null;
    let tailDateStr = tailMsg ? msgDateOf(tailMsg).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : null;
    let hasNewMessage = false;
    let newMessageIsMine = false;

    if (area && !msgs.length) area.innerHTML = '';

    // The query is ascending, so Firestore already delivers 'added'
    // changes oldest-first — this sort is just a safety net in case that
    // ever isn't true (e.g. a future query-shape change), since the
    // append loop below assumes each 'added' change is chronologically
    // after everything before it. 'modified'/'removed' entries look up
    // their message by id regardless of position, so leaving them in
    // place is fine.
    const sortedChanges = [...changes].sort((a, b) => {
        if (a.type !== 'added' || b.type !== 'added') return 0;
        return toMillis(a.doc.data().timestamp) - toMillis(b.doc.data().timestamp);
    });

    sortedChanges.forEach(change => {
        const id = change.doc.id;
        const data = { id, ...change.doc.data() };
        const idx = msgs.findIndex(x => x.id === id);

        if (change.type === 'removed') {
            if (idx > -1) msgs.splice(idx, 1);
            if (renderedMsgIds[cid]) renderedMsgIds[cid].delete(id);
            if (area) {
                const el = document.getElementById('msg-' + id);
                if (el) el.remove();
            }
            if (tailMsg && tailMsg.id === id) tailMsg = msgs.length ? msgs[msgs.length - 1] : null;
            return;
        }

        if (change.type === 'modified') {
            const prevData = idx > -1 ? msgs[idx] : null;
            if (idx > -1) msgs[idx] = data; else msgs.push(data);
            // Sending a message fires 'added' (pending write) immediately
            // followed by 'modified' (server-confirmed timestamp) — with
            // nothing actually different on screen. Rebuilding the bubble
            // for that is what caused the post-send blink, so only touch
            // the DOM when something visible really changed.
            if (area && (!prevData || !msgVisualsEqual(prevData, data))) {
                const pos = msgs.findIndex(x => x.id === id);
                const nextMsg = msgs[pos + 1];
                const showAvatar = !nextMsg || (isChannel ? false : nextMsg.userId !== data.userId);
                const fresh = buildMsgWrapper(data, msgDateOf(data), cid, groupChat, showAvatar, isChannel, false);
                const el = document.getElementById('msg-' + id);
                if (el) el.replaceWith(fresh); else area.appendChild(fresh);
            }
            if (tailMsg && tailMsg.id === id) tailMsg = data;
            return;
        }

        // added
        if (idx > -1) {
            const prevData = msgs[idx];
            msgs[idx] = data;
            if (area && !msgVisualsEqual(prevData, data)) {
                const pos = msgs.findIndex(x => x.id === id);
                const nextMsg = msgs[pos + 1];
                const showAvatar = !nextMsg || (isChannel ? false : nextMsg.userId !== data.userId);
                const fresh = buildMsgWrapper(data, msgDateOf(data), cid, groupChat, showAvatar, isChannel, false);
                const el = document.getElementById('msg-' + id);
                if (el) el.replaceWith(fresh); else area.appendChild(fresh);
            }
            if (tailMsg && tailMsg.id === id) tailMsg = data;
            return;
        }
        msgs.push(data);
        hasNewMessage = true;
        if (data.userId === currentUser.uid) newMessageIsMine = true;
        if (!area) return;

        const dt = msgDateOf(data);
        const ds = dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        if (ds !== tailDateStr) {
            const dv = document.createElement('div');
            dv.className = 'date-divider';
            dv.textContent = ds;
            area.appendChild(dv);
            tailDateStr = ds;
        }

        // This new message is now the last one, so it always shows its own
        // avatar slot — but if the previous last message continues the
        // same "run" (same sender in a group chat, or any post in a
        // channel, since those all share the channel's identity), that
        // one is no longer the last of its run, so hide its avatar now
        // that this message takes over that spot. A no-op if that
        // previous bubble never had an avatar to begin with (e.g. it was
        // your own message in a non-channel chat).
        if (tailMsg && groupChat && (isChannel || tailMsg.userId === data.userId)) {
            const prevAv = document.querySelector('#msg-' + tailMsg.id + ' .msg-avatar');
            if (prevAv && !prevAv.classList.contains('msg-avatar-hidden')) {
                prevAv.classList.add('msg-avatar-hidden');
                prevAv.innerHTML = '';
                prevAv.style.cursor = '';
                prevAv.onclick = null;
            }
        }

        area.appendChild(buildMsgWrapper(data, dt, cid, groupChat, true, isChannel, true));
        if (renderedMsgIds[cid]) renderedMsgIds[cid].add(id); else renderedMsgIds[cid] = new Set([id]);
        tailMsg = data;
    });

    messageCache[cid] = msgs;

    if (area) {
        if (!msgs.length) {
            area.innerHTML = '<div class="empty-state"><i class="far fa-comments"></i><p>Нет сообщений</p></div>';
        } else {
            if (hasNewMessage && (shouldScrollDown || newMessageIsMine)) {
                area.scrollTop = 999999;
            }
            markRead(cid);
        }
    }

    const chatKeyId = isGroupLike(currentChat) ? currentChat : otherDmUid(cid);
    if (chatKeyId && msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        lastMessagePreviews[chatKeyId] = last.imageUrl ? '<i class="fas fa-image"></i> Фото' : (last.text || '').substring(0, 30);
        const ts = last.timestamp && last.timestamp.toDate ? last.timestamp.toDate() : null;
        if (ts) lastMessageTimes[chatKeyId] = ts.getTime();
        renderChatList();
    }
}

function renderMessagesSnapshot(snap, cid) {
    const msgs = [];
    snap.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
    messageCache[cid] = msgs;

    const area = $('#msgArea');
    if (!area) return;
    area.innerHTML = '';
    if (!msgs.length) {
        area.innerHTML = '<div class="empty-state"><i class="far fa-comments"></i><p>Нет сообщений</p></div>';
        return;
    }

    const chatMeta = allChats[currentChat];
    const isChannel = !!(chatMeta && chatMeta.type === 'channel');
    const groupChat = isChannel || currentChat === GENERAL_CHAT_ID || (chatMeta && chatMeta.type === 'group');
    const prevIds = renderedMsgIds[cid] || new Set();
    let lastDate = null;
    msgs.forEach((msg, idx) => {
        const dt = msgDateOf(msg);
        const ds = dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        if (ds !== lastDate) {
            const dv = document.createElement('div');
            dv.className = 'date-divider';
            dv.textContent = ds;
            area.appendChild(dv);
            lastDate = ds;
        }
        const nextMsg = msgs[idx + 1];
        const showAvatar = !nextMsg || (isChannel ? false : nextMsg.userId !== msg.userId);
        appendMsg(msg, dt, area, cid, groupChat, showAvatar, isChannel, !prevIds.has(msg.id));
    });
    renderedMsgIds[cid] = new Set(msgs.map(m => m.id));
    area.scrollTop = 999999;

    const id = isGroupLike(currentChat) ? currentChat : otherDmUid(cid);
    if (id && msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        lastMessagePreviews[id] = last.imageUrl ? '<i class="fas fa-image"></i> Фото' : (last.text || '').substring(0, 30);
        const ts = last.timestamp?.toDate();
        if (ts) lastMessageTimes[id] = ts.getTime();
        renderChatList();
    }

    // The chat is open and its messages just rendered — mark anything
    // unread from the other side as read right away, not only once when
    // the chat was first opened.
    markRead(cid);
}

// ==================== BACKGROUND MESSAGE LISTENER (unread / preview / sound) ====================
// Two dedicated, properly-scoped listeners instead of one global listener
// over the entire "messages" collection:
//   - "participants array-contains me" covers DMs and groups/channels I'm
//     actually part of, so a stranger's unrelated conversation can never
//     leak into my unread counters or play a notification sound for me.
//   - the general chat gets its own listener since, by design, everyone
//     can see it regardless of membership.
// Both are torn down and re-created on every login/account switch so old
// sessions can't keep running in the background and firing stale updates.
function listenForMessages() {
    if (unsubscribeMyMessages) unsubscribeMyMessages();
    if (unsubscribeGeneralMessages) unsubscribeGeneralMessages();

    // No orderBy on purpose: combined with the filter below it would need
    // a composite Firestore index this project doesn't have provisioned,
    // and the query would fail silently forever (this is what was quietly
    // breaking live preview updates and the unread counter). Order
    // doesn't matter here anyway — each newly-added doc is handled on its
    // own regardless of what order they arrive in.
    let firstMine = true;
    unsubscribeMyMessages = db.collection('messages')
        .where('participants', 'array-contains', currentUser.uid)
        .onSnapshot(snap => {
            if (firstMine) { firstMine = false; return; }
            handleIncomingChanges(snap.docChanges());
        }, (err) => { console.error('listenForMessages (mine) error:', err); });

    let firstGeneral = true;
    unsubscribeGeneralMessages = db.collection('messages')
        .where('chatId', '==', GENERAL_CHAT_ID)
        .onSnapshot(snap => {
            if (firstGeneral) { firstGeneral = false; return; }
            handleIncomingChanges(snap.docChanges());
        }, (err) => { console.error('listenForMessages (general) error:', err); });
}

function handleIncomingChanges(changes) {
    let needsUpdate = false;
    changes.forEach(change => {
        if (change.type !== 'added') return;
        const msg = change.doc.data();
        // Skip our own messages (prevents the unread counter / sound from
        // ever firing for something we just sent ourselves) and skip
        // pending writes that haven't been timestamped by the server yet.
        if (msg.userId === currentUser.uid || !msg.timestamp) return;

        const cid = msg.chatId;
        if (!cid) return;

        let id;
        if (isGroupLike(cid)) {
            id = cid;
        } else {
            id = otherDmUid(cid);
            if (!id || !allUsers[id]) return;
            if (!activeChats.has(id)) {
                activeChats.add(id);
                needsUpdate = true;
            }
        }

        // Keep the preview/time fresh even for chats we're not currently
        // viewing — this is what makes a preview actually show up without
        // having opened the chat first.
        lastMessagePreviews[id] = msg.imageUrl ? '<i class="fas fa-image"></i> Фото' : (msg.text || '').substring(0, 30);
        lastMessageTimes[id] = toMillis(msg.timestamp);
        needsUpdate = true;

        const curCid = currentChat ? chatIdFor(currentChat) : '';
        if (cid !== curCid) {
            unreadCounts[id] = (unreadCounts[id] || 0) + 1;
            playSound();
        }
    });
    if (needsUpdate) renderChatList();
}

// ==================== APPEND MSG ====================
function appendMsg(m, dt, area, cid, groupChat, showAvatar, isChannel, isNew) {
    area.appendChild(buildMsgWrapper(m, dt, cid, groupChat, showAvatar, isChannel, isNew));
}

function buildMsgWrapper(m, dt, cid, groupChat, showAvatar, isChannel, isNew) {
    // Channel posts are authored "by the channel", not by whichever admin
    // hit send — so even the admin who posted it sees it as an incoming
    // message from the channel, exactly like every other subscriber does.
    const isMine = isChannel ? false : (m.userId === currentUser.uid);
    const wrapper = document.createElement('div');
    // The whole chat gets fully re-rendered on every snapshot (simplest way
    // to stay in sync), so the appear animation must be opt-in per bubble —
    // otherwise every message would replay it on every unrelated new
    // message. isNew is only true for ids that weren't in the previous
    // render pass (see renderedMsgIds in renderMessagesSnapshot).
    wrapper.className = 'msg-wrap ' + (isMine ? 'sent' : 'received') + (isNew ? ' msg-appear' : '');
    wrapper.id = 'msg-' + m.id;
    wrapper.style.position = 'relative';

    if (selectionMode && isMine) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedMessages.has(m.id);
        cb.style.cssText = 'margin-right:6px;width:18px;height:18px;cursor:pointer;';
        cb.onchange = function () {
            if (cb.checked) selectedMessages.add(m.id);
            else selectedMessages.delete(m.id);
        };
        wrapper.appendChild(cb);
    }

    // Same trick as the send button: without this, tapping a message
    // blurs whatever's focused (the compose input) before the click even
    // fires, closing the keyboard just to react to something.
    wrapper.addEventListener('pointerdown', function (e) {
        if (!selectionMode) e.preventDefault();
    });
    // Double-tap = instant quick reaction (like Telegram), single tap
    // opens the menu — debounced so the first tap of a double-tap doesn't
    // also pop the menu open before the second tap lands.
    let lastTapAt = 0;
    let singleTapTimer = null;
    wrapper.addEventListener('click', function (e) {
        if (selectionMode) return;
        e.stopPropagation();
        const now = Date.now();
        if (now - lastTapAt < 300) {
            clearTimeout(singleTapTimer);
            lastTapAt = 0;
            quickReact(m, wrapper);
            return;
        }
        lastTapAt = now;
        singleTapTimer = setTimeout(() => {
            showMessageMenu(m, wrapper, cid, isMine, isChannel);
        }, 260);
    });

    // Swipe-to-reply: swipe toward the bubble's own side (right for a
    // received message on the left, left for a sent one on the right) —
    // same gesture Telegram/WhatsApp use, as an alternative to the menu.
    (function setupSwipeReply() {
        const allowedDir = isMine ? -1 : 1;
        const threshold = 58;
        const maxDrag = 72;
        let touchStartX = 0, touchStartY = 0, dragging = false, currentDx = 0, replyIcon = null;

        wrapper.addEventListener('touchstart', function (e) {
            if (selectionMode || e.touches.length !== 1) return;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            dragging = false;
        }, { passive: true });

        wrapper.addEventListener('touchmove', function (e) {
            if (selectionMode || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - touchStartX;
            const dy = e.touches[0].clientY - touchStartY;
            if (!dragging) {
                if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
                if ((allowedDir === 1 && dx <= 0) || (allowedDir === -1 && dx >= 0)) return;
                dragging = true;
                clearTimeout(singleTapTimer);
                const bub = wrapper.querySelector('.msg-bub');
                if (bub) {
                    replyIcon = document.createElement('div');
                    replyIcon.className = 'msg-swipe-reply-icon';
                    replyIcon.innerHTML = '<i class="fas fa-reply"></i>';
                    replyIcon.style.cssText = allowedDir === 1 ? 'left:-34px;' : 'right:-34px;';
                    bub.appendChild(replyIcon);
                }
            }
            if (!dragging) return;
            let clamped = allowedDir === 1 ? Math.min(dx, maxDrag) : Math.max(dx, -maxDrag);
            if ((allowedDir === 1 && clamped < 0) || (allowedDir === -1 && clamped > 0)) clamped = 0;
            currentDx = clamped;
            wrapper.style.transition = 'none';
            wrapper.style.transform = 'translateX(' + clamped + 'px)';
            if (replyIcon) replyIcon.style.opacity = String(Math.min(1, Math.abs(clamped) / threshold));
        }, { passive: true });

        wrapper.addEventListener('touchend', function () {
            if (!dragging) return;
            dragging = false;
            wrapper.style.transition = 'transform 0.22s cubic-bezier(0.34, 1.4, 0.64, 1)';
            wrapper.style.transform = 'translateX(0)';
            if (replyIcon) { const el = replyIcon; setTimeout(() => el.remove(), 220); replyIcon = null; }
            if (Math.abs(currentDx) >= threshold) {
                const senderName = isChannel ? ((allChats[cid] && allChats[cid].name) || 'Канал') : (isMine ? 'Вы' : (allUsers[m.userId]?.displayName || 'Пользователь'));
                setReply(m.id, m.text, senderName);
                if (navigator.vibrate) navigator.vibrate(12);
            }
            currentDx = 0;
        });
    })();

    // In group chats, show the sender's avatar next to received messages,
    // like Telegram. Consecutive messages from the same sender only show
    // the avatar on the last one, but a same-size invisible slot is kept
    // for the earlier ones so every bubble still lines up. Channels are
    // deliberately excluded — a channel post shows only the message,
    // comments, reactions and view count, no channel identity on each post.
    const channelMeta = isChannel ? (allChats[cid] || {}) : null; // still used further down for the comments pill / view count
    if (groupChat && !isMine && !isChannel) {
        const senderName = allUsers[m.userId] ? allUsers[m.userId].displayName : '';
        const senderAvatar = allUsers[m.userId] && allUsers[m.userId].avatarUrl;
        const avatarEl = document.createElement('div');
        avatarEl.className = 'msg-avatar' + (showAvatar ? '' : ' msg-avatar-hidden');
        if (showAvatar) {
            avatarEl.innerHTML = senderAvatar ? '<img src="' + senderAvatar + '">' : initials(senderName);
            avatarEl.style.cursor = 'pointer';
            avatarEl.onclick = function (e) {
                e.stopPropagation();
                viewUserProfile(m.userId);
            };
        }
        wrapper.appendChild(avatarEl);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bub';

    if (currentPinnedIds.has(m.id)) {
        const pinBadge = document.createElement('div');
        pinBadge.className = 'msg-pin-badge';
        pinBadge.innerHTML = '<i class="fas fa-thumbtack"></i>';
        bubble.appendChild(pinBadge);
    }

    // In group chats, label who sent each received message (skipped for
    // DMs where it would be redundant, and for channels which show no
    // identity on posts at all).
    if (groupChat && !isMine && !isChannel) {
        const label = document.createElement('div');
        label.className = 'sender-name-label';
        label.textContent = allUsers[m.userId] ? (allUsers[m.userId].displayName || 'Пользователь') : 'Пользователь';
        bubble.appendChild(label);
    }

    if (m.forwardFrom) {
        const fwdBlock = document.createElement('div');
        fwdBlock.className = 'msg-forward-label';
        fwdBlock.innerHTML = '<i class="fas fa-share"></i> ';
        const fwdName = document.createElement('span');
        fwdName.textContent = 'Переслано от ' + (m.forwardFrom.name || 'Пользователь');
        fwdBlock.appendChild(fwdName);
        bubble.appendChild(fwdBlock);
    }

    if (m.storyReply) {
        const srBlock = document.createElement('div');
        srBlock.className = 'msg-story-reply-block';
        if (m.storyReply.imageUrl) {
            const thumb = document.createElement('img');
            thumb.className = 'msg-story-reply-thumb';
            thumb.src = m.storyReply.imageUrl;
            srBlock.appendChild(thumb);
        }
        const srText = document.createElement('div');
        srText.className = 'msg-story-reply-text';
        srText.textContent = 'Ответ на историю';
        srBlock.appendChild(srText);
        bubble.appendChild(srBlock);
    }

    if (m.replyTo) {
        const replyBlock = document.createElement('div');
        replyBlock.className = 'msg-reply-block';
        const replyName = document.createElement('div');
        replyName.className = 'msg-reply-name';
        const replyText = document.createElement('div');
        replyText.className = 'msg-reply-text';

        const repliedMsg = messageCache[cid] ? messageCache[cid].find(x => x.id === m.replyTo) : null;
        if (repliedMsg) {
            const repliedUser = allUsers[repliedMsg.userId];
            replyName.textContent = repliedUser ? repliedUser.displayName : 'Пользователь';
            replyText.textContent = repliedMsg.text || 'Фото';
        } else {
            replyName.textContent = 'Сообщение';
            replyText.textContent = 'недоступно';
        }

        replyBlock.onclick = function (e) {
            e.stopPropagation();
            const el = document.getElementById('msg-' + m.replyTo);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        replyBlock.appendChild(replyName);
        replyBlock.appendChild(replyText);
        bubble.appendChild(replyBlock);
    }

    if (m.imageUrl) {
        bubble.style.padding = '0';
        bubble.style.background = 'none';
        bubble.style.border = 'none';
        bubble.style.backdropFilter = 'none';
        const img = document.createElement('img');
        img.src = m.imageUrl;
        img.className = 'msg-img';
        img.onclick = function (e) {
            e.stopPropagation();
            const chatImgs = (messageCache[cid] || []).filter(x => x.imageUrl);
            const idx = chatImgs.findIndex(x => x.id === m.id);
            viewFull(m.imageUrl, chatImgs.map(x => x.imageUrl), idx);
        };
        bubble.appendChild(img);
    }

    const showReadTicks = isMine && !groupChat;

    // Time + read ticks (DMs) or view count (channel posts) — shared by
    // both the text and the no-text/image-only bubble layouts below.
    function buildTimeSpan() {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'msg-time';
        timeSpan.style.flexShrink = '0';
        timeSpan.style.textAlign = 'right';
        if (isChannel) {
            const views = document.createElement('span');
            views.className = 'msg-views';
            views.innerHTML = '<i class="fas fa-eye"></i> ' + (m.viewedBy || []).length;
            timeSpan.appendChild(views);
        }
        const timeText = document.createElement('span');
        timeText.textContent = dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        timeSpan.appendChild(timeText);

        if (showReadTicks) {
            const isRead = m.readBy && m.readBy.length > 0;
            const check = document.createElement('span');
            check.className = 'msg-ticks' + (isRead ? ' read' : '');
            check.innerHTML = isRead ? TICK_DOUBLE_SVG : TICK_SINGLE_SVG;
            timeSpan.appendChild(check);
        } else if (isMine && !isChannel) {
            const check = document.createElement('span');
            check.className = 'msg-ticks';
            check.innerHTML = TICK_SINGLE_SVG;
            timeSpan.appendChild(check);
        }
        return timeSpan;
    }

    if (m.text) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'flex-end';
        row.style.gap = '8px';
        row.style.justifyContent = 'space-between';

        const txt = document.createElement('span');
        txt.appendChild(renderTextWithMentions(m.text));
        txt.style.flex = '1';
        txt.style.minWidth = '0';
        txt.style.whiteSpace = 'pre-wrap';
        row.appendChild(txt);

        const timeSpan = buildTimeSpan();
        timeSpan.style.minWidth = '35px';
        row.appendChild(timeSpan);
        bubble.appendChild(row);
    } else {
        const timeRow = document.createElement('div');
        timeRow.style.textAlign = 'right';
        timeRow.appendChild(buildTimeSpan());
        bubble.appendChild(timeRow);
    }

    if (m.reactions && Object.keys(m.reactions).length > 0) {
        const reactionRow = document.createElement('div');
        reactionRow.style.cssText = 'display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;max-width:180px;';
        for (const [emoji, users] of Object.entries(m.reactions)) {
            if (!users || !users.length) continue;
            const chip = document.createElement('span');
            chip.className = 'msg-reaction-chip' + (users.includes(currentUser.uid) ? ' mine' : '');
            chip.textContent = emoji + ' ' + users.length;
            chip.onclick = function (e) { e.stopPropagation(); toggleReaction(m, emoji); };
            reactionRow.appendChild(chip);
        }
        bubble.appendChild(reactionRow);
    }

    // The bubble (and, for channels, the comments pill below it) live in
    // their own column so they stack vertically. Without this they were
    // direct children of .msg-wrap, which is a *row* flex container (it
    // also holds the avatar) — that squeezed the bubble down to almost
    // nothing to make room for the pill next to it, which combined with
    // word-break:break-word wrapped the message one character per line.
    const bubbleCol = document.createElement('div');
    bubbleCol.className = 'msg-bubble-col';
    bubbleCol.appendChild(bubble);

    if (isChannel) {
        const count = m.commentCount || 0;
        const commentsPill = document.createElement('div');
        commentsPill.className = 'msg-comments-pill';
        commentsPill.innerHTML = '<i class="far fa-comment"></i> ' + (count > 0 ? count : 'Комментировать');
        commentsPill.onclick = function (e) {
            e.stopPropagation();
            openPostComments(m, cid);
        };
        bubbleCol.appendChild(commentsPill);
    }

    wrapper.appendChild(bubbleCol);

    return wrapper;
}

// ==================== MESSAGE MENU ====================
// A much bigger reaction set than before ("оч много реакций"), grouped
// roughly by theme. The picker only shows the first row by default and
// expands/collapses the rest — see .mcm-reactions / .expanded in CSS.
const ALL_REACTIONS = [
    '👍', '👎', '❤️', '🔥', '🥰', '😍', '😂', '🤣',
    '😊', '🙂', '😉', '😅', '😭', '😢', '😡', '🤬',
    '😱', '😮', '😯', '🤔', '🧐', '😴', '🤤', '😜',
    '😎', '🥳', '🎉', '🎊', '👏', '🙏', '🤝', '💪',
    '✌️', '🤞', '🤟', '👌', '💯', '💔', '💕', '💞',
    '🥺', '🤯', '😳', '🙄', '😏', '😒', '🤡', '💀',
    '👀', '🍾', '🌚', '🎯', '⚡', '✨', '💩', '🤮'
];

function showMessageMenu(msg, wrapper, cid, isMine, isChannel) {
    document.querySelectorAll('.msg-context-menu').forEach(m => m.remove());

    const canDelete = isMine || (allChats[currentChat] && (allChats[currentChat].admins || []).includes(currentUser.uid));
    const canPin = canPinIn(currentChat);
    const isPinned = currentPinnedIds.has(msg.id);

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu';
    menu.addEventListener('pointerdown', e => e.preventDefault());

    const rect = wrapper.getBoundingClientRect();
    if (rect.top < 320) {
        menu.style.top = '100%';
        menu.style.bottom = 'auto';
        menu.style.marginTop = '5px';
    } else {
        menu.style.bottom = '100%';
        menu.style.top = 'auto';
        menu.style.marginBottom = '5px';
    }
    if (isMine) {
        menu.style.right = '0';
        menu.style.left = 'auto';
    } else {
        menu.style.left = '0';
        menu.style.right = 'auto';
    }

    // --- Reactions: one row visible, "..." expands the rest ---
    const reactionsWrap = document.createElement('div');
    reactionsWrap.className = 'mcm-reactions-wrap';

    const reactionsGrid = document.createElement('div');
    reactionsGrid.className = 'mcm-reactions';
    ALL_REACTIONS.forEach(emoji => {
        const emojiBtn = document.createElement('span');
        emojiBtn.className = 'reaction-emoji-btn';
        emojiBtn.textContent = emoji;
        emojiBtn.onclick = function (e) {
            e.stopPropagation();
            toggleReaction(msg, emoji);
            menu.remove();
        };
        reactionsGrid.appendChild(emojiBtn);
    });
    reactionsWrap.appendChild(reactionsGrid);

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'mcm-reaction-toggle';
    toggleBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
    toggleBtn.onclick = function (e) {
        e.stopPropagation();
        const expanded = reactionsGrid.classList.toggle('expanded');
        toggleBtn.innerHTML = expanded ? '<i class="fas fa-chevron-up"></i>' : '<i class="fas fa-chevron-down"></i>';
    };
    reactionsWrap.appendChild(toggleBtn);
    menu.appendChild(reactionsWrap);

    // --- Actions: compact icon-only row ---
    const actions = document.createElement('div');
    actions.className = 'mcm-actions';

    const makeActionBtn = (icon, label, onClick, danger) => {
        const btn = document.createElement('button');
        btn.className = 'mcm-action-btn' + (danger ? ' danger' : '');
        btn.title = label;
        btn.innerHTML = '<i class="fas ' + icon + '"></i><span>' + label + '</span>';
        btn.onclick = function (e) {
            e.stopPropagation();
            onClick();
            menu.remove();
        };
        return btn;
    };

    actions.appendChild(makeActionBtn('fa-reply', 'Ответить', () => {
        const senderName = isChannel ? ((allChats[cid] && allChats[cid].name) || 'Канал') : (isMine ? 'Вы' : (allUsers[msg.userId]?.displayName || 'Пользователь'));
        setReply(msg.id, msg.text, senderName);
    }));

    actions.appendChild(makeActionBtn('fa-share', 'Переслать', () => {
        openForwardPicker(msg, isChannel ? ((allChats[cid] && allChats[cid].name) || 'Канал') : (allUsers[msg.userId] ? allUsers[msg.userId].displayName : 'Пользователь'));
    }));

    if (canPin) {
        actions.appendChild(makeActionBtn('fa-thumbtack', isPinned ? 'Открепить' : 'Закрепить', () => {
            togglePinMessage(msg, cid);
        }));
    }

    if (canDelete) {
        actions.appendChild(makeActionBtn('fa-trash', 'Удалить', () => {
            showCustomConfirm('Удалить сообщение?', async function () {
                await db.collection('messages').doc(msg.id).delete();
                if (currentPinnedIds.has(msg.id)) {
                    db.collection('chatMeta').doc(cid).set({ pinnedMessages: firebase.firestore.FieldValue.arrayRemove(msg.id) }, { merge: true }).catch(() => {});
                }
                const idx = messageCache[cid]?.findIndex(x => x.id === msg.id);
                if (idx > -1) messageCache[cid].splice(idx, 1);
                wrapper.style.opacity = '0';
                wrapper.style.transform = 'scale(0.8)';
                wrapper.style.transition = '0.2s';
                setTimeout(() => wrapper.remove(), 200);
            });
        }, true));
    }

    menu.appendChild(actions);

    wrapper.appendChild(menu);

    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target) && e.target !== wrapper) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 100);
}

// ==================== TOGGLE REACTION ====================
async function toggleReaction(msg, emoji) {
    if (!currentUser) return;
    const reactions = msg.reactions || {};
    if (!reactions[emoji]) reactions[emoji] = [];

    const userIndex = reactions[emoji].indexOf(currentUser.uid);
    if (userIndex > -1) {
        reactions[emoji].splice(userIndex, 1);
        if (reactions[emoji].length === 0) delete reactions[emoji];
    } else {
        reactions[emoji].push(currentUser.uid);
    }

    const cid = chatIdFor(currentChat);
    if (messageCache[cid]) {
        const msgInCache = messageCache[cid].find(m => m.id === msg.id);
        if (msgInCache) msgInCache.reactions = reactions;
        patchSingleMessage(cid, msg.id);
    }

    try {
        await db.collection('messages').doc(msg.id).update({ reactions: reactions });
    } catch (e) {
        console.error('Reaction error:', e);
    }
}

// Double-tap quick reaction: toggles whichever emoji the person picked
// in Settings (👍 by default), with a brief floating pop for feedback.
function quickReact(msg, wrapper) {
    toggleReaction(msg, quickReactionEmoji);

    const anchor = wrapper.querySelector('.msg-bub') || wrapper;
    const prevPosition = anchor.style.position;
    if (!prevPosition) anchor.style.position = 'relative';
    const burst = document.createElement('div');
    burst.className = 'quick-react-burst';
    burst.textContent = quickReactionEmoji;
    anchor.appendChild(burst);
    setTimeout(() => burst.remove(), 700);
}

// ==================== REPLY ====================
function setReply(msgId, text, sender) {
    replyTo = msgId;
    $('#replyBar').classList.remove('hidden');
    $('#replyPreview').textContent = sender + ': ' + (text || 'Фото').substring(0, 50);
    $('#msgInput').focus();
}

function cancelReply() {
    replyTo = null;
    $('#replyBar').classList.add('hidden');
}

// ==================== SEND MESSAGE ====================
async function sendMsg() {
    if (!currentUser || !currentChat || selectionMode) return;

    const meta = allChats[currentChat];
    if (meta && meta.type === 'channel' && !(meta.admins || []).includes(currentUser.uid)) return;

    const input = $('#msgInput');
    const text = input.value.trim();
    const file = $('#fileInput')?.files[0];
    if (!text && !file) return;

    const sendBtn = $('#sendBtn');
    if (sendBtn) sendBtn.disabled = true;
    shouldScrollDown = true;

    const cid = chatIdFor(currentChat);
    let participants;
    if (currentChat === GENERAL_CHAT_ID) {
        participants = null;
    } else if (isGroupLike(currentChat)) {
        const members = (allChats[currentChat] && allChats[currentChat].members) || [];
        const admins = (allChats[currentChat] && allChats[currentChat].admins) || [];
        participants = [...new Set([...members, ...admins])];
    } else {
        participants = [currentUser.uid, currentChat];
    }

    try {
        let imageUrl = '';
        let fileName = '';
        let fileType = '';
        if (file) {
            const compressed = await compressFile(file);
            imageUrl = compressed.dataUrl;
            fileName = file.name;
            fileType = compressed.type;
            $('#fileInput').value = '';
        }

        const payload = {
            text: text,
            imageUrl: imageUrl,
            fileName: fileName,
            fileType: fileType,
            fileUrl: imageUrl,
            userId: currentUser.uid,
            chatId: cid,
            readBy: [],
            replyTo: replyTo || null,
            reactions: {},
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (participants) payload.participants = participants;

        await db.collection('messages').add(payload);

        if (sendBtn) {
            sendBtn.classList.remove('sent-pulse');
            // Force a reflow so re-adding the class restarts the animation
            // even if the previous pulse hadn't finished yet.
            void sendBtn.offsetWidth;
            sendBtn.classList.add('sent-pulse');
            setTimeout(() => sendBtn.classList.remove('sent-pulse'), 400);
        }

        // We just sent a message — stop announcing "typing..." right away.
        clearTyping(cid);

        if (!isGroupLike(currentChat) && !activeChats.has(currentChat)) {
            activeChats.add(currentChat);
            await loadChatPreview(currentChat, cid);
        }
        cancelReply();
        if (input) {
            input.value = '';
            input.style.height = 'auto';
            // Deliberately NOT calling blur()/focus() here: the send button
            // uses pointerdown+preventDefault (see setupListeners) so the
            // textarea never actually loses focus when it's tapped, and the
            // on-screen keyboard stays open the whole time instead of
            // closing and immediately reopening.
        }
    } catch (e) {
        console.error('Send error:', e);
        showSendErrorModal(e);
    } finally {
        const sendBtn2 = $('#sendBtn');
        if (sendBtn2) sendBtn2.disabled = false;
    }
}

// Turns a raw Firestore error into a message people can actually act on —
// the two real failure modes here are the free-tier daily quota being
// exhausted, and a single message (usually a photo, since images are
// stored inline as base64) going over Firestore's ~1MB per-document limit.
function showSendErrorModal(e) {
    const code = e && e.code;
    const msg = (e && e.message) || '';
    let text;
    if (code === 'resource-exhausted') {
        text = 'Достигнут дневной лимит бесплатного тарифа Firebase на этот проект. Отправка сообщений вернётся, когда лимит сбросится (обычно в течение суток) — прямо сейчас ничего не откроется и не очистится вручную.';
    } else if (code === 'invalid-argument' || /longer than|exceeds the maximum|1048487/i.test(msg)) {
        text = 'Это сообщение слишком большое для отправки (обычно из-за фото). Попробуйте фото поменьше или более короткий текст.';
    } else if (code === 'permission-denied') {
        text = 'Нет прав на отправку сообщения в этот чат.';
    } else {
        text = 'Не удалось отправить сообщение. Проверьте соединение и попробуйте ещё раз.';
    }
    showCustomAlert(text);
}

// ==================== FORWARD ====================
// Same participants shape sendMsg computes for the currently-open chat,
// generalized to any target chat id so forwarding can send into a chat
// that isn't the one currently open.
function computeParticipants(targetId) {
    if (targetId === GENERAL_CHAT_ID) return null;
    if (isGroupLike(targetId)) {
        const meta = allChats[targetId] || {};
        const members = meta.members || [];
        const admins = meta.admins || [];
        return [...new Set([...members, ...admins])];
    }
    return [currentUser.uid, targetId];
}

// ==================== THEME PICKER ====================
// ==================== QUICK REACTION PICKER ====================
function openQuickReactionPicker() {
    const emojis = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];

    const overlay = document.createElement('div');
    overlay.className = 'action-sheet-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'action-sheet';

    const title = document.createElement('div');
    title.className = 'story-viewers-title';
    title.textContent = 'Быстрая реакция';
    sheet.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'text-align:center;color:var(--text-secondary);font-size:12.5px;padding:0 16px 10px;';
    hint.textContent = 'Ставится двойным тапом по сообщению';
    sheet.appendChild(hint);

    const row = document.createElement('div');
    row.className = 'theme-swatch-row';
    emojis.forEach(emoji => {
        const sw = document.createElement('div');
        sw.className = 'theme-swatch quick-reaction-swatch' + (quickReactionEmoji === emoji ? ' active' : '');
        sw.textContent = emoji;
        sw.onclick = () => {
            quickReactionEmoji = emoji;
            localStorage.setItem('quark_quick_reaction', emoji);
            const qrv = $('#quickReactionValue');
            if (qrv) qrv.textContent = emoji;
            overlay.remove();
        };
        row.appendChild(sw);
    });
    sheet.appendChild(row);

    overlay.appendChild(sheet);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
}

function openThemePicker() {
    const names = { purple: 'Фиолетовый', blue: 'Синий', green: 'Зелёный', pink: 'Розовый', orange: 'Оранжевый', teal: 'Бирюзовый', red: 'Красный' };

    const overlay = document.createElement('div');
    overlay.className = 'action-sheet-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'action-sheet';

    const title = document.createElement('div');
    title.className = 'story-viewers-title';
    title.textContent = 'Цвет темы';
    sheet.appendChild(title);

    const row = document.createElement('div');
    row.className = 'theme-swatch-row';
    ACCENT_THEMES.forEach(t => {
        const sw = document.createElement('div');
        sw.className = 'theme-swatch' + (accentTheme === t ? ' active' : '');
        sw.style.background = ACCENT_COLORS[t];
        sw.title = names[t];
        if (accentTheme === t) sw.innerHTML = '<i class="fas fa-check"></i>';
        sw.onclick = () => {
            accentTheme = t;
            localStorage.setItem('quark_accent', t);
            applyTheme();
            const av = $('#accentValue');
            if (av) av.textContent = names[t];
            overlay.remove();
        };
        row.appendChild(sw);
    });
    sheet.appendChild(row);

    overlay.appendChild(sheet);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
}

// ==================== CHAT WALLPAPER ====================
function openWallpaperPicker() {
    showActionSheet([
        {
            label: 'Выбрать из галереи',
            icon: 'fa-image',
            onClick: () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.onchange = async () => {
                    const file = input.files[0];
                    if (!file) return;
                    try {
                        const dataUrl = await compressWallpaper(file);
                        chatWallpaper = dataUrl;
                        localStorage.setItem('quark_wallpaper', dataUrl);
                        applyWallpaper();
                        const wv = $('#wallpaperValue');
                        if (wv) wv.textContent = 'Своё изображение';
                    } catch (e) {
                        showCustomAlert('Не удалось установить обои');
                    }
                };
                input.click();
            }
        },
        {
            label: 'Сбросить обои',
            icon: 'fa-undo',
            danger: true,
            onClick: () => {
                chatWallpaper = null;
                localStorage.removeItem('quark_wallpaper');
                applyWallpaper();
                const wv = $('#wallpaperValue');
                if (wv) wv.textContent = 'По умолчанию';
            }
        }
    ]);
}

// Bottom sheet listing every chat you can forward into: your DMs, your
// groups, channels you admin, and the general chat.
function openForwardPicker(msg, originName) {
    const ids = new Set([...activeChats, ...myChatIds, GENERAL_CHAT_ID]);
    const targets = [];
    ids.forEach(id => {
        const isGroup = isGroupLike(id);
        const meta = id === GENERAL_CHAT_ID ? { name: 'Общий чат' } : (isGroup ? allChats[id] : allUsers[id]);
        if (!meta) return;
        if (isGroup && id !== GENERAL_CHAT_ID && meta.type === 'channel' && !(meta.admins || []).includes(currentUser.uid)) return;
        targets.push({ id, isGroup, meta });
    });

    const overlay = document.createElement('div');
    overlay.className = 'action-sheet-overlay';
    overlay.style.zIndex = '410';
    const sheet = document.createElement('div');
    sheet.className = 'action-sheet story-viewers-sheet';

    const title = document.createElement('div');
    title.className = 'story-viewers-title';
    title.textContent = 'Переслать сообщение';
    sheet.appendChild(title);

    const list = document.createElement('div');
    list.className = 'tg-info-list';
    if (!targets.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:16px;text-align:center;color:var(--text-secondary);font-size:14px;';
        empty.textContent = 'Нет доступных чатов';
        list.appendChild(empty);
    }
    targets.forEach(t => {
        const name = t.isGroup ? (t.meta.name || 'Чат') : (t.meta.displayName || 'Пользователь');
        const row = document.createElement('div');
        row.className = 'member-row';
        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'avatar';
        avatarWrap.innerHTML = t.meta.avatarUrl ? '<img src="' + t.meta.avatarUrl + '">' : initials(name);
        const info = document.createElement('div');
        info.className = 'member-row-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'member-row-name';
        nameEl.textContent = name;
        info.appendChild(nameEl);
        row.appendChild(avatarWrap);
        row.appendChild(info);
        row.onclick = () => {
            forwardMessageTo(t.id, msg, originName);
            overlay.remove();
        };
        list.appendChild(row);
    });
    sheet.appendChild(list);

    overlay.appendChild(sheet);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
}

async function forwardMessageTo(targetId, msg, originName) {
    const cid = chatIdFor(targetId);
    const participants = computeParticipants(targetId);

    const payload = {
        text: msg.text || '',
        imageUrl: msg.imageUrl || '',
        fileName: msg.fileName || '',
        fileType: msg.fileType || '',
        fileUrl: msg.imageUrl || '',
        userId: currentUser.uid,
        chatId: cid,
        readBy: [],
        replyTo: null,
        reactions: {},
        forwardFrom: { name: originName || 'Пользователь' },
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (participants) payload.participants = participants;

    try {
        await db.collection('messages').add(payload);
        if (!isGroupLike(targetId) && !activeChats.has(targetId)) {
            activeChats.add(targetId);
            await loadChatPreview(targetId, cid);
        }
        renderChatList();
    } catch (e) {
        console.error('Forward error:', e);
        showSendErrorModal(e);
    }
}

function compressWallpaper(file) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width;
                let h = img.height;
                const max = 1080;
                if (w > h && w > max) {
                    h *= max / w;
                    w = max;
                } else if (h > max) {
                    w *= max / h;
                    h = max;
                }
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function compressFile(file) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width;
                let h = img.height;
                const max = 600;
                if (w > h && w > max) {
                    h *= max / w;
                    w = max;
                } else if (h > max) {
                    w *= max / h;
                    h = max;
                }
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.6), type: 'image/jpeg' });
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function viewFull(url, list, index) {
    list = (list && list.length) ? list : [url];
    index = typeof index === 'number' && index > -1 ? index : Math.max(0, list.indexOf(url));

    const viewer = document.createElement('div');
    viewer.className = 'full-viewer';
    viewer.innerHTML =
        '<div class="fv-top">' +
        '<span class="fv-close"><i class="fas fa-times"></i></span>' +
        '<span class="fv-counter">' + (list.length > 1 ? (index + 1) + ' / ' + list.length : '') + '</span>' +
        '<a class="fv-download" download="photo.jpg"><i class="fas fa-download"></i></a>' +
        '</div>' +
        '<div class="fv-stage"><img class="fv-img" src="' + list[index] + '"></div>' +
        (list.length > 1 ? '<div class="fv-nav fv-prev"><i class="fas fa-chevron-left"></i></div><div class="fv-nav fv-next"><i class="fas fa-chevron-right"></i></div>' : '');
    document.body.appendChild(viewer);

    const img = viewer.querySelector('.fv-img');
    const stage = viewer.querySelector('.fv-stage');
    const counter = viewer.querySelector('.fv-counter');
    const download = viewer.querySelector('.fv-download');
    download.href = list[index];

    let scale = 1, tx = 0, ty = 0;
    let startDist = 0, startScale = 1;
    let dragging = false, dragStartX = 0, dragStartY = 0, dragOrigX = 0, dragOrigY = 0;
    let lastTap = 0;
    let touchStartX = 0, touchStartY = 0, singleTouchActive = false;

    const keyHandler = (e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft') goTo(index - 1);
        else if (e.key === 'ArrowRight') goTo(index + 1);
    };
    document.addEventListener('keydown', keyHandler);
    function close() {
        document.removeEventListener('keydown', keyHandler);
        viewer.remove();
    }

    function applyTransform() {
        img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }
    function resetZoom() { scale = 1; tx = 0; ty = 0; applyTransform(); }

    function goTo(newIndex) {
        if (newIndex < 0 || newIndex >= list.length || newIndex === index) return;
        index = newIndex;
        img.src = list[index];
        download.href = list[index];
        if (counter) counter.textContent = list.length > 1 ? (index + 1) + ' / ' + list.length : '';
        resetZoom();
    }

    viewer.querySelector('.fv-close').onclick = close;
    const prevBtn = viewer.querySelector('.fv-prev');
    const nextBtn = viewer.querySelector('.fv-next');
    if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); goTo(index - 1); };
    if (nextBtn) nextBtn.onclick = (e) => { e.stopPropagation(); goTo(index + 1); };

    // Pinch-to-zoom, drag-to-pan when zoomed in, swipe left/right between
    // photos and swipe down to close when at 1x — mirrors Telegram's photo
    // viewer gestures.
    stage.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            startDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            startScale = scale;
            singleTouchActive = false;
        } else if (e.touches.length === 1) {
            if (scale > 1.02) {
                dragging = true;
                dragStartX = e.touches[0].clientX;
                dragStartY = e.touches[0].clientY;
                dragOrigX = tx;
                dragOrigY = ty;
            } else {
                singleTouchActive = true;
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
            }
        }
    }, { passive: true });

    stage.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && startDist) {
            const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            scale = Math.min(4, Math.max(1, startScale * (dist / startDist)));
            applyTransform();
        } else if (dragging && e.touches.length === 1) {
            tx = dragOrigX + (e.touches[0].clientX - dragStartX);
            ty = dragOrigY + (e.touches[0].clientY - dragStartY);
            applyTransform();
        }
    }, { passive: true });

    stage.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0];
        if (singleTouchActive && t) {
            const dx = t.clientX - touchStartX;
            const dy = t.clientY - touchStartY;
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) {
                if (dx < 0) goTo(index + 1); else goTo(index - 1);
            } else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.4) {
                close();
                return;
            } else {
                const now = Date.now();
                if (now - lastTap < 300) {
                    if (scale > 1.02) resetZoom(); else { scale = 2.5; applyTransform(); }
                }
                lastTap = now;
            }
        }
        singleTouchActive = false;
        dragging = false;
        startDist = 0;
        if (scale < 1.02) resetZoom();
    });

    // Desktop: wheel to zoom, double-click to zoom, drag to pan when zoomed
    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        scale = Math.min(4, Math.max(1, scale - e.deltaY * 0.0025));
        if (scale < 1.02) resetZoom(); else applyTransform();
    }, { passive: false });

    stage.addEventListener('dblclick', () => {
        if (scale > 1.02) resetZoom(); else { scale = 2.5; applyTransform(); }
    });

    let mouseDown = false;
    stage.addEventListener('mousedown', (e) => {
        if (scale <= 1.02) return;
        mouseDown = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragOrigX = tx;
        dragOrigY = ty;
    });
    window.addEventListener('mousemove', (e) => {
        if (!mouseDown) return;
        tx = dragOrigX + (e.clientX - dragStartX);
        ty = dragOrigY + (e.clientY - dragStartY);
        applyTransform();
    });
    window.addEventListener('mouseup', () => { mouseDown = false; });

    viewer.onclick = (e) => {
        if (e.target === viewer || e.target === stage) close();
    };
}

// ==================== MARK AS READ ====================
// Fixed to no longer rely on a Firestore "!=" query (chatId == X AND
// userId != me), which needs a composite index that this project never
// had configured — the query silently failed and read receipts never
// actually got written. We now just filter the chat's already-loaded
// messages in memory, which needs no extra index at all.
async function markRead(cid) {
    if (!currentUser) return;
    const msgs = messageCache[cid];
    if (!msgs || !msgs.length) return;
    const meta = allChats[currentChat];
    const isChannel = !!(meta && meta.type === 'channel');
    // Channel posts always count views (it's a public engagement number,
    // like Telegram) — only DM/group read receipts respect the privacy
    // toggle.
    if (!isChannel && !readReceiptsEnabled) return;
    const field = isChannel ? 'viewedBy' : 'readBy';
    try {
        const batch = db.batch();
        let any = false;
        msgs.forEach(m => {
            if (!isChannel && m.userId === currentUser.uid) return;
            const arr = m[field] || [];
            if (!arr.includes(currentUser.uid)) {
                const next = [...arr, currentUser.uid];
                m[field] = next;
                batch.update(db.collection('messages').doc(m.id), { [field]: next });
                any = true;
            }
        });
        if (any) await batch.commit();
    } catch (e) {}
}

// ==================== STATUS ====================
function updateStatusDisplay() {
    if (!currentChat) return;
    const mt = $('#msgTyping');
    if (!mt) return;

    if (isGroupLike(currentChat)) {
        const meta = allChats[currentChat];
        if (currentChat === GENERAL_CHAT_ID) {
            mt.textContent = 'Чат открыт для всех пользователей';
        } else if (meta) {
            const count = (meta.members || []).length;
            const label = meta.type === 'channel' ? 'подписчиков' : 'участников';
            mt.textContent = count + ' ' + label;
        } else {
            mt.textContent = '';
        }
        mt.style.color = 'var(--text-secondary)';
        return;
    }

    const user = allUsers[currentChat];
    if (!user) return;

    if (!canShowLastSeen(user)) {
        mt.textContent = '';
        mt.style.color = 'var(--text-secondary)';
    } else if (isUserOnline(user)) {
        mt.textContent = 'В сети';
        mt.style.color = '#10B981';
    } else if (user.lastSeen) {
        mt.textContent = 'Был(а) ' + formatTime(toMillis(user.lastSeen));
        mt.style.color = 'var(--text-secondary)';
    } else {
        mt.textContent = '';
        mt.style.color = 'var(--text-secondary)';
    }
}

function watchUserStatus(uid) {
    if (unsubscribeUserStatus) {
        unsubscribeUserStatus();
        unsubscribeUserStatus = null;
    }
    unsubscribeUserStatus = db.collection('users').doc(uid).onSnapshot(doc => {
        if (!doc.exists) return;
        allUsers[uid] = { id: uid, ...doc.data() };
        if (currentChat === uid) updateStatusDisplay();
    });
}

function watchChatMeta(id) {
    if (unsubscribeChatMeta) {
        unsubscribeChatMeta();
        unsubscribeChatMeta = null;
    }
    unsubscribeChatMeta = db.collection('chats').doc(id).onSnapshot(doc => {
        if (!doc.exists) return;
        allChats[id] = { id, ...doc.data() };
        if (currentChat === id) {
            renderChatHeader(id);
            updateStatusDisplay();
            updateComposerAvailability(id);
        }
    });
}

// ==================== PINNED MESSAGES ====================
// Stored in a separate "chatMeta" collection keyed by the same chat id
// used for messages (cid) — this covers DMs (composite uid pair id),
// groups/channels, and the general chat uniformly, without needing a
// "chats" doc to already exist (DMs and "general" don't have one).
function watchPinned(cid) {
    if (unsubscribePinned) { unsubscribePinned(); unsubscribePinned = null; }
    currentPinnedIds = new Set();
    currentPinnedList = [];
    pinnedShownIndex = 0;
    renderPinnedBar();

    unsubscribePinned = db.collection('chatMeta').doc(cid).onSnapshot(doc => {
        const data = doc.exists ? doc.data() : null;
        const newList = (data && data.pinnedMessages) || [];
        const prevIds = currentPinnedIds;
        // Show the newest pin by default (like Telegram) — a freshly pinned
        // message jumps the bar to it; otherwise just keep the index valid.
        if (newList.length > currentPinnedList.length) {
            pinnedShownIndex = newList.length - 1;
        } else if (pinnedShownIndex >= newList.length) {
            pinnedShownIndex = Math.max(0, newList.length - 1);
        }
        currentPinnedList = newList;
        currentPinnedIds = new Set(currentPinnedList);
        renderPinnedBar();
        // Only the bubbles whose pinned status actually flipped need their
        // pin badge repainted — patching the whole chat here was flickering
        // every bubble on every pin/unpin.
        if (chatIdFor(currentChat) === cid) {
            const changed = new Set([...prevIds, ...currentPinnedIds].filter(id => prevIds.has(id) !== currentPinnedIds.has(id)));
            changed.forEach(id => patchSingleMessage(cid, id));
        }
    }, () => {});
}

function renderPinnedBar() {
    const bar = $('#pinnedBar');
    const text = $('#pinnedBarText');
    if (!bar || !text) return;

    if (!currentPinnedList.length) {
        bar.classList.add('hidden');
        return;
    }

    const cid = chatIdFor(currentChat);
    const msgId = currentPinnedList[pinnedShownIndex];
    const msg = (messageCache[cid] || []).find(x => x.id === msgId);
    text.textContent = msg ? (msg.imageUrl ? 'Фото' : (msg.text || 'Сообщение')).substring(0, 60) : 'Закреплённое сообщение';
    bar.classList.remove('hidden');

    bar.onclick = function (e) {
        if (e.target.closest('#pinnedBarClose')) return;
        const el = document.getElementById('msg-' + msgId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        pinnedShownIndex = (pinnedShownIndex + 1) % currentPinnedList.length;
        renderPinnedBar();
    };
}

function canPinIn(id) {
    if (!isGroupLike(id)) return true; // DMs: either side can pin, like Telegram
    if (id === GENERAL_CHAT_ID) return true; // no admin concept for the general chat
    const meta = allChats[id];
    return !!(meta && (meta.admins || []).includes(currentUser.uid));
}

async function togglePinMessage(msg, cid) {
    const ref = db.collection('chatMeta').doc(cid);
    try {
        if (currentPinnedIds.has(msg.id)) {
            await ref.set({ pinnedMessages: firebase.firestore.FieldValue.arrayRemove(msg.id) }, { merge: true });
        } else {
            await ref.set({ pinnedMessages: firebase.firestore.FieldValue.arrayUnion(msg.id) }, { merge: true });
        }
    } catch (e) { console.error('Pin error:', e); }
}


function setTyping() {
    if (!currentUser || !currentChat || !currentProfile || isGroupLike(currentChat)) return;
    if (currentProfile.typingIndicatorEnabled === false) return;
    const cid = chatIdFor(currentChat);

    db.collection('typing').doc(cid).set({
        userId: currentUser.uid,
        displayName: currentProfile.displayName || '',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    if (typingTimers[cid]) clearTimeout(typingTimers[cid]);
    typingTimers[cid] = setTimeout(() => clearTyping(cid), TYPING_STOP_DELAY_MS);
}

function clearTyping(cid) {
    if (typingTimers[cid]) {
        clearTimeout(typingTimers[cid]);
        delete typingTimers[cid];
    }
    db.collection('typing').doc(cid).delete().catch(() => {});
}

function watchTyping(cid) {
    if (unsubscribeTyping) {
        unsubscribeTyping();
        unsubscribeTyping = null;
    }
    unsubscribeTyping = db.collection('typing').doc(cid).onSnapshot(doc => {
        const activeCid = currentChat && !isGroupLike(currentChat) ? chatIdFor(currentChat) : null;
        if (cid !== activeCid || selectionMode) return;

        const mt = $('#msgTyping');
        if (!mt) return;

        if (doc.exists && doc.data().userId !== currentUser.uid) {
            const data = doc.data();
            const elapsed = Date.now() - toMillis(data.timestamp);
            if (data.timestamp && elapsed < TYPING_TTL_MS) {
                mt.textContent = (data.displayName || 'Пользователь') + ' печатает...';
                mt.style.color = '#10B981';
                return;
            }
        }
        updateStatusDisplay();
    });
}

// ==================== PUSH INIT ====================
function initPush() {
    if (!('Notification' in window)) return;
    Notification.requestPermission().then(permission => {
        if (permission !== 'granted') return;
        navigator.serviceWorker.register('/firebase-messaging-sw.js').then(registration => {
            const messaging = firebase.messaging();
            messaging.getToken({
                vapidKey: 'BI-4PaT9XQVG0CXAoNatPPWTdw_jNUVpSajOixlM9bmEQugbMB6-lIDBypIU_kXbUpBGTrE6Zs91P88R51FXoSU',
                serviceWorkerRegistration: registration
            }).then(token => {
                if (token) db.collection('users').doc(currentUser.uid).update({ fcmToken: token });
            }).catch(() => {});
        });
    });
}

// ==================== SELECT & DELETE ====================
function toggleSelect() {
    selectionMode = !selectionMode;
    selectedMessages.clear();

    if (selectionMode) {
        $('#backBtn').style.display = 'none';
        $('#cancelSelectBtn').style.display = 'flex';
        $('#deleteSelectedBtn').style.display = 'flex';
        $('#msgName').style.display = 'none';
        $('#msgTyping').textContent = 'Выберите сообщения';
    } else {
        $('#backBtn').style.display = 'flex';
        $('#cancelSelectBtn').style.display = 'none';
        $('#deleteSelectedBtn').style.display = 'none';
        $('#msgName').style.display = 'block';
        updateStatusDisplay();
    }

    if (currentChat) {
        const cid = chatIdFor(currentChat);
        if (messageCache[cid]) renderFromCache(cid);
    }
}

async function deleteSelected() {
    if (!selectedMessages.size) return;
    showCustomConfirm('Удалить ' + selectedMessages.size + ' сообщений?', async function () {
        const cid = chatIdFor(currentChat);
        const batch = db.batch();
        selectedMessages.forEach(id => {
            batch.delete(db.collection('messages').doc(id));
            const idx = messageCache[cid]?.findIndex(x => x.id === id);
            if (idx > -1) messageCache[cid].splice(idx, 1);
        });
        await batch.commit();
        selectedMessages.clear();
        toggleSelect();
        if (messageCache[cid]) renderFromCache(cid);
    });
}

// ==================== USER PROFILE MODAL ====================
let profileReturnScreen = 'screenMessages';

function viewUserProfile(uid, returnScreen) {
    if (uid === currentUser.uid) {
        showScreen('screenProfile');
        return;
    }
    const user = allUsers[uid];
    if (!user) return;

    profileReturnScreen = returnScreen || 'screenMessages';
    $('#vpBackBtn').onclick = () => showScreen(profileReturnScreen);

    const body = $('#viewProfileBody');
    if (!body) return;

    function statusText() {
        if (!canShowLastSeen(user)) return '';
        if (isUserOnline(user)) return 'в сети';
        if (user.lastSeen) return 'был(а) ' + formatTime(toMillis(user.lastSeen)).toLowerCase();
        return '';
    }

    body.innerHTML =
        '<div class="tg-cover' + (user.coverUrl ? ' has-photo' : '') + '"' + (user.coverUrl ? ' style="background-image:url(\'' + user.coverUrl + '\')"' : '') + '>' +
        '<div class="avatar">' + (user.avatarUrl ? '<img src="' + user.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : initials(user.displayName)) + '</div>' +
        '<div class="tg-cover-info">' +
        '<div class="tg-cover-name">' + (user.displayName || 'Пользователь') + verifiedBadge(user.verified) + '</div>' +
        '<div class="tg-cover-sub" id="vpStatus">' + statusText() + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="tg-actions-row">' +
        '<div class="tg-action-btn" id="vpMsgBtn"><div class="circle"><i class="fas fa-comment"></i></div><span>Написать</span></div>' +
        '</div>' +
        '<div id="vpChannelSection"></div>' +
        '<div class="tg-info-list">' +
        (user.username ? '<div class="tg-info-row"><div class="tg-info-label">Username</div><div class="tg-info-value">@' + user.username + '</div></div>' : '') +
        (user.bio ? '<div class="tg-info-row"><div class="tg-info-label">О себе</div><div class="tg-info-value">' + user.bio + '</div></div>' : '') +
        '</div>' +
        mutualGroupsHtml(uid) +
        '<div id="vpMediaSection"></div>';

    body.querySelectorAll('.member-row[data-gid]').forEach(row => {
        row.onclick = () => openChat(row.dataset.gid);
    });

    $('#vpMsgBtn').onclick = () => {
        if (!activeChats.has(uid)) {
            activeChats.add(uid);
            loadChatPreview(uid, chatIdFor(uid));
        }
        openChat(uid);
    };

    renderFeaturedChannelCard(user, $('#vpChannelSection'));
    renderProfileMedia($('#vpMediaSection'), chatIdFor(uid));

    showScreen('screenViewProfile');
}

// Groups where both the profile owner and the current user are members —
// shown at the bottom of a person's profile, like Telegram's "Общие группы".
function mutualGroupsHtml(uid) {
    const groups = Object.values(allChats).filter(c =>
        c.type === 'group' &&
        (c.members || []).includes(currentUser.uid) &&
        (c.members || []).includes(uid)
    );
    if (!groups.length) return '';
    let html = '<div class="section-label" style="margin-left:16px;">Общие группы</div><div class="tg-info-list">';
    groups.forEach(c => {
        html +=
            '<div class="member-row" data-gid="' + c.id + '">' +
            '<div class="avatar">' + (c.avatarUrl ? '<img src="' + c.avatarUrl + '">' : initials(c.name)) + '</div>' +
            '<div class="member-row-info"><div class="member-row-name">' + (c.name || 'Группа') + '</div>' +
            '<div class="member-row-sub">' + (c.members || []).length + ' участников</div></div>' +
            '</div>';
    });
    html += '</div>';
    return html;
}

// The channel a profile owner has chosen to feature on their profile (see
// renderOwnChannelSection). The channel may not be one the viewer has
// joined, so it's fetched directly rather than relying on the local cache.
async function renderFeaturedChannelCard(profileOwner, container) {
    if (!container) return;
    const cid = profileOwner && profileOwner.featuredChannelId;
    if (!cid) { container.innerHTML = ''; return; }

    let chat = allChats[cid];
    if (!chat) {
        try {
            const doc = await db.collection('chats').doc(cid).get();
            if (doc.exists) chat = { id: doc.id, ...doc.data() };
        } catch (e) { chat = null; }
    }
    if (!chat || chat.type !== 'channel') { container.innerHTML = ''; return; }

    const isMember = (chat.members || []).includes(currentUser.uid);
    container.innerHTML =
        '<div class="section-label" style="margin-left:16px;">Канал</div>' +
        '<div class="tg-info-list"><div class="member-row" id="vpChannelRow">' +
        '<div class="avatar">' + (chat.avatarUrl ? '<img src="' + chat.avatarUrl + '">' : initials(chat.name)) + '</div>' +
        '<div class="member-row-info"><div class="member-row-name">' + (chat.name || 'Канал') + '</div>' +
        '<div class="member-row-sub">' + (chat.username ? '@' + chat.username + ' &middot; ' : '') + (chat.members || []).length + ' подписчиков</div></div>' +
        '<button class="btn ' + (isMember ? 'btn-secondary' : 'btn-primary') + '" id="vpChannelJoinBtn" style="width:auto;padding:8px 14px;font-size:13px;margin:0;">' + (isMember ? 'Отписаться' : 'Подписаться') + '</button>' +
        '</div></div>';

    const row = container.querySelector('#vpChannelRow');
    if (row) row.onclick = () => openChat(chat.id);
    const joinBtn = container.querySelector('#vpChannelJoinBtn');
    if (joinBtn) {
        joinBtn.onclick = async (e) => {
            e.stopPropagation();
            // Toggle in place (like Telegram's profile channel card) rather
            // than jumping into the channel — the button itself becomes
            // "Отписаться" once subscribed, no navigation involved. This
            // also sidesteps a real bug that navigating caused: right
            // after subscribing, the local allChats cache for a channel
            // you'd never been a member of hadn't synced yet, so
            // updateComposerAvailability() misread the missing entry as
            // "not a channel" and showed a real post box to a non-admin.
            joinBtn.disabled = true;
            try {
                if (isMember) {
                    await db.collection('chats').doc(chat.id).update({
                        members: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
                        admins: firebase.firestore.FieldValue.arrayRemove(currentUser.uid)
                    });
                    chat.members = (chat.members || []).filter(u => u !== currentUser.uid);
                    activeChats.delete(chat.id);
                } else {
                    await db.collection('chats').doc(chat.id).update({
                        members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
                    });
                    chat.members = [...new Set([...(chat.members || []), currentUser.uid])];
                }
            } catch (err) { console.error('Channel subscribe toggle error:', err); }
            renderChatList();
            renderFeaturedChannelCard(profileOwner, container);
        };
    }
}

// Recent photos shared in a conversation/group/channel — shown at the
// bottom of the relevant profile screen, like Telegram's shared-media tab.
async function renderProfileMedia(container, cid) {
    if (!container) return;
    container.innerHTML = '<div class="section-label" style="margin-left:16px;">Медиа</div><div class="tg-media-empty">Загрузка...</div>';
    try {
        // No orderBy here on purpose: combined with the chatId equality
        // filter it would need a composite Firestore index that this
        // project never creates, so the query used to fail silently and
        // shared media never showed up anywhere. A plain equality filter
        // only needs Firestore's automatic single-field index, so this
        // always works — sort by time client-side instead.
        const snap = await db.collection('messages').where('chatId', '==', cid).get();
        const withTime = [];
        snap.forEach(doc => {
            const m = doc.data();
            if (m.imageUrl) withTime.push({ url: m.imageUrl, ts: toMillis(m.timestamp) || 0 });
        });
        withTime.sort((a, b) => b.ts - a.ts);
        const imgs = withTime.map(x => x.url);
        if (!imgs.length) {
            container.innerHTML = '<div class="section-label" style="margin-left:16px;">Медиа</div><div class="tg-media-empty">Общих медиа пока нет</div>';
            return;
        }
        container.innerHTML = '<div class="section-label" style="margin-left:16px;">Медиа</div>';
        const grid = document.createElement('div');
        grid.className = 'tg-media-grid';
        const gridImgs = imgs.slice(0, 30);
        gridImgs.forEach((url, i) => {
            const thumb = document.createElement('div');
            thumb.className = 'tg-media-thumb';
            thumb.innerHTML = '<img src="' + url + '">';
            thumb.onclick = () => viewFull(url, gridImgs, i);
            grid.appendChild(thumb);
        });
        container.appendChild(grid);
    } catch (e) {
        container.innerHTML = '';
    }
}

// ==================== ATTACH MENU ====================
function toggleAttach() {
    const menu = $('#attachMenu');
    const btn = $('#attachBtn');
    if (!menu || !btn) return;
    const rect = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
    menu.style.left = (rect.left - 10) + 'px';
    menu.classList.toggle('show');
}

// ==================== SCREEN NAVIGATION ====================
function showScreen(id) {
    $$('.screen').forEach(s => {
        if (s.classList.contains('active')) s.classList.remove('active');
    });

    const newScreen = $('#' + id);
    if (!newScreen) return;
    newScreen.style.opacity = '0';
    newScreen.style.transform = 'translateY(8px)';
    newScreen.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    newScreen.classList.add('active');
    setTimeout(() => {
        newScreen.style.opacity = '1';
        newScreen.style.transform = 'translateY(0)';
    }, 10);

    const subScreens = ['screenMessages', 'screenViewProfile', 'screenChatInfo'];
    const isSub = subScreens.includes(id);
    const bn = $('#bottomNav');
    if (bn) {
        if (isSub) bn.classList.add('hidden');
        else bn.classList.remove('hidden');
    }
    if (!isSub) {
        const list = ['screenChats', 'screenProfile', 'screenSettings'];
        $$('.nav-item, .dt-nav-btn').forEach((n, i) => {
            // .nav-item and .dt-nav-btn are two separate groups of 3, each
            // in the same Чаты/Профиль/Настройки order, so their index
            // within the combined NodeList still maps onto `list` via %3.
            n.classList.toggle('active', (i % 3) === list.indexOf(id));
        });
        // Leaving the chat/profile/info flow entirely (back to a bottom-nav
        // tab) — currentChat used to stay set to whatever was last opened,
        // which made handleIncomingChanges treat that chat as "still being
        // viewed" forever, so its unread badge and notification sound would
        // silently stop working after the first visit. Clearing it here
        // means only a chat that's genuinely on screen suppresses those.
        if (currentChat !== null && !(isDesktopLayout() && id === 'screenChats')) {
            currentChat = null;
            renderChatList();
        }
    }
    if (id === 'screenProfile') renderOwnProfile();
}

// ==================== CREATE GROUP / CHANNEL ====================
function showCreateChatMenu() {
    showActionSheet([
        { label: 'Новая группа', icon: 'fa-users', onClick: () => showCreateChatFlow('group') },
        { label: 'Новый канал', icon: 'fa-bullhorn', onClick: () => showCreateChatFlow('channel') }
    ]);
}

function showCreateChatFlow(type) {
    const overlay = document.createElement('div');
    overlay.className = 'big-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'big-modal';

    const state = { name: '', username: '', avatarUrl: '', selected: new Set() };
    const title = type === 'group' ? 'Новая группа' : 'Новый канал';

    function renderStep1() {
        modal.innerHTML =
            '<div class="big-modal-header"><span>' + title + '</span><span style="cursor:pointer;color:var(--text-secondary);" id="ccClose">✕</span></div>' +
            '<div class="big-modal-body">' +
            '<div class="chat-info-avatar-wrap"><div class="avatar" id="ccAvatar" style="cursor:pointer;">' + (state.avatarUrl ? '<img src="' + state.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : '<i class="fas fa-camera"></i>') + '</div></div>' +
            '<div class="form-group"><label>Название</label><input type="text" class="form-input" id="ccName" value="' + state.name + '" placeholder="' + (type === 'group' ? 'Название группы' : 'Название канала') + '"></div>' +
            '<div class="form-group"><label>Username (необязательно)</label><input type="text" class="form-input" id="ccUsername" value="' + state.username + '" placeholder="username"></div>' +
            '</div>' +
            '<div class="big-modal-footer"><button class="btn btn-primary" id="ccNext">' + (type === 'group' ? 'Далее: участники' : 'Создать') + '</button></div>';

        modal.querySelector('#ccClose').onclick = () => overlay.remove();

        const avInput = document.createElement('input');
        avInput.type = 'file';
        avInput.accept = 'image/*';
        avInput.className = 'hidden';
        modal.appendChild(avInput);
        modal.querySelector('#ccAvatar').onclick = () => avInput.click();
        avInput.onchange = async () => {
            const file = avInput.files[0];
            if (!file) return;
            const compressed = await compressFile(file);
            const img = new Image();
            img.src = compressed.dataUrl;
            await new Promise(r => img.onload = r);
            const canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 200;
            canvas.getContext('2d').drawImage(img, 0, 0, 200, 200);
            state.avatarUrl = canvas.toDataURL('image/jpeg', 0.5);
            modal.querySelector('#ccAvatar').innerHTML = '<img src="' + state.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">';
        };

        modal.querySelector('#ccNext').onclick = async () => {
            state.name = modal.querySelector('#ccName').value.trim();
            state.username = modal.querySelector('#ccUsername').value.trim().replace('@', '');
            if (!state.name) return showCustomAlert('Введите название');
            if (state.username) {
                if (!/^[a-zA-Z0-9_]+$/.test(state.username)) return showCustomAlert('Username: только латинские буквы, цифры и подчёркивания');
                if (await isUsernameTaken(state.username, {})) return showCustomAlert('Этот username уже занят');
            }
            if (type === 'group') renderStep2();
            else createChat();
        };
    }

    function renderStep2() {
        const others = Object.values(allUsers).filter(u => u.id !== currentUser.uid);
        modal.innerHTML =
            '<div class="big-modal-header"><span>Участники</span><span style="cursor:pointer;color:var(--text-secondary);" id="ccBack">Назад</span></div>' +
            '<div class="big-modal-body">' +
            '<input type="text" class="search-input" id="ccMemberSearch" placeholder="Поиск по имени или username" style="width:100%;margin-bottom:10px;">' +
            '<div id="ccMemberList"></div>' +
            '</div>' +
            '<div class="big-modal-footer"><button class="btn btn-primary" id="ccCreate">Создать группу</button></div>';

        modal.querySelector('#ccBack').onclick = renderStep1;

        function renderMembers(filter) {
            const list = modal.querySelector('#ccMemberList');
            list.innerHTML = '';
            const q = (filter || '').toLowerCase();
            others
                .filter(u => !q || (u.displayName || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q))
                .forEach(u => {
                    const row = document.createElement('div');
                    row.className = 'member-row';
                    row.innerHTML =
                        '<div class="avatar">' + (u.avatarUrl ? '<img src="' + u.avatarUrl + '">' : initials(u.displayName)) + '</div>' +
                        '<div class="member-row-info"><div class="member-row-name">' + (u.displayName || 'Пользователь') + '</div>' +
                        '<div class="member-row-sub">' + (u.username ? '@' + u.username : '') + '</div></div>' +
                        '<div class="member-check' + (state.selected.has(u.id) ? ' checked' : '') + '"></div>';
                    row.onclick = () => {
                        if (state.selected.has(u.id)) state.selected.delete(u.id);
                        else state.selected.add(u.id);
                        renderMembers(modal.querySelector('#ccMemberSearch').value);
                    };
                    list.appendChild(row);
                });
        }
        renderMembers('');
        modal.querySelector('#ccMemberSearch').oninput = function () { renderMembers(this.value); };

        modal.querySelector('#ccCreate').onclick = createChat;
    }

    async function createChat() {
        const members = [currentUser.uid, ...state.selected];
        try {
            const ref = await db.collection('chats').add({
                type: type,
                name: state.name,
                username: state.username || '',
                avatarUrl: state.avatarUrl || '',
                description: '',
                members: members,
                admins: [currentUser.uid],
                createdBy: currentUser.uid,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            overlay.remove();
            allChats[ref.id] = { id: ref.id, type, name: state.name, username: state.username, avatarUrl: state.avatarUrl, members, admins: [currentUser.uid] };
            myChatIds.add(ref.id);
            openChat(ref.id);
        } catch (e) {
            showCustomAlert('Не удалось создать: ' + e.message);
        }
    }

    renderStep1();
    overlay.appendChild(modal);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
}

// ==================== CHAT INFO (group / channel) ====================
function showChatInfo(id) {
    const meta = allChats[id];
    if (!meta) return;
    const isAdmin = (meta.admins || []).includes(currentUser.uid);
    const isChannel = meta.type === 'channel';
    const body = $('#chatInfoBody');
    if (!body) return;

    $('#ciBackBtn').onclick = () => showScreen('screenMessages');

    function render() {
        const members = meta.members || [];
        const memberLabel = isChannel ? 'подписчиков' : 'участников';
        const canAdd = !isChannel || isAdmin;
        // Non-admins can see how many subscribers a channel has, but not
        // the actual list — mirrors Telegram, where a channel's subscriber
        // list is admin-only while a group's member list stays visible to
        // everyone.
        const canSeeMemberList = !isChannel || isAdmin;

        body.innerHTML =
            '<div class="tg-cover' + (meta.coverUrl ? ' has-photo' : '') + '"' + (meta.coverUrl ? ' style="background-image:url(\'' + meta.coverUrl + '\')"' : '') + '>' +
            (isAdmin ? '<div class="tg-cover-edit" id="ciCoverEdit" title="Изменить обложку"><i class="fas fa-camera"></i></div>' : '') +
            '<div class="avatar" id="ciAvatar"' + (isAdmin ? ' style="cursor:pointer;"' : '') + '>' + (meta.avatarUrl ? '<img src="' + meta.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : initials(meta.name)) + '</div>' +
            '<div class="tg-cover-info">' +
            '<div class="tg-cover-name">' + (meta.name || 'Чат') + '</div>' +
            '<div class="tg-cover-sub">' + (meta.username ? '@' + meta.username + ' &middot; ' : '') + members.length + ' ' + memberLabel + '</div>' +
            '</div>' +
            '</div>' +
            '<div class="tg-actions-row">' +
            (canAdd ? '<div class="tg-action-btn" id="ciAddMember"><div class="circle"><i class="fas fa-user-plus"></i></div><span>Добавить</span></div>' : '') +
            '</div>' +
            (isAdmin ? (
                '<div class="section-label first" style="margin-left:16px;">Настройки</div>' +
                '<div class="tg-edit-list">' +
                '<div class="form-group"><label>Название</label><input type="text" class="form-input" id="ciName" value="' + (meta.name || '') + '"></div>' +
                '<div class="form-group"><label>Username</label><input type="text" class="form-input" id="ciUsername" value="' + (meta.username || '') + '"></div>' +
                '<button class="btn btn-primary" id="ciSave" style="margin-bottom:14px;">Сохранить</button>' +
                '</div>'
            ) : '') +
            (canSeeMemberList ? (
                '<div class="section-label" style="margin-left:16px;">' + memberLabel.charAt(0).toUpperCase() + memberLabel.slice(1) + '</div>' +
                '<div class="tg-info-list" id="ciMemberList"></div>'
            ) : '') +
            '<div id="ciMediaSection"></div>' +
            '<div class="tg-danger-list">' +
            '<div class="tg-danger-row" id="ciLeave"><i class="fas fa-sign-out-alt"></i> Покинуть чат</div>' +
            (isAdmin ? '<div class="tg-danger-row" id="ciDelete"><i class="fas fa-trash"></i> Удалить чат</div>' : '') +
            '</div>';

        renderProfileMedia(body.querySelector('#ciMediaSection'), id);

        const listEl = body.querySelector('#ciMemberList');
        if (listEl) {
            members.forEach(uid => {
                const u = allUsers[uid];
                if (!u) return;
                const isTargetAdmin = (meta.admins || []).includes(uid);
                const row = document.createElement('div');
                row.className = 'member-row';
                row.innerHTML =
                    '<div class="avatar">' + (u.avatarUrl ? '<img src="' + u.avatarUrl + '">' : initials(u.displayName)) + '</div>' +
                    '<div class="member-row-info"><div class="member-row-name">' + (u.displayName || 'Пользователь') +
                    (isTargetAdmin ? '<span class="role-tag">admin</span>' : '') + '</div>' +
                    '<div class="member-row-sub">' + (u.username ? '@' + u.username : '') + '</div></div>';
                row.onclick = () => viewUserProfile(uid, 'screenChatInfo');

                // Admins can promote/demote other members and remove them
                // from the group or channel — not available for yourself.
                if (isAdmin && uid !== currentUser.uid) {
                    const menuBtn = document.createElement('div');
                    menuBtn.className = 'member-row-menu';
                    menuBtn.innerHTML = '<i class="fas fa-ellipsis-v"></i>';
                    menuBtn.onclick = (e) => {
                        e.stopPropagation();
                        showActionSheet([
                            {
                                label: isTargetAdmin ? 'Снять администратора' : 'Сделать администратором',
                                icon: 'fa-user-shield',
                                onClick: async () => {
                                    await db.collection('chats').doc(id).update({
                                        admins: isTargetAdmin
                                            ? firebase.firestore.FieldValue.arrayRemove(uid)
                                            : firebase.firestore.FieldValue.arrayUnion(uid)
                                    });
                                    meta.admins = isTargetAdmin
                                        ? (meta.admins || []).filter(a => a !== uid)
                                        : [...(meta.admins || []), uid];
                                    render();
                                }
                            },
                            {
                                label: 'Удалить из чата',
                                icon: 'fa-user-slash',
                                danger: true,
                                onClick: () => {
                                    showCustomConfirm('Удалить этого участника из чата?', async () => {
                                        await db.collection('chats').doc(id).update({
                                            members: firebase.firestore.FieldValue.arrayRemove(uid),
                                            admins: firebase.firestore.FieldValue.arrayRemove(uid)
                                        });
                                        meta.members = (meta.members || []).filter(x => x !== uid);
                                        meta.admins = (meta.admins || []).filter(x => x !== uid);
                                        render();
                                    });
                                }
                            }
                        ]);
                    };
                    row.appendChild(menuBtn);
                }

                listEl.appendChild(row);
            });
        }

        if (isAdmin) {
            body.querySelector('#ciSave').onclick = async () => {
                const name = body.querySelector('#ciName').value.trim();
                const username = body.querySelector('#ciUsername').value.trim().replace('@', '');
                if (!name) return showCustomAlert('Введите название');
                if (username && !/^[a-zA-Z0-9_]+$/.test(username)) return showCustomAlert('Username: только латинские буквы, цифры и подчёркивания');
                if (username && username !== meta.username) {
                    if (await isUsernameTaken(username, { excludeChatId: id })) return showCustomAlert('Этот username уже занят');
                }
                await db.collection('chats').doc(id).update({ name, username: username || '' });
                showCustomAlert('✅ Сохранено');
            };

            const avEl = body.querySelector('#ciAvatar');
            if (avEl) {
                const avInput = document.createElement('input');
                avInput.type = 'file';
                avInput.accept = 'image/*';
                avInput.className = 'hidden';
                body.appendChild(avInput);
                avEl.onclick = () => avInput.click();
                avInput.onchange = async () => {
                    const file = avInput.files[0];
                    if (!file) return;
                    const compressed = await compressFile(file);
                    const img = new Image();
                    img.src = compressed.dataUrl;
                    await new Promise(r => img.onload = r);
                    const canvas = document.createElement('canvas');
                    canvas.width = 200;
                    canvas.height = 200;
                    canvas.getContext('2d').drawImage(img, 0, 0, 200, 200);
                    const avatarUrl = canvas.toDataURL('image/jpeg', 0.5);
                    await db.collection('chats').doc(id).update({ avatarUrl });
                    meta.avatarUrl = avatarUrl;
                    avEl.innerHTML = '<img src="' + avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">';
                };
            }

            const coverEl = body.querySelector('#ciCoverEdit');
            if (coverEl) {
                const coverInput = document.createElement('input');
                coverInput.type = 'file';
                coverInput.accept = 'image/*';
                coverInput.className = 'hidden';
                body.appendChild(coverInput);
                coverEl.onclick = () => coverInput.click();
                coverInput.onchange = async () => {
                    const file = coverInput.files[0];
                    if (!file) return;
                    const compressed = await compressFile(file);
                    const img = new Image();
                    img.src = compressed.dataUrl;
                    await new Promise(r => img.onload = r);
                    const canvas = document.createElement('canvas');
                    canvas.width = 640;
                    canvas.height = 256;
                    const ctx = canvas.getContext('2d');
                    const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
                    const sw = canvas.width / scale;
                    const sh = canvas.height / scale;
                    const sx = (img.width - sw) / 2;
                    const sy = (img.height - sh) / 2;
                    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
                    const coverUrl = canvas.toDataURL('image/jpeg', 0.6);
                    await db.collection('chats').doc(id).update({ coverUrl });
                    meta.coverUrl = coverUrl;
                    render();
                };
            }
        }

        const addBtn = body.querySelector('#ciAddMember');
        if (addBtn) {
            addBtn.onclick = () => showAddMemberPicker(id);
        }

        body.querySelector('#ciLeave').onclick = () => {
            showCustomConfirm('Покинуть этот чат?', async () => {
                await db.collection('chats').doc(id).update({
                    members: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
                    admins: firebase.firestore.FieldValue.arrayRemove(currentUser.uid)
                });
                showScreen('screenChats');
            });
        };

        const delBtn = body.querySelector('#ciDelete');
        if (delBtn) {
            delBtn.onclick = () => {
                showCustomConfirm('Удалить чат целиком? Это действие необратимо.', async () => {
                    await db.collection('chats').doc(id).delete();
                    showScreen('screenChats');
                });
            };
        }
    }

    render();
    showScreen('screenChatInfo');
}

function showAddMemberPicker(chatId) {
    const meta = allChats[chatId];
    if (!meta) return;
    const overlay = document.createElement('div');
    overlay.className = 'big-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'big-modal';
    modal.innerHTML =
        '<div class="big-modal-header"><span>Добавить участника</span><span style="cursor:pointer;color:var(--text-secondary);" id="amClose">✕</span></div>' +
        '<div class="big-modal-body">' +
        '<input type="text" class="search-input" id="amSearch" placeholder="Поиск по имени или username" style="width:100%;margin-bottom:10px;">' +
        '<div id="amList"></div>' +
        '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    modal.querySelector('#amClose').onclick = () => overlay.remove();

    function renderList(filter) {
        const list = modal.querySelector('#amList');
        list.innerHTML = '';
        const q = (filter || '').toLowerCase();
        Object.values(allUsers)
            .filter(u => u.id !== currentUser.uid && !(meta.members || []).includes(u.id))
            .filter(u => !q || (u.displayName || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q))
            .forEach(u => {
                const row = document.createElement('div');
                row.className = 'member-row';
                row.innerHTML =
                    '<div class="avatar">' + (u.avatarUrl ? '<img src="' + u.avatarUrl + '">' : initials(u.displayName)) + '</div>' +
                    '<div class="member-row-info"><div class="member-row-name">' + (u.displayName || 'Пользователь') + '</div>' +
                    '<div class="member-row-sub">' + (u.username ? '@' + u.username : '') + '</div></div>';
                row.onclick = async () => {
                    await db.collection('chats').doc(chatId).update({
                        members: firebase.firestore.FieldValue.arrayUnion(u.id)
                    });
                    overlay.remove();
                };
                list.appendChild(row);
            });
    }
    renderList('');
    modal.querySelector('#amSearch').oninput = function () { renderList(this.value); };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// Tucks the stories tray away while scrolling down the chat list, and
// brings it back on scroll up or once you're back at the top — mirrors
// how Telegram collapses the stories row as you browse chats.
function setupStoriesHideOnScroll() {
    const scrollEl = document.querySelector('#screenChats .chat-scroll');
    const row = $('#storiesRow');
    if (!scrollEl || !row) return;
    // anchorTop is only updated when we actually decide to toggle, not on
    // every scroll event — comparing against the raw previous event (as
    // before) made a fast flick fire dozens of scroll events per second,
    // each nudging the 4px window and flipping the class back and forth,
    // which is what made the stories row / sticky search bar visibly judder.
    let anchorTop = 0;
    let hidden = false;
    let ticking = false;
    const THRESHOLD = 16;

    function evaluate() {
        ticking = false;
        const top = scrollEl.scrollTop;
        if (top <= 4) {
            if (hidden) { row.classList.remove('stories-hidden'); hidden = false; }
            anchorTop = top;
            return;
        }
        const delta = top - anchorTop;
        if (!hidden && delta > THRESHOLD) {
            row.classList.add('stories-hidden');
            hidden = true;
            anchorTop = top;
        } else if (hidden && delta < -THRESHOLD) {
            row.classList.remove('stories-hidden');
            hidden = false;
            anchorTop = top;
        }
    }

    scrollEl.addEventListener('scroll', () => {
        if (!ticking) {
            ticking = true;
            requestAnimationFrame(evaluate);
        }
    }, { passive: true });
}

// ==================== SETUP LISTENERS ====================
// Shows a floating "jump to bottom" button once you've scrolled up away
// from the latest messages, like Telegram — click it to snap back down.
function setupScrollToBottomBtn() {
    const area = $('#msgArea');
    const btn = $('#scrollBottomBtn');
    if (!area || !btn) return;

    let ticking = false;
    area.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            const distanceFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
            btn.classList.toggle('visible', distanceFromBottom > 400);
            ticking = false;
        });
    }, { passive: true });

    btn.onclick = () => {
        area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
    };
}

// The open-chat header floats over the message list (see #screenMessages
// The open-chat header (and the pinned-bar right below it, when shown)
// float over the message list (see #screenMessages > .header/.pinned-bar
// in style.css), so the message list needs to know exactly how tall they
// currently are to pad itself clear of them. ResizeObservers keep that in
// sync automatically — the header's height isn't fixed (the typing
// indicator adds a second line sometimes), and the pinned bar's height
// goes from 0 (display:none) to its real height whenever a message gets
// pinned or unpinned.
function setupChatHeaderHeightSync() {
    if (!window.ResizeObserver) return;
    const header = document.querySelector('#screenMessages > .header');
    if (header) {
        const ro = new ResizeObserver(() => {
            const h = header.offsetHeight;
            if (h > 0) document.documentElement.style.setProperty('--chat-header-h', h + 'px');
        });
        ro.observe(header);
    }
    const pinnedBar = document.querySelector('#screenMessages > .pinned-bar');
    if (pinnedBar) {
        const ro2 = new ResizeObserver(() => {
            document.documentElement.style.setProperty('--chat-pinned-h', pinnedBar.offsetHeight + 'px');
        });
        ro2.observe(pinnedBar);
    }
}

function setupListeners() {
    $$('.nav-item, .dt-nav-btn').forEach(n => n.onclick = () => showScreen(n.dataset.sc));
    $('#backBtn').onclick = () => showScreen('screenChats');
    $('#cancelSelectBtn').onclick = () => toggleSelect();
    $('#deleteSelectedBtn').onclick = deleteSelected;
    $('#newChatBtn').onclick = showCreateChatMenu;
    setupStoriesHideOnScroll();
    setupScrollToBottomBtn();
    setupChatHeaderHeightSync();

    const pinnedBarClose = $('#pinnedBarClose');
    if (pinnedBarClose) {
        pinnedBarClose.onclick = (e) => {
            e.stopPropagation();
            if (!currentChat || !currentPinnedList.length) return;
            const cid = chatIdFor(currentChat);
            const msgId = currentPinnedList[pinnedShownIndex];
            const msg = (messageCache[cid] || []).find(x => x.id === msgId) || { id: msgId };
            togglePinMessage(msg, cid);
        };
    }

    const sendBtn = $('#sendBtn');
    // Prevents the classic "keyboard closes then reopens" flicker: by
    // default, tapping a <button> steals focus from the textarea, which
    // makes mobile browsers dismiss the on-screen keyboard for an instant
    // before our code re-focuses the input. Blocking the button's default
    // pointer behavior keeps focus (and the keyboard) on the textarea the
    // whole time, so nothing ever closes.
    sendBtn.addEventListener('pointerdown', e => e.preventDefault());
    sendBtn.onclick = sendMsg;

    const input = $('#msgInput');
    if (input) {
        input.onkeydown = e => {
            if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 768) {
                e.preventDefault();
                sendMsg();
            }
        };
        input.oninput = function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 100) + 'px';
            setTyping();
            updateMentionSuggestions(this);
        };
        input.addEventListener('keyup', () => updateMentionSuggestions(input));
        input.addEventListener('click', () => updateMentionSuggestions(input));
        input.addEventListener('blur', () => setTimeout(hideMentionSuggestions, 150));
    }

    const attachBtn = $('#attachBtn');
    attachBtn.addEventListener('pointerdown', e => e.preventDefault());
    attachBtn.onclick = function (e) {
        e.stopPropagation();
        toggleAttach();
    };

    $$('.attach-menu-item').forEach(item => {
        item.onclick = function (e) {
            e.stopPropagation();
            const fi = $('#fileInput');
            if (fi) {
                fi.accept = this.dataset.accept;
                fi.click();
            }
            $('#attachMenu').classList.remove('show');
        };
    });

    $('#fileInput').onchange = () => {
        if ($('#fileInput').files[0]) sendMsg();
    };

    $('#replyClose').onclick = cancelReply;

    $('#settLogout').onclick = logout;
    $('#switchAccountRow').onclick = showAccountSwitcher;

    $('#darkRow').onclick = () => {
        darkMode = !darkMode;
        localStorage.setItem('quark_dark', darkMode ? '1' : '0');
        applyTheme();
    };
    $('#darkToggle').onclick = e => {
        e.stopPropagation();
        darkMode = !darkMode;
        localStorage.setItem('quark_dark', darkMode ? '1' : '0');
        applyTheme();
    };

    $('#fontRow').onclick = () => {
        const sizes = ['small', 'medium', 'large'];
        fontSize = sizes[(sizes.indexOf(fontSize) + 1) % 3];
        applyFontSize();
        const fv = $('#fontValue');
        if (fv) fv.textContent = { small: 'Мелкий', medium: 'Средний', large: 'Крупный' }[fontSize];
    };

    const amoledToggleFn = e => {
        if (e) e.stopPropagation();
        amoledMode = !amoledMode;
        localStorage.setItem('quark_amoled', amoledMode ? '1' : '0');
        applyTheme();
    };
    $('#amoledRow').onclick = amoledToggleFn;
    $('#amoledToggle').onclick = amoledToggleFn;

    $('#accentRow').onclick = openThemePicker;
    $('#wallpaperRow').onclick = openWallpaperPicker;
    $('#quickReactionRow').onclick = openQuickReactionPicker;

    const scaleUpBtn = $('#scaleUpBtn');
    if (scaleUpBtn) scaleUpBtn.onclick = () => {
        const i = DESKTOP_SCALES.indexOf(desktopScale);
        applyDesktopScale(DESKTOP_SCALES[Math.min(DESKTOP_SCALES.length - 1, (i === -1 ? 2 : i) + 1)]);
    };
    const scaleDownBtn = $('#scaleDownBtn');
    if (scaleDownBtn) scaleDownBtn.onclick = () => {
        const i = DESKTOP_SCALES.indexOf(desktopScale);
        applyDesktopScale(DESKTOP_SCALES[Math.max(0, (i === -1 ? 2 : i) - 1)]);
    };

    $('#soundRow').onclick = () => {
        soundEnabled = !soundEnabled;
        localStorage.setItem('quark_sound', soundEnabled);
        const st = $('#soundToggle');
        if (st) st.classList.toggle('active', soundEnabled);
    };
    $('#soundToggle').onclick = e => {
        e.stopPropagation();
        soundEnabled = !soundEnabled;
        localStorage.setItem('quark_sound', soundEnabled);
        const st = $('#soundToggle');
        if (st) st.classList.toggle('active', soundEnabled);
    };

    $('#readReceiptsRow').onclick = () => {
        readReceiptsEnabled = !readReceiptsEnabled;
        localStorage.setItem('quark_read_receipts', readReceiptsEnabled);
        const rt = $('#readReceiptsToggle');
        if (rt) rt.classList.toggle('active', readReceiptsEnabled);
    };
    $('#readReceiptsToggle').onclick = e => {
        e.stopPropagation();
        readReceiptsEnabled = !readReceiptsEnabled;
        localStorage.setItem('quark_read_receipts', readReceiptsEnabled);
        const rt = $('#readReceiptsToggle');
        if (rt) rt.classList.toggle('active', readReceiptsEnabled);
    };

    // These three affect what OTHER people see about you, so — unlike the
    // device-only toggles above — they're saved to your profile document
    // rather than localStorage.
    function toggleLastSeen() {
        const enabled = !((currentProfile && currentProfile.lastSeenEnabled) !== false);
        currentProfile.lastSeenEnabled = enabled;
        db.collection('users').doc(currentUser.uid).update({ lastSeenEnabled: enabled }).catch(() => {});
        const lt = $('#lastSeenToggle');
        if (lt) lt.classList.toggle('active', enabled);
    }
    $('#lastSeenRow').onclick = toggleLastSeen;
    $('#lastSeenToggle').onclick = e => { e.stopPropagation(); toggleLastSeen(); };

    function toggleTypingIndicator() {
        const enabled = !((currentProfile && currentProfile.typingIndicatorEnabled) !== false);
        currentProfile.typingIndicatorEnabled = enabled;
        db.collection('users').doc(currentUser.uid).update({ typingIndicatorEnabled: enabled }).catch(() => {});
        const tt = $('#typingToggle');
        if (tt) tt.classList.toggle('active', enabled);
    }
    $('#typingRow').onclick = toggleTypingIndicator;
    $('#typingToggle').onclick = e => { e.stopPropagation(); toggleTypingIndicator(); };

    function togglePrivateProfile() {
        const enabled = !(currentProfile && currentProfile.privateProfile);
        currentProfile.privateProfile = enabled;
        db.collection('users').doc(currentUser.uid).update({ privateProfile: enabled }).catch(() => {});
        const pt = $('#privateProfileToggle');
        if (pt) pt.classList.toggle('active', enabled);
    }
    $('#privateProfileRow').onclick = togglePrivateProfile;
    $('#privateProfileToggle').onclick = e => { e.stopPropagation(); togglePrivateProfile(); };

    function toggleStoryForward() {
        const enabled = !((currentProfile && currentProfile.allowStoryForward) !== false);
        currentProfile.allowStoryForward = enabled;
        db.collection('users').doc(currentUser.uid).update({ allowStoryForward: enabled }).catch(() => {});
        const sft = $('#storyForwardToggle');
        if (sft) sft.classList.toggle('active', enabled);
    }
    $('#storyForwardRow').onclick = toggleStoryForward;
    $('#storyForwardToggle').onclick = e => { e.stopPropagation(); toggleStoryForward(); };

    $('#clearCacheRow').onclick = () => {
        showCustomConfirm('Очистить локальный кэш сообщений? Приложение перезагрузится.', () => {
            messageCache = {};
            location.reload();
        });
    };

    $('#aboutRow').onclick = () => {
        showCustomAlert('Quark Messenger<br>Мессенджер с чатами, группами, каналами и общим чатом.');
    };

    const searchInput = $('#searchInput');
    if (searchInput) {
        searchInput.oninput = async function () {
            const q = this.value.trim();
            if (!q) { renderChatList(); return; }
            await renderSearchResults(q.toLowerCase(), q);
        };
    }

    const msgArea = $('#msgArea');
    if (msgArea) {
        msgArea.onscroll = () => {
            shouldScrollDown = msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight < 80;
        };
    }

    document.addEventListener('click', function (e) {
        const attachMenu = $('#attachMenu');
        const attachBtnEl = $('#attachBtn');
        if (attachMenu && !attachMenu.contains(e.target) && e.target !== attachBtnEl && !attachBtnEl?.contains(e.target)) {
            attachMenu.classList.remove('show');
        }
        document.querySelectorAll('.msg-context-menu').forEach(m => {
            if (!m.contains(e.target)) m.remove();
        });
    });
}

// Searches known users by name/username, plus groups/channels I'm already
// in by name/username, plus does an exact-username lookup against public
// groups/channels I'm NOT in yet (so you can find and join one, the way
// you'd search a public @handle in Telegram).
async function renderSearchResults(q, rawQuery) {
    const list = $('#chatList');
    if (!list) return;
    list.innerHTML = '';

    Object.values(allUsers).forEach(user => {
        if (user.id === currentUser.uid) return;
        // A private profile stays out of search for people who haven't
        // talked to them yet — existing contacts can still find them,
        // same as Telegram's "who can find me" privacy behaves.
        if (user.privateProfile && !activeChats.has(user.id)) return;
        const name = (user.displayName || '').toLowerCase();
        const uname = (user.username || '').toLowerCase();
        if (!name.includes(q) && !uname.includes(q)) return;

        const div = document.createElement('div');
        div.className = 'chat-item';
        div.innerHTML = `
            <div class="avatar">${user.avatarUrl ? '<img src="' + user.avatarUrl + '">' : initials(user.displayName)}</div>
            <div class="chat-info">
                <div class="chat-name">${user.displayName || 'Пользователь'}${verifiedBadge(user.verified)}</div>
                ${user.username ? '<div style="font-size:12px;color:var(--primary);">@' + user.username + '</div>' : ''}
            </div>`;
        div.onclick = () => {
            if (!activeChats.has(user.id)) {
                activeChats.add(user.id);
                loadChatPreview(user.id, chatIdFor(user.id));
            }
            openChat(user.id);
        };
        list.appendChild(div);
    });

    Object.values(allChats).forEach(chat => {
        if (chat.id === GENERAL_CHAT_ID) return;
        const name = (chat.name || '').toLowerCase();
        const uname = (chat.username || '').toLowerCase();
        if (!name.includes(q) && !uname.includes(q)) return;
        const div = document.createElement('div');
        div.className = 'chat-item';
        div.innerHTML = `
            <div class="avatar">${chat.avatarUrl ? '<img src="' + chat.avatarUrl + '">' : initials(chat.name)}</div>
            <div class="chat-info">
                <div class="chat-name">${chat.name || 'Чат'}</div>
                ${chat.username ? '<div style="font-size:12px;color:var(--primary);">@' + chat.username + '</div>' : ''}
            </div>`;
        div.onclick = () => openChat(chat.id);
        list.appendChild(div);
    });

    const uname = rawQuery.replace('@', '').trim();
    if (uname && !myChatIds.has(uname)) {
        try {
            const snap = await db.collection('chats').where('username', '==', uname).get();
            snap.forEach(doc => {
                const chat = doc.data();
                if (myChatIds.has(doc.id)) return;
                const div = document.createElement('div');
                div.className = 'chat-item';
                div.innerHTML = `
                    <div class="avatar">${chat.avatarUrl ? '<img src="' + chat.avatarUrl + '">' : initials(chat.name)}</div>
                    <div class="chat-info">
                        <div class="chat-name">${chat.name || 'Чат'}</div>
                        <div style="font-size:12px;color:var(--primary);">@${chat.username}</div>
                    </div>
                    <button class="btn btn-primary" style="width:auto;padding:8px 14px;font-size:13px;" id="joinBtn-${doc.id}">Вступить</button>`;
                list.appendChild(div);
                div.querySelector('button').onclick = async (e) => {
                    e.stopPropagation();
                    await db.collection('chats').doc(doc.id).update({
                        members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
                    });
                    openChat(doc.id);
                };
            });
        } catch (e) {}
    }
}

// ==================== MULTI ACCOUNT ====================
function saveCurrentAccount() {
    const exists = savedAccounts.find(a => a.uid === currentUser.uid);
    if (!exists) {
        savedAccounts.push({
            uid: currentUser.uid,
            email: currentUser.email,
            displayName: currentProfile.displayName,
            avatarUrl: currentProfile.avatarUrl || ''
        });
        localStorage.setItem('quark_accounts', JSON.stringify(savedAccounts));
    }
}

function showAccountSwitcher() {
    saveCurrentAccount();

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:250;';

    const bg = getComputedStyle(document.body).getPropertyValue('--glass').trim();
    const textColor = getComputedStyle(document.body).getPropertyValue('--text').trim();
    const borderColor = getComputedStyle(document.body).getPropertyValue('--glass-border').trim();
    const shadowColor = getComputedStyle(document.body).getPropertyValue('--shadow-lg').trim();
    const primaryColor = getComputedStyle(document.body).getPropertyValue('--primary').trim();

    const modal = document.createElement('div');
    modal.style.cssText = 'background:' + bg + ';backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);' +
        'border-radius:16px;padding:24px;max-width:360px;width:90%;text-align:center;border:1px solid ' + borderColor + ';' +
        'box-shadow:' + shadowColor + ';color:' + textColor + ';max-height:80vh;overflow-y:auto;';

    let accountsHtml = '';
    savedAccounts.forEach(account => {
        const isActive = account.uid === currentUser.uid;
        accountsHtml +=
            '<div class="account-item" data-uid="' + account.uid + '" data-email="' + account.email + '" style="padding:12px;display:flex;align-items:center;gap:12px;cursor:pointer;border-radius:12px;margin-bottom:8px;' + (isActive ? 'background:rgba(124,77,255,0.2);' : '') + '">' +
            '<div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,' + primaryColor + ',#A78BFA);display:flex;align-items:center;justify-content:center;color:white;font-weight:600;font-size:16px;overflow:hidden;">' +
            (account.avatarUrl ? '<img src="' + account.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : initials(account.displayName || account.email)) +
            '</div>' +
            '<div style="flex:1;text-align:left;">' +
            '<div style="font-weight:600;">' + (account.displayName || 'Пользователь') + '</div>' +
            '<div style="font-size:12px;color:var(--text-secondary);">' + account.email + '</div>' +
            '</div>' +
            (isActive ? '<i class="fas fa-check" style="color:' + primaryColor + ';"></i>' : '') +
            '</div>';
    });

    modal.innerHTML = '<h3 style="margin-bottom:16px;">Выберите аккаунт</h3>' + accountsHtml +
        '<div id="addAccountBtn" style="padding:12px;display:flex;align-items:center;gap:12px;cursor:pointer;border-radius:12px;margin-top:8px;border:1px dashed ' + borderColor + ';">' +
        '<div style="width:44px;height:44px;border-radius:50%;background:rgba(128,128,128,0.2);display:flex;align-items:center;justify-content:center;font-size:20px;"><i class="fas fa-plus"></i></div>' +
        '<div style="flex:1;text-align:left;font-weight:600;">Добавить аккаунт</div>' +
        '</div>' +
        '<button id="closeSwitcherBtn" style="margin-top:12px;width:100%;padding:10px;background:rgba(128,128,128,0.2);color:' + textColor + ';border:none;border-radius:10px;cursor:pointer;font-size:14px;">Закрыть</button>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelectorAll('.account-item[data-uid]').forEach(item => {
        item.onclick = function () {
            const uid = item.dataset.uid;
            const email = item.dataset.email;

            if (uid === currentUser.uid) {
                overlay.remove();
                return;
            }

            modal.innerHTML = '<h3 style="margin-bottom:16px;">Введите пароль</h3>' +
                '<p style="margin-bottom:12px;color:var(--text-secondary);">' + email + '</p>' +
                '<input type="password" id="switchPassword" class="auth-input" style="margin-bottom:12px;">' +
                '<div style="display:flex;gap:10px;">' +
                '<button id="switchLoginBtn" style="flex:1;background:' + primaryColor + ';color:white;border:none;padding:10px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;">Войти</button>' +
                '<button id="switchBackBtn" style="flex:1;background:rgba(128,128,128,0.2);color:' + textColor + ';border:none;padding:10px;border-radius:10px;cursor:pointer;font-size:14px;">Назад</button>' +
                '</div>';

            const passwordInput = modal.querySelector('#switchPassword');
            passwordInput.focus();

            modal.querySelector('#switchBackBtn').onclick = function () {
                overlay.remove();
                showAccountSwitcher();
            };

            modal.querySelector('#switchLoginBtn').onclick = async function () {
                const password = passwordInput.value;
                if (!password) return showCustomAlert('Введите пароль');
                overlay.remove();

                const oldUid = currentUser.uid;
                teardownSession();
                try {
                    await db.collection('users').doc(oldUid).update({
                        online: false,
                        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                    });
                } catch (e) {}
                await auth.signOut();

                try {
                    const result = await auth.signInWithEmailAndPassword(email, password);
                    currentUser = result.user;
                    await loadProfile();
                    buildMainUI();
                    await initChats();
                } catch (e) {
                    showCustomAlert('Неверный пароль: ' + e.message);
                    showAuthScreen();
                }
            };
        };
    });

    modal.querySelector('#addAccountBtn').onclick = function () {
        overlay.remove();
        const oldUid = currentUser.uid;
        teardownSession();
        db.collection('users').doc(oldUid).update({
            online: false,
            lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
        auth.signOut();
        showAuthScreen();
    };

    modal.querySelector('#closeSwitcherBtn').onclick = function () { overlay.remove(); };
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
}

// ==================== STARTUP ====================
auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        await loadProfile();
        buildMainUI();
        await initChats();
    } else {
        showAuthScreen();
    }
});
