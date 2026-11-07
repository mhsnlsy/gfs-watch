// Live API gateway shared by the Cloudflare site; GitHub Pages, if opened, uses the same Cloudflare API.
(() => {
  const cloudflareWeb = "https://gfs-watch-web.muhsin-ulusoy.workers.dev";
  const isGitHubPages = window.location.hostname === "github.io" ||
    window.location.hostname.endsWith(".github.io");
  const apiBase = isGitHubPages ? cloudflareWeb : window.location.origin;
  window.GFS_WATCH_API_BASE = apiBase;
  window.ISTANBUL_GFS_API_BASE = apiBase;
})();
