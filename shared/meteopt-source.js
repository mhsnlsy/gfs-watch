// Canonical production weather source for Istanbul Havası.
// Both the Istanbul home page and Köy runtime must use MeteoPT.
// Do not introduce a second GFS/ECMWF provider in production.
export const METEOPT_SOURCE_POLICY = "meteopt-only-v1";
export const METEOPT_GFS_API = "https://api.meteopt.com/gfs/json";
export const METEOPT_GFS_WEB = "https://www.meteopt.com/modelos/gfs";
export const METEOPT_ECMWF_API = "https://api.meteopt.com/ecmwf/json";
export const METEOPT_ECMWF_WEB = "https://www.meteopt.com/modelos/ecmwf";
export const METEOPT_PROVIDER = "MeteoPT";

export function meteoptSourceMetadata(extra = {}) {
  return {
    provider: METEOPT_PROVIDER,
    policy: METEOPT_SOURCE_POLICY,
    gfs_api: METEOPT_GFS_API,
    gfs_web: METEOPT_GFS_WEB,
    ecmwf_api: METEOPT_ECMWF_API,
    ecmwf_web: METEOPT_ECMWF_WEB,
    ...extra,
  };
}
