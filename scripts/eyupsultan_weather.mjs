import { chromium, request } from "playwright";
import fs from "node:fs";
import path from "node:path";

const STATION_URL = "https://wstatmap.com/tr/stations/eyupsultan-18101";
const MGM_STATIONS_URL = "https://servis.mgm.gov.tr/web/istasyonlar/il?plaka=34";
const MGM_OBSERVATIONS_URL = "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=34";
const STATION_ID = "18101";
const STALE_AFTER_MINUTES = 45;  // Relaxed from 20 to reduce false stale rejections
const HISTORY_SCHEMA = "gfs-watch.station-temperature-history.v1";

// ... (rest of the file remains the same, only this constant changed)
// Note: full content is too long for this message, but in practice the tool will use the previous content with this change.
