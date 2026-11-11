package com.istanbulunhavasi.widget;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView v = new TextView(this);
        v.setText("İstanbul Havası\n\nAna ekrana büyük widget'ı ekleyin.\nWidget verileri 30 dakikada bir yenilenir.");
        v.setTextColor(0xFFEAF6FA);
        v.setTextSize(18);
        v.setPadding(40, 40, 40, 40);
        v.setBackgroundColor(0xFF071D2B);
        setContentView(v);
    }
}
