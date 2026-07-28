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

// ==================== GLOBAL STATE ====================
let currentUser = null;
let currentProfile = null;
let allUsers = {};
let activeChats = new Set();
let currentChat = null;
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
let unsubscribeMessages = null;
let shouldScrollDown = true;
let replyTo = null;
let savedAccounts = JSON.parse(localStorage.getItem('quark_accounts') || '[]');

// --- presence / typing realtime plumbing ---
let unsubscribeUserStatus = null;   // live listener on the open chat partner's profile doc
let unsubscribeTyping = null;       // live listener on the open chat's "typing" doc
let heartbeatInterval = null;       // keeps our own online/lastSeen fresh while the app is open
let statusTickInterval = null;      // periodically re-renders "last seen X ago" without new data

const ONLINE_THRESHOLD_MS = 45000;  // no heartbeat/update for this long => treat user as offline
const HEARTBEAT_INTERVAL_MS = 20000;
const TYPING_TTL_MS = 4000;         // how long a "typing..." doc is considered fresh
const TYPING_STOP_DELAY_MS = 2500;  // how long after the last keystroke we clear our own typing flag

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

// A user only counts as "online" if the flag is set AND we've heard from them
// (via heartbeat) recently. This is what stops a stale `online: true` from a
// crashed tab / closed laptop lid from showing as "online" forever.
function isUserOnline(user) {
    if (!user || !user.online) return false;
    if (!user.lastSeen) return true;
    return (Date.now() - toMillis(user.lastSeen)) < ONLINE_THRESHOLD_MS;
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
    const scales = { small: '0.9', medium: '1.0', large: '1.15' };
    document.documentElement.style.zoom = scales[fontSize] || '1.0';
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
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:200;';

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
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:200;';

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
// heartbeat/status timers and our own typing flag. Used by logout,
// account switching and adding a new account.
function teardownSession() {
    if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
    if (unsubscribeUserStatus) { unsubscribeUserStatus(); unsubscribeUserStatus = null; }
    if (unsubscribeTyping) { unsubscribeTyping(); unsubscribeTyping = null; }
    stopHeartbeat();
    if (statusTickInterval) { clearInterval(statusTickInterval); statusTickInterval = null; }
    if (currentUser && currentChat) {
        const cid = [currentUser.uid, currentChat].sort().join('_');
        clearTyping(cid);
    }
    currentUser = null;
    currentProfile = null;
    allUsers = {};
    activeChats = new Set();
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
// Firestore (unlike the Realtime Database) has no built-in "onDisconnect",
// so we fake reliable presence with three pieces working together:
//   1) a heartbeat that refreshes lastSeen/online while the tab is open,
//   2) visibility/unload hooks that mark us offline as soon as we can tell,
//   3) isUserOnline() treating a stale lastSeen as offline regardless of the
//      `online` flag, so a crashed tab or lost connection can't get "stuck"
//      showing green forever.
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

// ==================== MAIN UI ====================
function buildMainUI() {
    $('#bottomNav').classList.remove('hidden');
    $('#mainContent').innerHTML = `
        <div class="screen active" id="screenChats">
            <div class="header"><span style="font-weight:700;font-size:19px;color:var(--text);">Quark</span></div>
            <div class="chat-scroll">
                <div class="search-box">
                    <div class="search-wrapper"><i class="fas fa-search"></i><input type="text" class="search-input" id="searchInput" placeholder="Поиск..."></div>
                </div>
                <div id="chatList"></div>
            </div>
        </div>
        <div class="screen" id="screenMessages">
            <div class="header">
                <button class="icon-button" id="backBtn"><i class="fas fa-arrow-left"></i></button>
                <button class="icon-button" id="cancelSelectBtn" style="display:none;"><i class="fas fa-times"></i></button>
                <div class="avatar" id="msgAv" style="width:34px;height:34px;font-size:12px;"></div>
                <div style="flex:1;min-width:0;" id="msgInfo">
                    <div style="font-weight:600;font-size:15px;color:var(--text);" id="msgName"></div>
                    <div style="font-size:11px;color:var(--text-secondary);" id="msgTyping"></div>
                </div>
                <button class="icon-button" id="deleteSelectedBtn" style="display:none;color:var(--danger);"><i class="fas fa-trash"></i></button>
            </div>
            <div class="msg-area" id="msgArea"><div class="empty-state"><i class="far fa-comments"></i><p>Выберите чат</p></div></div>
            <div class="input-container">
                <div class="reply-bar hidden" id="replyBar"><div class="reply-preview" id="replyPreview"></div><span class="reply-close" id="replyClose">✕</span></div>
                <div class="input-row">
                    <button class="icon-button" id="attachBtn"><i class="fas fa-paperclip"></i></button>
                    <textarea class="msg-input" id="msgInput" placeholder="Сообщение..." rows="1"></textarea>
                    <button class="send-btn" id="sendBtn"><i class="fas fa-paper-plane"></i></button>
                </div>
            </div>
        </div>
        <div class="screen" id="screenProfile">
            <div class="header"><span style="font-weight:700;font-size:18px;color:var(--text);"><i class="fas fa-user-circle"></i> Профиль</span></div>
            <div class="profile-scroll">
                <div class="profile-card">
                    <div class="profile-avatar-wrap"><div class="avatar" id="profAv"></div><div class="profile-avatar-edit" id="avEditBtn"><i class="fas fa-camera"></i></div></div>
                    <div class="profile-name" id="profName"></div>
                    <div class="profile-username" id="profUser"></div>
                    <div class="profile-bio" id="profBio"></div>
                    <div class="form-group"><label>Имя</label><input type="text" class="form-input" id="dnInput"></div>
                    <div class="form-group"><label>Username</label><input type="text" class="form-input" id="unInput" placeholder="@username"></div>
                    <div class="form-group"><label>О себе</label><textarea class="form-input" id="bioInput" rows="2"></textarea></div>
                    <button class="btn btn-primary" id="saveProfBtn">Сохранить</button>
                    <button class="btn btn-danger" id="logoutBtn"><i class="fas fa-sign-out-alt"></i> Выйти</button>
                </div>
            </div>
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
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(16,185,129,0.15);color:#10B981;"><i class="fas fa-volume-up"></i></div><span class="settings-text">Звук</span></div>
                        <div class="toggle" id="soundToggle"></div>
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-row" id="switchAccountRow">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(124,77,255,0.15);color:var(--primary);"><i class="fas fa-exchange-alt"></i></div><span class="settings-text">Сменить аккаунт</span></div>
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-row" id="settLogout">
                        <div class="settings-left"><div class="settings-icon" style="background:rgba(239,68,68,0.15);color:var(--danger);"><i class="fas fa-sign-out-alt"></i></div><span class="settings-text" style="color:var(--danger);">Выйти</span></div>
                    </div>
                </div>
            </div>
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

    const modal = document.createElement('div');
    modal.className = 'modal-overlay hidden';
    modal.id = 'userModal';
    modal.innerHTML =
        '<div class="modal">' +
        '<div class="avatar" id="umAv"></div>' +
        '<h3 id="umName"></h3>' +
        '<div class="modal-username" id="umUser"></div>' +
        '<div class="modal-bio" id="umBio"></div>' +
        '<button class="btn btn-primary" id="umMsgBtn"><i class="fas fa-comment"></i> Написать</button>' +
        '<button class="btn btn-danger" id="umCloseBtn">Закрыть</button>' +
        '</div>';
    document.body.appendChild(modal);

    updateProfileUI();
    applyFontSize();
    applyTheme();

    const dt = $('#darkToggle'); if (dt) dt.classList.toggle('active', darkMode);
    const st = $('#soundToggle'); if (st) st.classList.toggle('active', soundEnabled);
    const fv = $('#fontValue'); if (fv) fv.textContent = { small: 'Мелкий', medium: 'Средний', large: 'Крупный' }[fontSize] || 'Средний';

    setupListeners();

    // Refresh "online / last seen X" text periodically even when no new
    // Firestore snapshot arrives — otherwise a stale "В сети" would linger
    // on screen until the next update from the server.
    if (statusTickInterval) clearInterval(statusTickInterval);
    statusTickInterval = setInterval(() => {
        if (currentChat) updateStatusDisplay();
    }, 15000);
}

function updateProfileUI() {
    const p = currentProfile || {};
    $('#profName').textContent = p.displayName || 'Пользователь';
    $('#profUser').textContent = p.username ? '@' + p.username : '';
    $('#profBio').textContent = p.bio || '';
    $('#dnInput').value = p.displayName || '';
    $('#unInput').value = p.username || '';
    $('#bioInput').value = p.bio || '';
    $('#profAv').innerHTML = p.avatarUrl ? '<img src="' + p.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : '<i class="fas fa-user"></i>';
}

// ==================== INIT CHATS ====================
async function initChats() {
    await loadAllUsers();
    await loadActiveChats();
    renderChatList();
    listenForMessages();
    setTimeout(initPush, 2000);
}

async function loadAllUsers() {
    const snap = await db.collection('users').get();
    allUsers = {};
    snap.forEach(doc => { allUsers[doc.id] = { id: doc.id, ...doc.data() }; });
}

async function loadActiveChats() {
    activeChats = new Set();
    const snap = await db.collection('messages').where('userId', '==', currentUser.uid).get();
    snap.forEach(doc => {
        const msg = doc.data();
        if (!msg.chatId || msg.chatId === 'general') return;
        const parts = msg.chatId.split('_');
        const other = parts.find(p => p !== currentUser.uid);
        if (other && allUsers[other]) activeChats.add(other);
    });
    for (const uid of activeChats) {
        await loadChatPreview(uid);
    }
}

async function loadChatPreview(uid) {
    const cid = [currentUser.uid, uid].sort().join('_');
    if (messageCache[cid]) return;
    try {
        const snap = await db.collection('messages').where('chatId', '==', cid).orderBy('timestamp', 'asc').limit(50).get();
        const msgs = [];
        snap.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
        messageCache[cid] = msgs;
        if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            lastMessagePreviews[uid] = last.imageUrl ? '<i class="fas fa-image"></i> Фото' : (last.text || '').substring(0, 30);
            const ts = last.timestamp?.toDate();
            if (ts) lastMessageTimes[uid] = ts.getTime();
        }
    } catch (e) {}
}

// ==================== CHAT LIST ====================
function renderChatList() {
    const list = $('#chatList');
    if (!list) return;
    list.innerHTML = '';

    const sorted = [...activeChats];
    sorted.sort((a, b) => (lastMessageTimes[b] || 0) - (lastMessageTimes[a] || 0));

    for (const uid of sorted) {
        const user = allUsers[uid];
        if (!user) continue;

        const unread = unreadCounts[uid] || 0;
        const preview = lastMessagePreviews[uid] || '';
        const time = lastMessageTimes[uid] || 0;

        const div = document.createElement('div');
        div.className = 'chat-item';
        div.innerHTML =
            '<div class="avatar">' + (user.avatarUrl ? '<img src="' + user.avatarUrl + '">' : (user.displayName || 'П')[0].toUpperCase()) + '</div>' +
            '<div class="chat-info">' +
            '<div class="chat-name">' + (user.displayName || 'Пользователь') + '</div>' +
            '<div class="chat-preview">' + preview + '</div>' +
            '</div>' +
            '<div class="chat-meta">' +
            '<div class="chat-time">' + formatTime(time) + '</div>' +
            (unread > 0 ? '<div style="background:var(--primary);color:white;border-radius:10px;padding:2px 7px;font-size:10px;margin-top:3px;display:inline-block;">' + unread + '</div>' : '') +
            '</div>';
        div.onclick = () => { unreadCounts[uid] = 0; openChat(uid); };
        list.appendChild(div);
    }
}

// ==================== OPEN CHAT ====================
function openChat(uid) {
    // Leaving the previous chat: stop announcing "typing" there and drop the
    // stale typing-listener before wiring up the new one.
    if (currentUser && currentChat && currentChat !== uid) {
        const oldCid = [currentUser.uid, currentChat].sort().join('_');
        clearTyping(oldCid);
    }

    currentChat = uid;
    unreadCounts[uid] = 0;
    selectionMode = false;
    selectedMessages.clear();

    const user = allUsers[uid];
    if (!user) return;

    $('#msgAv').innerHTML = user.avatarUrl ? '<img src="' + user.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : (user.displayName || 'П')[0].toUpperCase();
    $('#msgName').textContent = user.displayName || 'Пользователь';
    watchUserStatus(uid);
    updateStatusDisplay();

    $('#cancelSelectBtn').style.display = 'none';
    $('#deleteSelectedBtn').style.display = 'none';

    const cid = [currentUser.uid, uid].sort().join('_');
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
        appendMsg(msg, dt, area, cid);
    });
    area.scrollTop = 999999;
}

// ==================== SUBSCRIBE ====================
function subscribe(cid) {
    if (unsubscribeMessages) unsubscribeMessages();
    watchTyping(cid);

    unsubscribeMessages = db.collection('messages').where('chatId', '==', cid).orderBy('timestamp', 'asc').limit(100).onSnapshot(snap => {
        renderMessagesSnapshot(snap, cid);
    }, err => {
        // Fallback for setups without the composite index this query needs.
        unsubscribeMessages = db.collection('messages').orderBy('timestamp', 'asc').limit(200).onSnapshot(snap2 => {
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
        appendMsg(msg, dt, area, cid);
    });
    area.scrollTop = 999999;

    const parts = cid.split('_');
    const uid = parts.find(p => p !== currentUser.uid);
    if (uid && msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        lastMessagePreviews[uid] = last.imageUrl ? '<i class="fas fa-image"></i> Фото' : (last.text || '').substring(0, 30);
        const ts = last.timestamp?.toDate();
        if (ts) lastMessageTimes[uid] = ts.getTime();
        renderChatList();
    }
}

// ==================== APPEND MSG ====================
function appendMsg(m, dt, area, cid) {
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

        if (isMine) {
            const isRead = m.readBy && m.readBy.length > 0;
            const check = document.createElement('span');
            check.style.cssText = 'font-size:10px;margin-left:2px;color:' + (isRead ? 'var(--primary)' : 'var(--text-secondary)');
            check.textContent = isRead ? '✓✓' : '✓';
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

        if (isMine) {
            const isRead = m.readBy && m.readBy.length > 0;
            const check = document.createElement('span');
            check.style.cssText = 'font-size:10px;margin-left:2px;color:' + (isRead ? 'var(--primary)' : 'var(--text-secondary)');
            check.textContent = isRead ? '✓✓' : '✓';
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

    if (isMine) {
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

    const cid = [currentUser.uid, currentChat].sort().join('_');
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
    const input = $('#msgInput');
    const text = input.value.trim();
    const file = $('#fileInput')?.files[0];
    if (!text && !file) return;

    const sendBtn = $('#sendBtn');
    if (sendBtn) sendBtn.disabled = true;
    shouldScrollDown = true;

    const cid = [currentUser.uid, currentChat].sort().join('_');

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

        await db.collection('messages').add({
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
        });

        // We just sent a message — stop announcing "typing..." right away
        // instead of waiting for the debounce timeout to expire.
        clearTyping(cid);

        if (!activeChats.has(currentChat)) {
            activeChats.add(currentChat);
            await loadChatPreview(currentChat);
        }
        cancelReply();
        if (input) {
            input.value = '';
            input.style.height = 'auto';
            input.focus();
            input.click();
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
async function markRead(cid) {
    if (!currentUser) return;
    try {
        const snap = await db.collection('messages')
            .where('chatId', '==', cid)
            .where('userId', '!=', currentUser.uid)
            .get();

        const batch = db.batch();
        snap.forEach(doc => {
            const readBy = doc.data().readBy || [];
            if (!readBy.includes(currentUser.uid)) {
                readBy.push(currentUser.uid);
                batch.update(doc.ref, { readBy: readBy });
            }
        });
        await batch.commit();
    } catch (e) {}
}

// ==================== STATUS ====================
function updateStatusDisplay() {
    if (!currentChat) return;
    const user = allUsers[currentChat];
    if (!user) return;

    const mt = $('#msgTyping');
    if (!mt) return;

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

// Live-updates allUsers[uid] and the status line whenever the chat
// partner's profile document changes (online flag, lastSeen, name, avatar…),
// instead of relying on the one-time snapshot taken at app start.
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

// ==================== TYPING ====================
// Called on every keystroke in the message box. Writes a short-lived
// "typing" doc for the open chat, and schedules it to be cleared a couple
// of seconds after the user stops typing.
function setTyping() {
    if (!currentUser || !currentChat || !currentProfile) return;
    const cid = [currentUser.uid, currentChat].sort().join('_');

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

// Watches the "typing" doc for one chat. Unlike before, we now (a) tear
// down the previous listener before attaching a new one instead of piling
// listeners up across chat switches, and (b) verify the snapshot still
// belongs to the chat that's actually open before touching the DOM — a
// leftover listener from a chat you've since left can no longer paint a
// stale "печатает..." / "В сети" over whatever chat you're looking at now.
function watchTyping(cid) {
    if (unsubscribeTyping) {
        unsubscribeTyping();
        unsubscribeTyping = null;
    }
    unsubscribeTyping = db.collection('typing').doc(cid).onSnapshot(doc => {
        const activeCid = currentChat ? [currentUser.uid, currentChat].sort().join('_') : null;
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

// ==================== LISTEN FOR MESSAGES ====================
function listenForMessages() {
    let firstLoad = true;
    db.collection('messages').orderBy('timestamp', 'asc').onSnapshot(snap => {
        if (firstLoad) {
            firstLoad = false;
            return;
        }
        let needsUpdate = false;
        snap.docChanges().forEach(change => {
            if (change.type !== 'added') return;
            const msg = change.doc.data();
            if (msg.userId === currentUser.uid || !msg.timestamp) return;

            const cid = msg.chatId;
            if (!cid || cid === 'general') return;
            const parts = cid.split('_');
            const other = parts.find(p => p !== currentUser.uid);
            if (!other) return;

            if (!activeChats.has(other) && allUsers[other]) {
                activeChats.add(other);
                loadChatPreview(other);
                needsUpdate = true;
            }

            const curCid = currentChat ? [currentUser.uid, currentChat].sort().join('_') : '';
            if (cid !== curCid) {
                unreadCounts[other] = (unreadCounts[other] || 0) + 1;
                needsUpdate = true;
                playSound();
            }
        });
        if (needsUpdate) renderChatList();
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
        const cid = [currentUser.uid, currentChat].sort().join('_');
        if (messageCache[cid]) renderFromCache(cid);
    }
}

async function deleteSelected() {
    if (!selectedMessages.size) return;
    showCustomConfirm('Удалить ' + selectedMessages.size + ' сообщений?', async function () {
        const cid = [currentUser.uid, currentChat].sort().join('_');
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
function viewUserProfile(uid) {
    if (uid === currentUser.uid) {
        showScreen('screenProfile');
        return;
    }
    const user = allUsers[uid];
    if (!user) return;

    const modal = $('#userModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    $('#umAv').innerHTML = user.avatarUrl
        ? '<img src="' + user.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">'
        : (user.displayName || 'П')[0].toUpperCase();
    $('#umName').textContent = user.displayName || 'Пользователь';
    $('#umUser').textContent = user.username ? '@' + user.username : '';
    $('#umBio').textContent = user.bio || '';
    $('#umMsgBtn').onclick = () => {
        if (!activeChats.has(uid)) {
            activeChats.add(uid);
            loadChatPreview(uid);
        }
        openChat(uid);
        modal.classList.add('hidden');
    };
    $('#umCloseBtn').onclick = () => modal.classList.add('hidden');
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

    const isMsg = id === 'screenMessages';
    const bn = $('#bottomNav');
    if (bn) {
        if (isMsg) bn.classList.add('hidden');
        else bn.classList.remove('hidden');
    }
    if (!isMsg) {
        const list = ['screenChats', 'screenProfile', 'screenSettings'];
        $$('.nav-item').forEach((n, i) => n.classList.toggle('active', i === list.indexOf(id)));
    }
    if (id === 'screenProfile') updateProfileUI();
}

// ==================== SETUP LISTENERS ====================
function setupListeners() {
    $$('.nav-item').forEach(n => n.onclick = () => showScreen(n.dataset.sc));
    $('#backBtn').onclick = () => showScreen('screenChats');
    $('#cancelSelectBtn').onclick = () => toggleSelect();
    $('#deleteSelectedBtn').onclick = deleteSelected;
    $('#sendBtn').onclick = sendMsg;

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

    $('#attachBtn').onclick = function (e) {
        e.stopPropagation();
        e.preventDefault();
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
        updateProfileUI();
        await loadAllUsers();
        renderChatList();
        showCustomAlert('✅ Сохранено');
    };

    const avatarInput = document.createElement('input');
    avatarInput.type = 'file';
    avatarInput.accept = 'image/*';
    avatarInput.className = 'hidden';
    document.body.appendChild(avatarInput);
    $('#avEditBtn').onclick = () => avatarInput.click();
    avatarInput.onchange = async () => {
        const file = avatarInput.files[0];
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
        updateProfileUI();
        await loadAllUsers();
        renderChatList();
    };

    $('#logoutBtn').onclick = logout;
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

    const searchInput = $('#searchInput');
    if (searchInput) {
        searchInput.oninput = function () {
            const q = this.value.toLowerCase();
            if (!q) { renderChatList(); return; }

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
                    <div class="avatar">
                        ${user.avatarUrl ? '<img src="' + user.avatarUrl + '">' : (user.displayName || 'П')[0].toUpperCase()}
                    </div>
                    <div class="chat-info">
                        <div class="chat-name">${user.displayName || 'Пользователь'}</div>
                        ${user.username ? '<div style="font-size:12px;color:var(--primary);">@' + user.username + '</div>' : ''}
                    </div>
                `;
                div.onclick = () => {
                    if (!activeChats.has(user.id)) {
                        activeChats.add(user.id);
                        loadChatPreview(user.id);
                    }
                    openChat(user.id);
                };
                list.appendChild(div);
            });
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
        const attachBtn = $('#attachBtn');
        if (attachMenu && !attachMenu.contains(e.target) && e.target !== attachBtn && !attachBtn?.contains(e.target)) {
            attachMenu.classList.remove('show');
        }
        if (e.target === $('#userModal')) {
            $('#userModal')?.classList.add('hidden');
        }
        document.querySelectorAll('.msg-context-menu').forEach(m => {
            if (!m.contains(e.target)) m.remove();
        });
    });
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
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:200;';

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
            (account.avatarUrl ? '<img src="' + account.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;">' : (account.displayName || account.email || '?')[0].toUpperCase()) +
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
