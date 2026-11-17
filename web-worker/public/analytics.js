(function () {
  "use strict";
  var COOKIE = "ih_session";
  var MAX_AGE = 31536000;
  var session = null;

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(";") : [];
    for (var i = 0; i < parts.length; i++) {
      var item = parts[i].trim();
      if (item.indexOf(name + "=") === 0) return decodeURIComponent(item.slice(name.length + 1));
    }
    return null;
  }

  function getSession() {
    if (session) return session;
    session = readCookie(COOKIE);
    if (!session) {
      try { session = crypto.randomUUID(); }
      catch (_) { session = Date.now().toString(36) + Math.random().toString(36).slice(2); }
      document.cookie = COOKIE + "=" + encodeURIComponent(session) +
        "; Max-Age=" + MAX_AGE + "; Path=/; SameSite=Lax; Secure";
    }
    return session;
  }

  function send(type) {
    var payload = {
      type: type,
      session_id: getSession(),
      path: location.pathname + location.search,
      referrer: document.referrer || ""
    };
    try {
      fetch("/api/analytics/event", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
        credentials: "same-origin",
        keepalive: true
      }).catch(function () {});
    } catch (_) {}
  }

  send("pageview");
  window.setInterval(function () { send("heartbeat"); }, 30000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") send("heartbeat");
  });
})();