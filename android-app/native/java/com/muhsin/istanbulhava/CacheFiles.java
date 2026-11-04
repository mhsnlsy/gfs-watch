package com.muhsin.istanbulhava;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public final class CacheFiles {
    private CacheFiles() {}

    private static File resolve(Context context, String key) throws Exception {
        if (key == null || key.isEmpty() || key.startsWith("/") ||
                key.contains("..") || key.indexOf('\\\\') >= 0 ||
                !key.matches("[A-Za-z0-9._/-]+")) {
            throw new IllegalArgumentException("Invalid cache key");
        }
        File root = new File(context.getFilesDir(), "weather-cache");
        File target = new File(root, key);
        String rootPath = root.getCanonicalPath() + File.separator;
        if (!target.getCanonicalPath().startsWith(rootPath)) {
            throw new IllegalArgumentException("Cache path escapes root");
        }
        return target;
    }

    public static void save(Context context, String key, String value) throws Exception {
        File target = resolve(context, key);
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IllegalStateException("Could not create cache directory");
        }
        File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(bytes);
            output.flush();
            output.getFD().sync();
        }
        if (target.exists() && !target.delete()) {
            temporary.delete();
            throw new IllegalStateException("Could not replace cache file");
        }
        if (!temporary.renameTo(target)) {
            temporary.delete();
            throw new IllegalStateException("Could not commit cache file");
        }
    }

    public static String read(Context context, String key) throws Exception {
        File target = resolve(context, key);
        if (!target.isFile()) return null;
        long length = target.length();
        if (length < 0 || length > 8 * 1024 * 1024) return null;
        byte[] bytes = new byte[(int) length];
        try (FileInputStream input = new FileInputStream(target)) {
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count < 0) break;
                offset += count;
            }
            if (offset != bytes.length) return null;
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }
}