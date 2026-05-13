importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDjuPQ1WX69DvTJJN74CC6L1HAcw5ill2I",
  authDomain: "massanger-2413e.firebaseapp.com",
  projectId: "massanger-2413e",
  storageBucket: "massanger-2413e.firebasestorage.app",
  messagingSenderId: "398845897154",
  appId: "1:398845897154:web:f15d2b9c3fed4eb22f0e5b"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const title = payload.notification.title || 'Quark';
  const options = {
    body: payload.notification.body || 'Новое сообщение',
    icon: 'https://cdn-icons-png.flaticon.com/128/5968/5968866.png'
  };
  self.registration.showNotification(title, options);
});