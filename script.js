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
let currentUser = null;
let currentProfile = null;
let allUsers = {};
let allChats = {};              // group/channel/general chat docs, keyed by chat id
let activeChats = new Set();    // DM partner uids
let myChatIds = new Set();      // group/channel ids I'm a member of
let currentChat = null;         // either a uid (DM) or a chat id (group/channel/general)
let messageCache = {};
let lastMessagePreviews = {};
let lastMessageTimes = {};
let unreadCounts = {};
let typingTimers = {};
let selectedMessages = new Set();
let selectionMode = false;
let darkMode = localStorage.getItem('quark_dark') === '1';
let fontSize = localStorage.getItem('quark_font') || 'medium';
let soundEnabled = localStorage.getItem('quark_sound') !== 'false';
let readReceiptsEnabled = localStorage.getItem('quark_read_receipts') !== 'false';
let unsubscribeMessages = null;
let shouldScrollDown = true;
let replyTo = null;
let savedAccounts = JSON.parse(localStorage.getItem('quark_accounts') || '[]');

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

function toMillis(value) {
    if (!value) return 0;
    return value.toDate ? value.toDate().getTime() : new Date(value).getTime();
}

function isUserOnline(user) {
    if (!user || !user.online) return false;
    if (!user.lastSeen) return true;
    return (Date.now() - toMillis(user.lastSeen)) < ONLINE_THRESHOLD_MS;
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

function initials(name) {
    return (name || 'П')[0].toUpperCase();
}

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
    }
    const dt = $('#darkToggle');
    if (dt) dt.classList.toggle('active', darkMode);
    document.body.style.background = darkMode ? '#0F0F1A' : '#F0EDF7';
}

function applyFontSize() {
    const scales = { small: '0.88', medium: '1.0', large: '1.18' };
    document.documentElement.style.setProperty('--ui-scale', scales[fontSize] || '1.0');
    localStorage.setItem('quark_font', fontSize);
}

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
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:250;';

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
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:250;';

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
    lastMessagePreviews = {};
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

async function loadProfile() {
    const doc = await db.collection('users').doc(currentUser.uid).get();
    if (doc.exists) {
        currentProfile = { id: currentUser.uid, ...doc.data() };
    } else {
        currentProfile = { id: currentUser.uid, displayName: currentUser.email.split('@')[0], username: '', bio: '', avatarUrl: '' };
        await db.collection('users').doc(currentUser.uid).set(currentProfile);
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
            <div class="msg-area" id="msgArea"><div class="empty-state"><i class="far fa-comments"></i><p>Выберите чат</p></div></div>
            <div class="input-container" id="inputContainer">
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
                <div class="settings-group">
                    <div class="settings-row" id="darkRow">
                        <div class="settings-left"><div class="settings-icon" style="background:var(--surface);color:var(--text);"><i class="fas fa-moon"></i></div><span class="settings-text">Тёмная тема</span></div>
                        <div class="toggle" id="darkToggle"></div>
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-row" id="fontRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(59,130,246,0.15);color:#3B82F6;"><i class="fas fa-font"></i></div><span class="settings-text">Размер шрифта</span></div>
                        <span class="settings-value" id="fontValue">Средний</span>
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-row" id="soundRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-volume-up"></i></div><span class="settings-text">Звук уведомлений</span></div>
                        <div class="toggle" id="soundToggle"></div>
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-row" id="readReceiptsRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-check-double"></i></div><span class="settings-text">Отметки о прочтении</span></div>
                        <div class="toggle" id="readReceiptsToggle"></div>
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-row" id="clearCacheRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(59,130,246,0.15);color:#3B82F6;"><i class="fas fa-broom"></i></div><span class="settings-text">Очистить кэш</span></div>
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-row" id="switchAccountRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(124,77,255,0.15);color:var(--primary);"><i class="fas fa-exchange-alt"></i></div><span class="settings-text">Сменить аккаунт</span></div>
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-row" id="aboutRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(128,128,128,0.15);color:var(--text-secondary);"><i class="fas fa-info-circle"></i></div><span class="settings-text">О приложении</span></div>
                    </div>
                </div>
                <div class="settings-group">
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
        <button class="nav-item active" data-sc="screenChats"><i class="fas fa-comments"></i><span>Чаты</span></button>
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
    const fv = $('#fontValue'); if (fv) fv.textContent = { small: 'Мелкий', medium: 'Средний', large: 'Крупный' }[fontSize] || 'Средний';

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
        '<div class="tg-cover-name">' + (p.displayName || 'Пользователь') + '</div>' +
        '<div class="tg-cover-sub">' + (p.username ? '@' + p.username : '') + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="section-label first" style="margin-left:16px;">Личные данные</div>' +
        '<div class="tg-edit-list">' +
        '<div class="form-group"><label>Имя</label><input type="text" class="form-input" id="dnInput" value="' + (p.displayName || '').replace(/"/g, '&quot;') + '"></div>' +
        '<div class="form-group"><label>Username</label><input type="text" class="form-input" id="unInput" placeholder="@username" value="' + (p.username || '').replace(/"/g, '&quot;') + '"></div>' +
        '<div class="form-group"><label>О себе</label><textarea class="form-input" id="bioInput" rows="2">' + (p.bio || '') + '</textarea></div>' +
        '<button class="btn btn-primary" id="saveProfBtn" style="margin-bottom:14px;">Сохранить</button>' +
        '</div>' +
        '<div class="tg-danger-list">' +
        '<div class="tg-danger-row" id="logoutBtn"><i class="fas fa-sign-out-alt"></i> Выйти</div>' +
        '</div>';

    $('#saveProfBtn').onclick = async () => {
        const dn = $('#dnInput')?.value.trim();
        const un = $('#unInput')?.value.trim().replace('@', '');
        if (!dn) return showCustomAlert('Введите имя');
        if (un && !/^[a-zA-Z0-9._]+$/.test(un)) {
            return showCustomAlert('Username может содержать только латинские буквы, цифры, точки и подчёркивания');
        }
        if (un && un !== (currentProfile.username || '')) {
            const snap = await db.collection('users').where('username', '==', un).get();
            if (snap.docs.some(d => d.id !== currentUser.uid)) return showCustomAlert('Username занят');
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

// ==================== INIT CHATS ====================
async function initChats() {
    await loadAllUsers();
    watchMyChats();
    await loadActiveChats();
    renderChatList();
    listenForMessages();
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
function renderChatList() {
    const list = $('#chatList');
    if (!list) return;
    list.innerHTML = '';

    const ids = new Set([...activeChats, ...myChatIds]);
    const sorted = [...ids];
    sorted.sort((a, b) => {
        if (a === GENERAL_CHAT_ID) return -1;
        if (b === GENERAL_CHAT_ID) return 1;
        return (lastMessageTimes[b] || 0) - (lastMessageTimes[a] || 0);
    });

    for (const id of sorted) {
        const isGroup = isGroupLike(id);
        const meta = isGroup ? allChats[id] : allUsers[id];
        if (!meta) continue;

        const name = isGroup ? (meta.name || 'Чат') : (meta.displayName || 'Пользователь');
        const avatarUrl = meta.avatarUrl || '';
        const unread = unreadCounts[id] || 0;
        const preview = lastMessagePreviews[id] || '';
        const time = lastMessageTimes[id] || 0;

        let badge = '';
        if (id === GENERAL_CHAT_ID) badge = '<span class="chat-badge">общий</span>';
        else if (meta.type === 'channel') badge = '<span class="chat-badge">канал</span>';
        else if (meta.type === 'group') badge = '<span class="chat-badge">группа</span>';

        const div = document.createElement('div');
        div.className = 'chat-item';
        div.innerHTML =
            '<div class="avatar">' + (avatarUrl ? '<img src="' + avatarUrl + '">' : initials(name)) + '</div>' +
            '<div class="chat-info">' +
            '<div class="chat-name">' + name + badge + '</div>' +
            '<div class="chat-preview">' + preview + '</div>' +
            '</div>' +
            '<div class="chat-meta">' +
            '<div class="chat-time">' + formatTime(time) + '</div>' +
            (unread > 0 ? '<div style="background:var(--primary);color:white;border-radius:10px;padding:2px 7px;font-size:10px;margin-top:3px;display:inline-block;">' + unread + '</div>' : '') +
            '</div>';
        div.onclick = () => { unreadCounts[id] = 0; openChat(id); };
        list.appendChild(div);
    }
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
    $('#msgName').textContent = name;

    const info = $('#msgInfo');
    const av = $('#msgAv');
    if (info) info.onclick = () => (isGroup ? showChatInfo(id) : viewUserProfile(id));
    if (av) av.onclick = () => (isGroup ? showChatInfo(id) : viewUserProfile(id));
}

// Hides/disables the composer for channels where the current user isn't
// an admin (only admins may post in a channel, like Telegram).
function updateComposerAvailability(id) {
    const row = $('#inputRow');
    const lockedNote = $('#channelLockedNote');
    const replyBar = $('#replyBar');
    if (!row || !lockedNote) return;

    const meta = allChats[id];
    const canPost = !(meta && meta.type === 'channel' && !(meta.admins || []).includes(currentUser.uid));

    if (canPost) {
        row.classList.remove('hidden');
        lockedNote.classList.add('hidden');
    } else {
        row.classList.add('hidden');
        lockedNote.classList.remove('hidden');
        if (replyBar) replyBar.classList.add('hidden');
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
    const groupChat = isGroupLike(currentChat) && currentChat !== GENERAL_CHAT_ID ? (allChats[currentChat] && allChats[currentChat].type === 'group') : (currentChat === GENERAL_CHAT_ID);
    msgs.forEach(msg => {
        const dt = msg.timestamp?.toDate ? msg.timestamp.toDate() : new Date(msg.timestamp);
        const ds = dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        if (ds !== lastDate) {
            const dv = document.createElement('div');
            dv.className = 'date-divider';
            dv.textContent = ds;
            area.appendChild(dv);
            lastDate = ds;
        }
        appendMsg(msg, dt, area, cid, groupChat);
    });
    area.scrollTop = 999999;
}

// ==================== SUBSCRIBE (foreground: the chat that's open) ====================
function subscribe(cid) {
    if (unsubscribeMessages) unsubscribeMessages();
    if (!isGroupLike(currentChat)) watchTyping(cid);

    unsubscribeMessages = db.collection('messages').where('chatId', '==', cid).orderBy('timestamp', 'asc').limit(200).onSnapshot(snap => {
        renderMessagesSnapshot(snap, cid);
    }, err => {
        unsubscribeMessages = db.collection('messages').orderBy('timestamp', 'asc').limit(400).onSnapshot(snap2 => {
            const filtered = { docs: snap2.docs.filter(d => d.data().chatId === cid), forEach(fn) { this.docs.forEach(fn); } };
            renderMessagesSnapshot(filtered, cid);
        });
    });
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

    const groupChat = currentChat === GENERAL_CHAT_ID || (allChats[currentChat] && allChats[currentChat].type === 'group');
    let lastDate = null;
    msgs.forEach(msg => {
        const dt = msg.timestamp?.toDate ? msg.timestamp.toDate() : new Date(msg.timestamp);
        const ds = dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        if (ds !== lastDate) {
            const dv = document.createElement('div');
            dv.className = 'date-divider';
            dv.textContent = ds;
            area.appendChild(dv);
            lastDate = ds;
        }
        appendMsg(msg, dt, area, cid, groupChat);
    });
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

    let firstMine = true;
    unsubscribeMyMessages = db.collection('messages')
        .where('participants', 'array-contains', currentUser.uid)
        .orderBy('timestamp', 'asc')
        .onSnapshot(snap => {
            if (firstMine) { firstMine = false; return; }
            handleIncomingChanges(snap.docChanges());
        }, () => {});

    let firstGeneral = true;
    unsubscribeGeneralMessages = db.collection('messages')
        .where('chatId', '==', GENERAL_CHAT_ID)
        .orderBy('timestamp', 'asc')
        .onSnapshot(snap => {
            if (firstGeneral) { firstGeneral = false; return; }
            handleIncomingChanges(snap.docChanges());
        }, () => {});
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
function appendMsg(m, dt, area, cid, groupChat) {
    const isMine = m.userId === currentUser.uid;
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrap ' + (isMine ? 'sent' : 'received');
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

    wrapper.addEventListener('click', function (e) {
        if (selectionMode) return;
        e.stopPropagation();
        showMessageMenu(m, wrapper, cid, isMine);
    });

    const bubble = document.createElement('div');
    bubble.className = 'msg-bub';

    // In group chats, label who sent each received message (skipped for
    // DMs/channels where it would be redundant or the sender is implicit).
    if (groupChat && !isMine) {
        const sender = allUsers[m.userId];
        const label = document.createElement('div');
        label.className = 'sender-name-label';
        label.textContent = sender ? (sender.displayName || 'Пользователь') : 'Пользователь';
        bubble.appendChild(label);
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
        img.onclick = function (e) { e.stopPropagation(); viewFull(m.imageUrl); };
        bubble.appendChild(img);
    }

    const showReadTicks = isMine && !groupChat;

    if (m.text) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'flex-end';
        row.style.gap = '8px';
        row.style.justifyContent = 'space-between';

        const txt = document.createElement('span');
        txt.textContent = m.text;
        txt.style.flex = '1';
        txt.style.minWidth = '0';
        row.appendChild(txt);

        const timeSpan = document.createElement('span');
        timeSpan.className = 'msg-time';
        timeSpan.style.flexShrink = '0';
        timeSpan.style.minWidth = '35px';
        timeSpan.style.textAlign = 'right';
        timeSpan.textContent = dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

        if (showReadTicks) {
            const isRead = m.readBy && m.readBy.length > 0;
            const check = document.createElement('span');
            check.style.cssText = 'font-size:10px;margin-left:2px;color:' + (isRead ? 'var(--primary)' : 'var(--text-secondary)');
            check.textContent = isRead ? '✓✓' : '✓';
            timeSpan.appendChild(check);
        } else if (isMine) {
            const check = document.createElement('span');
            check.style.cssText = 'font-size:10px;margin-left:2px;color:var(--text-secondary)';
            check.textContent = '✓';
            timeSpan.appendChild(check);
        }
        row.appendChild(timeSpan);
        bubble.appendChild(row);
    } else {
        const timeRow = document.createElement('div');
        timeRow.style.textAlign = 'right';
        const timeSpan = document.createElement('span');
        timeSpan.className = 'msg-time';
        timeSpan.textContent = dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

        if (showReadTicks) {
            const isRead = m.readBy && m.readBy.length > 0;
            const check = document.createElement('span');
            check.style.cssText = 'font-size:10px;margin-left:2px;color:' + (isRead ? 'var(--primary)' : 'var(--text-secondary)');
            check.textContent = isRead ? '✓✓' : '✓';
            timeSpan.appendChild(check);
        } else if (isMine) {
            const check = document.createElement('span');
            check.style.cssText = 'font-size:10px;margin-left:2px;color:var(--text-secondary)';
            check.textContent = '✓';
            timeSpan.appendChild(check);
        }
        timeRow.appendChild(timeSpan);
        bubble.appendChild(timeRow);
    }

    if (m.reactions && Object.keys(m.reactions).length > 0) {
        const reactionRow = document.createElement('div');
        reactionRow.style.cssText = 'display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;max-width:180px;';
        for (const [emoji, users] of Object.entries(m.reactions)) {
            if (!users || !users.length) continue;
            const chip = document.createElement('span');
            chip.className = 'msg-reaction-chip';
            chip.textContent = emoji + ' ' + users.length;
            chip.onclick = function (e) { e.stopPropagation(); toggleReaction(m, emoji); };
            reactionRow.appendChild(chip);
        }
        bubble.appendChild(reactionRow);
    }

    wrapper.appendChild(bubble);
    area.appendChild(wrapper);
}

// ==================== MESSAGE MENU ====================
function showMessageMenu(msg, wrapper, cid, isMine) {
    document.querySelectorAll('.msg-context-menu').forEach(m => m.remove());

    const canDelete = isMine || (allChats[currentChat] && (allChats[currentChat].admins || []).includes(currentUser.uid));

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu';

    const rect = wrapper.getBoundingClientRect();
    if (rect.top < 250) {
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

    const replyBtn = document.createElement('button');
    replyBtn.style.cssText = 'padding:10px 14px;border:none;background:transparent;color:var(--text);font-size:14px;font-family:inherit;width:100%;text-align:left;cursor:pointer;display:flex;align-items:center;gap:8px;';
    replyBtn.innerHTML = '<i class="fas fa-reply"></i> Ответить';
    replyBtn.onclick = function (e) {
        e.stopPropagation();
        const senderName = isMine ? 'Вы' : (allUsers[msg.userId]?.displayName || 'Пользователь');
        setReply(msg.id, msg.text, senderName);
        menu.remove();
    };
    menu.appendChild(replyBtn);

    const reactions = ['👍', '❤️', '😂', '😮', '😡', '🔥', '👏', '🎉', '💯', '😍', '🤔', '🙏'];
    const reactionRow = document.createElement('div');
    reactionRow.style.cssText = 'display:flex;gap:4px;padding:8px 14px;flex-wrap:wrap;';
    reactions.forEach(emoji => {
        const emojiBtn = document.createElement('span');
        emojiBtn.className = 'reaction-emoji-btn';
        emojiBtn.textContent = emoji;
        emojiBtn.onclick = function (e) {
            e.stopPropagation();
            toggleReaction(msg, emoji);
            menu.remove();
        };
        reactionRow.appendChild(emojiBtn);
    });
    menu.appendChild(reactionRow);

    if (canDelete) {
        const deleteBtn = document.createElement('button');
        deleteBtn.style.cssText = 'padding:10px 14px;border:none;background:transparent;color:var(--danger);font-size:14px;font-family:inherit;width:100%;text-align:left;cursor:pointer;display:flex;align-items:center;gap:8px;';
        deleteBtn.innerHTML = '<i class="fas fa-trash"></i> Удалить';
        deleteBtn.onclick = async function (e) {
            e.stopPropagation();
            showCustomConfirm('Удалить сообщение?', async function () {
                await db.collection('messages').doc(msg.id).delete();
                const idx = messageCache[cid]?.findIndex(x => x.id === msg.id);
                if (idx > -1) messageCache[cid].splice(idx, 1);
                wrapper.style.opacity = '0';
                wrapper.style.transform = 'scale(0.8)';
                wrapper.style.transition = '0.2s';
                setTimeout(() => wrapper.remove(), 200);
            });
            menu.remove();
        };
        menu.appendChild(deleteBtn);
    }

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

    await db.collection('messages').doc(msg.id).update({ reactions: reactions });

    const cid = chatIdFor(currentChat);
    if (messageCache[cid]) {
        const msgInCache = messageCache[cid].find(m => m.id === msg.id);
        if (msgInCache) msgInCache.reactions = reactions;
        renderFromCache(cid);
    }
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
    } finally {
        const sendBtn2 = $('#sendBtn');
        if (sendBtn2) sendBtn2.disabled = false;
    }
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

function viewFull(url) {
    const viewer = document.createElement('div');
    viewer.className = 'full-viewer';
    viewer.innerHTML = '<span class="full-viewer-close">✕</span><img src="' + url + '">';
    viewer.onclick = e => {
        if (e.target === viewer || e.target.classList.contains('full-viewer-close')) {
            viewer.remove();
        }
    };
    document.body.appendChild(viewer);
}

// ==================== MARK AS READ ====================
// Fixed to no longer rely on a Firestore "!=" query (chatId == X AND
// userId != me), which needs a composite index that this project never
// had configured — the query silently failed and read receipts never
// actually got written. We now just filter the chat's already-loaded
// messages in memory, which needs no extra index at all.
async function markRead(cid) {
    if (!currentUser || !readReceiptsEnabled) return;
    const msgs = messageCache[cid];
    if (!msgs || !msgs.length) return;
    try {
        const batch = db.batch();
        let any = false;
        msgs.forEach(m => {
            if (m.userId === currentUser.uid) return;
            const readBy = m.readBy || [];
            if (!readBy.includes(currentUser.uid)) {
                readBy.push(currentUser.uid);
                batch.update(db.collection('messages').doc(m.id), { readBy: readBy });
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

    if (isUserOnline(user)) {
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

// ==================== TYPING (DMs only) ====================
function setTyping() {
    if (!currentUser || !currentChat || !currentProfile || isGroupLike(currentChat)) return;
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
        if (isUserOnline(user)) return 'в сети';
        if (user.lastSeen) return 'был(а) ' + formatTime(toMillis(user.lastSeen)).toLowerCase();
        return '';
    }

    body.innerHTML =
        '<div class="tg-cover' + (user.coverUrl ? ' has-photo' : '') + '"' + (user.coverUrl ? ' style="background-image:url(\'' + user.coverUrl + '\')"' : '') + '>' +
        '<div class="avatar">' + (user.avatarUrl ? '<img src="' + user.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : initials(user.displayName)) + '</div>' +
        '<div class="tg-cover-info">' +
        '<div class="tg-cover-name">' + (user.displayName || 'Пользователь') + '</div>' +
        '<div class="tg-cover-sub" id="vpStatus">' + statusText() + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="tg-actions-row">' +
        '<div class="tg-action-btn" id="vpMsgBtn"><div class="circle"><i class="fas fa-comment"></i></div><span>Написать</span></div>' +
        '</div>' +
        '<div class="tg-info-list">' +
        (user.username ? '<div class="tg-info-row"><div class="tg-info-label">Username</div><div class="tg-info-value">@' + user.username + '</div></div>' : '') +
        (user.bio ? '<div class="tg-info-row"><div class="tg-info-label">О себе</div><div class="tg-info-value">' + user.bio + '</div></div>' : '') +
        '</div>';

    $('#vpMsgBtn').onclick = () => {
        if (!activeChats.has(uid)) {
            activeChats.add(uid);
            loadChatPreview(uid, chatIdFor(uid));
        }
        openChat(uid);
    };

    showScreen('screenViewProfile');
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
        $$('.nav-item').forEach((n, i) => n.classList.toggle('active', i === list.indexOf(id)));
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
                const existing = await db.collection('chats').where('username', '==', state.username).get();
                if (!existing.empty) return showCustomAlert('Этот username уже занят');
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
            '<div class="section-label" style="margin-left:16px;">' + memberLabel.charAt(0).toUpperCase() + memberLabel.slice(1) + '</div>' +
            '<div class="tg-info-list" id="ciMemberList"></div>' +
            '<div class="tg-danger-list">' +
            '<div class="tg-danger-row" id="ciLeave"><i class="fas fa-sign-out-alt"></i> Покинуть чат</div>' +
            (isAdmin ? '<div class="tg-danger-row" id="ciDelete"><i class="fas fa-trash"></i> Удалить чат</div>' : '') +
            '</div>';

        const listEl = body.querySelector('#ciMemberList');
        members.forEach(uid => {
            const u = allUsers[uid];
            if (!u) return;
            const row = document.createElement('div');
            row.className = 'member-row';
            row.innerHTML =
                '<div class="avatar">' + (u.avatarUrl ? '<img src="' + u.avatarUrl + '">' : initials(u.displayName)) + '</div>' +
                '<div class="member-row-info"><div class="member-row-name">' + (u.displayName || 'Пользователь') +
                ((meta.admins || []).includes(uid) ? '<span class="role-tag">admin</span>' : '') + '</div>' +
                '<div class="member-row-sub">' + (u.username ? '@' + u.username : '') + '</div></div>';
            row.onclick = () => viewUserProfile(uid, 'screenChatInfo');
            listEl.appendChild(row);
        });

        if (isAdmin) {
            body.querySelector('#ciSave').onclick = async () => {
                const name = body.querySelector('#ciName').value.trim();
                const username = body.querySelector('#ciUsername').value.trim().replace('@', '');
                if (!name) return showCustomAlert('Введите название');
                if (username && !/^[a-zA-Z0-9_]+$/.test(username)) return showCustomAlert('Username: только латинские буквы, цифры и подчёркивания');
                if (username && username !== meta.username) {
                    const existing = await db.collection('chats').where('username', '==', username).get();
                    if (existing.docs.some(d => d.id !== id)) return showCustomAlert('Этот username уже занят');
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

// ==================== SETUP LISTENERS ====================
function setupListeners() {
    $$('.nav-item').forEach(n => n.onclick = () => showScreen(n.dataset.sc));
    $('#backBtn').onclick = () => showScreen('screenChats');
    $('#cancelSelectBtn').onclick = () => toggleSelect();
    $('#deleteSelectedBtn').onclick = deleteSelected;
    $('#newChatBtn').onclick = showCreateChatMenu;

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
        };
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
        const name = (user.displayName || '').toLowerCase();
        const uname = (user.username || '').toLowerCase();
        if (!name.includes(q) && !uname.includes(q)) return;

        const div = document.createElement('div');
        div.className = 'chat-item';
        div.innerHTML = `
            <div class="avatar">${user.avatarUrl ? '<img src="' + user.avatarUrl + '">' : initials(user.displayName)}</div>
            <div class="chat-info">
                <div class="chat-name">${user.displayName || 'Пользователь'}</div>
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
        const badge = chat.type === 'channel' ? '<span class="chat-badge">канал</span>' : '<span class="chat-badge">группа</span>';
        div.innerHTML = `
            <div class="avatar">${chat.avatarUrl ? '<img src="' + chat.avatarUrl + '">' : initials(chat.name)}</div>
            <div class="chat-info">
                <div class="chat-name">${chat.name || 'Чат'} ${badge}</div>
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
                const badge = chat.type === 'channel' ? 'Канал' : 'Группа';
                div.innerHTML = `
                    <div class="avatar">${chat.avatarUrl ? '<img src="' + chat.avatarUrl + '">' : initials(chat.name)}</div>
                    <div class="chat-info">
                        <div class="chat-name">${chat.name || 'Чат'}</div>
                        <div style="font-size:12px;color:var(--primary);">${badge} &middot; @${chat.username}</div>
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
