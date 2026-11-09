# GFS Pressure Centers — isolated Cloudflare Container

This service is intentionally separate from `istanbul-gfs-worker`.

## Purpose
- Accept a real GFS GRIB2 file at `POST /analyze`.
- Read the GFS MSLP/prmsl field with ecCodes.
- Convert Pa to hPa.
- Search a 1250 km radius around Istanbul (2500 km diameter).
- Low threshold: <= 1013 hPa.
- High threshold: >= 1023 hPa.
- Detect local extrema and de-duplicate centers within 150 km.
- Return pressure, coordinates, distance and bearing/direction.

## First deployment
The first test uses the Cloudflare Container `basic` instance and remains isolated from the existing Worker.

## Live GRIB2 test
After deployment:

```bash
curl -X POST --data-binary @gfs.t00z.pgrb2.0p25.f000 \
  -H 'content-type: application/octet-stream' \
  https://<worker-url>/analyze
```

The response must contain `grid.shortName` and `analysis.centers`.

## Production integration
Do not connect this service to the main site until a real GFS GRIB2 test succeeds. The existing MeteoPT-only point forecast path remains untouched.

### Live analysis endpoint

`GET /latest` downloads only the regional MSLP subset from the NOAA NOMADS GFS 0.25° GRIB filter, analyzes the 1,250 km radius around Istanbul, and returns compact JSON for the site.

The service does not download the full global GFS GRIB2 file. NOMADS supports filtering by variable, level, and geographic subregion.