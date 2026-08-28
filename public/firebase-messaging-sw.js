/* Firebase Messaging Service Worker — handles background push notifications */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

try {
  const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "azim-studio-chat.firebaseapp.com",
    projectId: "azim-studio-chat",
    storageBucket: "azim-studio-chat.firebasestorage.app",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
  };

  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage(function (payload) {
    var title = (payload.data && payload.data.title) || 'Azim\'s Space';
    var body  = (payload.data && payload.data.body)  || '';
    var url   = (payload.data && payload.data.url)   || '/';
    var icon  = (payload.data && payload.data.icon)   || 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQoQRdoz6Usc2PKiqexO_C5hT0EHm4G85lNGn-dpHeHzg&s=10';
    var type  = (payload.data && payload.data.type)  || 'general';
    var tag   = 'azim-' + type;

    self.registration.showNotification(title, {
      body: body,
      icon: icon,
      badge: icon,
      tag: tag,
      data: { url: url }
    });
  });
} catch (e) {
  console.error('[FCM SW] Init error:', e);
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
