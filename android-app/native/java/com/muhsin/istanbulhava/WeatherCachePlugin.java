package com.muhsin.istanbulhava;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WeatherCache")
public class WeatherCachePlugin extends Plugin {
    @PluginMethod
    public void cacheData(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key and value are required");
            return;
        }
        if (value.length() > 8 * 1024 * 1024) {
            call.reject("JSON payload is too large");
            return;
        }
        try {
            CacheFiles.save(getContext(), key, value);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not cache weather data", error);
        }
    }

    @PluginMethod
    public void getCachedData(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        try {
            String value = CacheFiles.read(getContext(), key);
            JSObject result = new JSObject();
            if (value != null) result.put("value", value);
            else result.put("value", (String) null);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read cached weather data", error);
        }
    }
}