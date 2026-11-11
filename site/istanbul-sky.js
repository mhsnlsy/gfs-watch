// Civil sunrise/sunset (geometric solar elevation −0.833°) and an 8-phase moon
// for Istanbul. Local civil time is Europe/Istanbul, UTC+3, no DST.

export const ISTANBUL_LATITUDE = 41.015;
export const ISTANBUL_LONGITUDE = 28.95;
export const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const CIVIL_ZENITH = 90.833;
const SYNODIC_MONTH_DAYS = 29.530588853;
const KNOWN_NEW_MOON_UTC = Date.UTC(2000, 0, 6, 18, 14, 0);

export const MOON_PHASES = [
  "Yeni ay",
  "Hilal",
  "İlk dördün",
  "Şişkin ay",
  "Dolunay",
  "Küçülen şişkin ay",
  "Son dördün",
  "Küçülen hilal"
];

function deg2rad(value) {
  return value * Math.PI / 180;
}

function rad2deg(value) {
  return value * 180 / Math.PI;
}

function julianDay(year, month, day) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + B - 1524.5;
}

function julianCent(jd) {
  return (jd - 2451545.0) / 36525.0;
}

function geomMeanLongSun(t) {
  let L0 = 280.46646 + t * (36000.76983 + 0.0003032 * t);
  L0 %= 360;
  if (L0 < 0) L0 += 360;
  return L0;
}

function geomMeanAnomalySun(t) {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t);
}

function eccentricityEarthOrbit(t) {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
}

function sunEqOfCenter(t) {
  const m = deg2rad(geomMeanAnomalySun(t));
  return Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
}

function sunTrueLong(t) {
  return geomMeanLongSun(t) + sunEqOfCenter(t);
}

function sunApparentLong(t) {
  const omega = 125.04 - 1934.136 * t;
  return sunTrueLong(t) - 0.00569 - 0.00478 * Math.sin(deg2rad(omega));
}

function meanObliquity(t) {
  const seconds = 21.448 - t * (46.8150 + t * (0.00059 - t * 0.001813));
  return 23 + (26 + seconds / 60) / 60;
}

function obliquityCorrection(t) {
  const omega = 125.04 - 1934.136 * t;
  return meanObliquity(t) + 0.00256 * Math.cos(deg2rad(omega));
}

function sunDeclination(t) {
  const e = obliquityCorrection(t);
  const lambda = sunApparentLong(t);
  return rad2deg(Math.asin(Math.sin(deg2rad(e)) * Math.sin(deg2rad(lambda))));
}

function equationOfTime(t) {
  const epsilon = obliquityCorrection(t);
  const l0 = geomMeanLongSun(t);
  const e = eccentricityEarthOrbit(t);
  const m = geomMeanAnomalySun(t);
  const y = Math.tan(deg2rad(epsilon) / 2);
  const yy = y * y;
  return rad2deg(
    yy * Math.sin(2 * deg2rad(l0)) -
    2 * e * Math.sin(deg2rad(m)) +
    4 * e * yy * Math.sin(deg2rad(m)) * Math.cos(2 * deg2rad(l0)) -
    0.5 * yy * yy * Math.sin(4 * deg2rad(l0)) -
    1.25 * e * e * Math.sin(2 * deg2rad(m))
  ) * 4;
}

function hourAngleSunrise(latitude, declination) {
  const lat = deg2rad(latitude);
  const dec = deg2rad(declination);
  const cosH = Math.cos(deg2rad(CIVIL_ZENITH)) / (Math.cos(lat) * Math.cos(dec)) - Math.tan(lat) * Math.tan(dec);
  return Math.acos(Math.max(-1, Math.min(1, cosH)));
}

function sunriseSetUtcMinutes(rise, year, month, day, latitude, longitude) {
  const jd = julianDay(year, month, day);
  const t = julianCent(jd);
  const noonMinutes = 720 - 4 * longitude - equationOfTime(t);
  const jdNoon = jd + noonMinutes / 1440;
  const tNoon = julianCent(jdNoon);
  const declination = sunDeclination(tNoon);
  const eqTime = equationOfTime(tNoon);
  let hourAngle = rad2deg(hourAngleSunrise(latitude, declination));
  if (!rise) hourAngle = -hourAngle;
  return 720 - 4 * (longitude + hourAngle) - eqTime;
}

function minutesToInstant(year, month, day, utcMinutes) {
  const midnight = Date.UTC(year, month - 1, day, 0, 0, 0);
  return new Date(midnight + utcMinutes * 60000);
}

export function istanbulParts(date) {
  const shifted = new Date(date.getTime() + ISTANBUL_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function addDays(year, month, day, delta) {
  const utc = new Date(Date.UTC(year, month - 1, day) + delta * 86400000);
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate()
  };
}

export function sunriseOn(year, month, day, latitude = ISTANBUL_LATITUDE, longitude = ISTANBUL_LONGITUDE) {
  return minutesToInstant(year, month, day, sunriseSetUtcMinutes(true, year, month, day, latitude, longitude));
}

export function sunsetOn(year, month, day, latitude = ISTANBUL_LATITUDE, longitude = ISTANBUL_LONGITUDE) {
  return minutesToInstant(year, month, day, sunriseSetUtcMinutes(false, year, month, day, latitude, longitude));
}

export function formatIstanbulClock(date) {
  const shifted = new Date(date.getTime() + ISTANBUL_OFFSET_MS);
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  return hour + ":" + minute;
}

export function moonAgeDays(date) {
  const days = (date.getTime() - KNOWN_NEW_MOON_UTC) / 86400000;
  return ((days % SYNODIC_MONTH_DAYS) + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS;
}

export function moonPhase(date) {
  const age = moonAgeDays(date);
  const fraction = age / SYNODIC_MONTH_DAYS;
  const index = Math.floor(fraction * 8 + 0.5) % 8;
  return {
    name: MOON_PHASES[index],
    index,
    age_days: age,
    fraction,
    waxing: index > 0 && index < 4
  };
}

export function moonPhaseSvg(date) {
  const phase = moonPhase(date);
  const r = 9;
  const cx = 12;
  const cy = 12;
  const mag = Math.cos(phase.fraction * 2 * Math.PI);
  const rx = Math.max(0.15, Math.abs(mag) * r);
  const waxing = phase.fraction < 0.5;
  const lightOnRight = waxing;
  const sweep = lightOnRight ? 1 : 0;
  const terminatorSweep = mag > 0 ? (lightOnRight ? 1 : 0) : (lightOnRight ? 0 : 1);
  const isNewMoon = phase.index === 0;
  const lit = !isNewMoon && phase.fraction > 0.02 && phase.fraction < 0.98;
  const path = lit
    ? "M " + cx + " " + (cy - r) +
      " A " + r + " " + r + " 0 0 " + sweep + " " + cx + " " + (cy + r) +
      " A " + rx.toFixed(3) + " " + r + " 0 0 " + terminatorSweep + " " + cx + " " + (cy - r) + " Z"
    : "";
  const base = isNewMoon ? "#07151f" : "#8e9ca5";
  const light = "#e9edf0";
  const id = "moonTex_" + Math.round(date.getTime() / 60000);
  return "<svg class=\"moon-phase-svg moon-realistic\" viewBox=\"0 0 24 24\" width=\"42\" height=\"42\" aria-hidden=\"true\">" +
    "<defs>" +
      "<radialGradient id=\"" + id + "_g\" cx=\"35%\" cy=\"30%\" r=\"75%\"><stop offset=\"0\" stop-color=\"" + (isNewMoon ? "#10222e" : "#b8c2c8") + "\"/><stop offset=\"1\" stop-color=\"" + base + "\"/></radialGradient>" +
      "<clipPath id=\"" + id + "_c\"><circle cx=\"12\" cy=\"12\" r=\"9\"/></clipPath>" +
    "</defs>" +
    "<circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"url(#" + id + "_g)\"/>" +
    "<g clip-path=\"url(#" + id + "_c)\" opacity=\".42\" fill=\"#46535b\">" +
      "<circle cx=\"7.2\" cy=\"8.1\" r=\"1.35\"/><circle cx=\"15.8\" cy=\"6.8\" r=\".9\"/><circle cx=\"16.7\" cy=\"14.8\" r=\"1.5\"/><circle cx=\"9.5\" cy=\"16.2\" r=\"1.05\"/><circle cx=\"5.9\" cy=\"13.2\" r=\".7\"/>" +
    "</g>" +
    (path ? "<path fill=\"" + light + "\" d=\"" + path + "\"/>" : "") +
    (lit ? "<g clip-path=\"url(#" + id + "_c)\" opacity=\".28\" fill=\"#68747c\"><circle cx=\"8\" cy=\"9\" r=\"1.1\"/><circle cx=\"15\" cy=\"15\" r=\".8\"/></g>" : "") +
    "</svg>";
}
export function istanbulSky(date = new Date(), latitude = ISTANBUL_LATITUDE, longitude = ISTANBUL_LONGITUDE) {
  const today = istanbulParts(date);
  const yesterday = addDays(today.year, today.month, today.day, -1);
  const tomorrow = addDays(today.year, today.month, today.day, 1);
  const riseToday = sunriseOn(today.year, today.month, today.day, latitude, longitude);
  const setToday = sunsetOn(today.year, today.month, today.day, latitude, longitude);
  const riseTomorrow = sunriseOn(tomorrow.year, tomorrow.month, tomorrow.day, latitude, longitude);
  const setYesterday = sunsetOn(yesterday.year, yesterday.month, yesterday.day, latitude, longitude);
  const now = date.getTime();
  let sunrise = riseToday;
  let sunset = setToday;
  let night = false;
  if (now < riseToday.getTime()) {
    night = true;
    sunrise = riseToday;
    sunset = setYesterday;
  } else if (now >= setToday.getTime()) {
    night = true;
    sunrise = riseTomorrow;
    sunset = setToday;
  }
  const phase = moonPhase(date);
  return {
    sunrise,
    sunset,
    sunrise_label: formatIstanbulClock(sunrise),
    sunset_label: formatIstanbulClock(sunset),
    text: "Gün doğumu " + formatIstanbulClock(sunrise) + " · Gün batımı " + formatIstanbulClock(sunset),
    night,
    moon: phase
  };
}

if (typeof window !== "undefined") {
  window.IstanbulSky = {
    istanbulSky,
    moonPhase,
    moonPhaseSvg,
    sunriseOn,
    sunsetOn,
    formatIstanbulClock
  };
}
