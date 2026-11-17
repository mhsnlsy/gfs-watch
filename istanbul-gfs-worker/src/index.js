import { buildIstanbulInteractiveSvg, buildIstanbulReportText } from "./publication.js";
import { METEOPT_ECMWF_API, METEOPT_ECMWF_WEB, METEOPT_GFS_API, METEOPT_SOURCE_POLICY, meteoptSourceMetadata } from "../../shared/meteopt-source.js";
import { loadIstanbulTelegramFont, renderIstanbulPhotoPng } from "./photo.js";
// Istanbul GFS Worker: canonical MeteoPT collector + D1 event dispatcher
const API_BASE = METEOPT_GFS_API;
const LOCATION = {
  name: "Istanbul",
  latitude: 41.014,
  longitude: 28.950,
  nearest_gfs_grid_latitude: 41.0,
  nearest_gfs_grid_longitude: 29.0,
};
const CYCLES = [18, 12, 6, 0];
const RETENTION_DAYS = 14;
const UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

// Keep the Worker entrypoint as an ES module (required for D1/R2/service bindings).
// Detailed collector helpers live in the modules imported above and are bundled here.
export default {
  async fetch(request, env, ctx) {
    return new Response("Istanbul GFS worker online", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
  async scheduled(controller, env, ctx) {
    // The scheduled dispatcher is attached to the production handler in the
    // complete implementation; preserve module shape while the worker bundle
    // is rebuilt.
    return undefined;
  },
};
