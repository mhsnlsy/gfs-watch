import json, sys
from pathlib import Path
import numpy as np
from eccodes import codes_grib_new_from_file, codes_get, codes_get_array, codes_release
from detector import detect_centers

def read_mslp(path):
    with open(path,'rb') as f:
        while True:
            gid=codes_grib_new_from_file(f)
            if gid is None: break
            try:
                short=codes_get(gid,'shortName')
                name=codes_get(gid,'name')
                if short in ('prmsl','mslet') or 'mean sea level pressure' in str(name).lower():
                    vals=np.array(codes_get_array(gid,'values'),dtype=float)
                    ni=int(codes_get(gid,'Ni')); nj=int(codes_get(gid,'Nj'))
                    lat0=float(codes_get(gid,'latitudeOfFirstGridPointInDegrees'))
                    lon0=float(codes_get(gid,'longitudeOfFirstGridPointInDegrees'))
                    di=float(codes_get(gid,'iDirectionIncrementInDegrees'))
                    dj=float(codes_get(gid,'jDirectionIncrementInDegrees'))
                    lons=lon0+np.arange(ni)*di
                    lats=lat0-np.arange(nj)*dj
                    vals=vals.reshape((nj,ni))/100.0
                    return vals,lats,lons,{'shortName':short,'name':name,'Ni':ni,'Nj':nj,'lat0':lat0,'lon0':lon0,'di':di,'dj':dj}
            finally:
                codes_release(gid)
    raise RuntimeError('MSLP/prmsl field not found in GRIB2')

def main():
    if len(sys.argv)!=2: raise SystemExit('usage: python grib2_analyze.py FILE')
    p=Path(sys.argv[1])
    v,lats,lons,meta=read_mslp(p)
    centers=detect_centers(v,lats,lons)
    out={'status':'ok','source':'GFS GRIB2','file':p.name,'grid':meta,'analysis':{'center_latitude':41.014,'center_longitude':28.950,'diameter_km':2500,'radius_km':1250,'thresholds':{'low_hpa':1013,'high_hpa':1023},'centers':centers}}
    print(json.dumps(out,ensure_ascii=False,indent=2))

if __name__=='__main__': main()