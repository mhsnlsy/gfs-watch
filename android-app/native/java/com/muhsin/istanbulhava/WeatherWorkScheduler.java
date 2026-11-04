package com.muhsin.istanbulhava;

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

public final class WeatherWorkScheduler {
    private static final String PERIODIC_NAME = "istanbul-weather-refresh";
    private static final String IMMEDIATE_NAME = "istanbul-weather-refresh-now";

    private WeatherWorkScheduler() {}

    private static Constraints networkConstraints() {
        return new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
    }

    public static void schedule(Context context) {
        PeriodicWorkRequest periodic = new PeriodicWorkRequest.Builder(
                WeatherRefreshWorker.class,
                15,
                TimeUnit.MINUTES
        ).setConstraints(networkConstraints()).build();

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                periodic
        );
        enqueueImmediate(context);
    }

    public static void enqueueImmediate(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(WeatherRefreshWorker.class)
                .setConstraints(networkConstraints())
                .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(context).enqueueUniqueWork(
                IMMEDIATE_NAME,
                ExistingWorkPolicy.KEEP,
                request
        );
    }
}