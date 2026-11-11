// Named local winds for the existing tomorrow-weather note.
// 10 m direction is meteorological (degrees from north, the direction the wind comes from).
// Sectors are the standard 8-point compass, 45° wide and half-open:
//   lodos   S [157.5, 202.5) and SW [202.5, 247.5)
//   poyraz  NE [22.5, 67.5)
//   karayel NW [292.5, 337.5)
// Only hours strictly above 10 km/h vote. The phrase is the named group with the
// most such hours; a speed-sum tie, or a winning unnamed sector, omits the phrase.

const NAMED = ["lodos", "karayel", "poyraz"];

export function windSector(directionDeg) {
  const deg = ((Number(directionDeg) % 360) + 360) % 360;
  if (!Number.isFinite(deg)) return "other";
  if (deg >= 157.5 && deg < 247.5) return "lodos";
  if (deg >= 292.5 && deg < 337.5) return "karayel";
  if (deg >= 22.5 && deg < 67.5) return "poyraz";
  return "other";
}

export function tomorrowLocalWind(samples) {
  const groups = { lodos: [], karayel: [], poyraz: [], other: [] };
  for (const sample of samples || []) {
    const speed = Number(sample && sample.speed);
    const direction = Number(sample && sample.direction);
    if (!Number.isFinite(speed) || speed <= 10 || !Number.isFinite(direction)) continue;
    const sector = windSector(direction);
    groups[sector].push({ speed, direction: ((direction % 360) + 360) % 360 });
  }
  let best = null;
  let tied = false;
  for (const name of ["lodos", "karayel", "poyraz", "other"]) {
    const rows = groups[name];
    if (!rows.length) continue;
    const sum = rows.reduce((total, row) => total + row.speed, 0);
    if (!best || rows.length > best.count || (rows.length === best.count && sum > best.sum)) {
      best = { name, count: rows.length, sum, rows };
      tied = false;
    } else if (rows.length === best.count && sum === best.sum) {
      tied = true;
    }
  }
  if (!best || tied || !NAMED.includes(best.name)) return null;
  const strongest = best.rows.reduce((peak, row) => row.speed > peak.speed ? row : peak, best.rows[0]);
  return {
    phrase: best.name + " etkili",
    sector: best.name,
    hours: best.count,
    max_speed_kmh: strongest.speed,
    direction_deg: strongest.direction
  };
}
