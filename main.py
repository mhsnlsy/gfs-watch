def build_meteorologist_script(data, runs):
    """
    Kuru sayıları radyo bülteni kıvamında doğal meteorolog konuşmasına çevirir.
    """
    run_name = data['run_name']
    temp = data['temp']
    precip = data['precip']
    press = data['pressure']
    
    # Varsayılan başlangıç
    speech = f"GFS modelinin {run_name} güncellemesi tamamlandı. "
    
    # 1. Trend ve Kıyas Yorumu (N-1 Kıyası)
    if len(runs) >= 1:
        prev_temp = runs[0][1]
        prev_press = runs[0][2]
        t_diff = temp - prev_temp
        p_diff = press - prev_press
        
        if t_diff <= -2.0:
            speech += f"Dikkat, son çıktıda belirgin bir soğuma var. Sıcaklıklar bir önceki çalıştırmaya göre {abs(t_diff):.1f} derece aniden düşüyor. "
        elif t_diff >= 2.0:
            speech += f"Modelde ısınma eğilimi öne çıkıyor, sıcaklık {t_diff:.1f} derece artış gösterdi. "
            
        if p_diff <= -3.0:
            speech += f"Basınçtaki {abs(p_diff):.1f} hektopaskallık sert düşüş, bölgeye yaklaşan alçak basınç ve fırtına riskine işaret ediyor. "
    
    # 2. Yağış ve Durum Vurgusu
    if precip > 5.0:
        speech += f"Özellikle dışarıda olacaksanız dikkatli olun, kuvvetli yağış geçişleri bekleniyor. "
    elif precip > 0.0:
        speech += f"Aralıklı hafif yağmur geçişleri görülebilir. "
    else:
        speech += f"Şu an için belirgin bir yağış riski görünmüyor, hava genel olarak açık. "
        
    speech += f"Anlık sıcaklık {temp} derece civarında seyrediyor. Güvenli sürüşler ve iyi yürüyüşler."
    return speech
