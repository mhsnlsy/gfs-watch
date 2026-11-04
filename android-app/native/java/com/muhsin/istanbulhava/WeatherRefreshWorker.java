package com.muhsin.istanbulhava;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class WeatherRefreshWorker extends Worker {
    public WeatherRefreshWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            WeatherData.refresh(getApplicationContext());
            return Result.success();
        } catch (Exception error) {
            return Result.retry();
        }
    }
}