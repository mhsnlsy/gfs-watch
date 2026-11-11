package com.istanbulunhavasi.widget;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView v = new TextView(this);
        v.setText("İstanbul Havası\n\nAna ekrana widget ekleyebilirsiniz.\n\nBüyük boyutu seçin.");
        v.setTextColor(0xFFEAF6FA);
        v.setTextSize(18);
        v.setPadding(32,32,32,32);
        v.setBackgroundColor(0xFF071D2B);
        setContentView(v);
    }
}
