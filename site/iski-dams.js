(function(){
  const url='./data/iski-dams.json';
  const rate=document.getElementById('iski-water-rate');
  const fill=document.getElementById('iski-water-fill');
  const date=document.getElementById('iski-water-date');
  const delta=document.getElementById('iski-water-delta');
  const card=document.querySelector('#iski-water-card .iski-mini-card');
  if(!rate||!fill||!date||!delta||!card)return;

  let alert=document.getElementById('iski-water-alert');
  if(!alert){
    alert=document.createElement('div');
    alert.id='iski-water-alert';
    alert.setAttribute('role','status');
    alert.style.cssText='display:none;margin:0 0 12px;padding:11px 13px;border:1px solid rgba(241,201,139,.55);border-radius:11px;background:rgba(130,83,33,.22);color:#ffe0ad;font-size:12px;line-height:1.5';
    card.insertBefore(alert,card.firstChild);
  }

  function showAlert(message){
    alert.textContent=message;
    alert.style.display='block';
  }
  function hideAlert(){alert.textContent='';alert.style.display='none';}

  function render(d){
    const valid=d&&d.fill_rate!==null&&d.fill_rate!==undefined&&d.fill_rate!==''&&Number.isFinite(Number(d.fill_rate));
    if(!valid){
      rate.innerHTML='—<small>%</small>';
      date.textContent='Veri alınamadı';
      delta.textContent='7 günlük değişim: —';
      fill.style.width='0%';
      showAlert('GÜNCEL VERİ ALINAMIYOR · Doluluk oranı şu anda doğrulanamadı. Yeni başarılı ölçüm gelene kadar değer gösterilmiyor.');
      return;
    }

    const n=Number(d.fill_rate),v=Number(d.delta_7d);
    rate.innerHTML=n.toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2})+'<small>%</small>';
    fill.style.width=Math.max(0,Math.min(100,n))+'%';

    const measured=d.measured_at_label||d.measured_at||'Ölçüm tarihi belirtilmemiş';
    date.textContent=measured;
    if(d.status==='stale'){
      showAlert('GÜNCEL VERİ ALINAMADI · Aşağıdaki oran son başarılı ölçümdür. Ölçüm tarihi: '+measured+'. Bu değer canlı veri değildir.');
    }else if(d.status==='ok'){
      hideAlert();
    }else{
      showAlert('VERİ GÜNCELLİĞİ DOĞRULANAMADI · Ölçüm tarihi: '+measured+'.');
    }

    if(Number.isFinite(v)){
      const arrow=v>0?'↑':v<0?'↓':'→';
      const sign=v>0?'+':'';
      delta.textContent=arrow+' 7 günde '+sign+v.toLocaleString('tr-TR',{maximumFractionDigits:2})+' puan';
      delta.dataset.trend=v>0?'up':v<0?'down':'flat';
    }else{
      delta.textContent='→ 7 günlük değişim: ölçüm yok';
      delta.dataset.trend='flat';
    }
  }

  fetch(url+'?v='+Date.now(),{cache:'no-store'})
    .then(response=>{if(!response.ok)throw new Error('HTTP '+response.status);return response.json();})
    .then(render)
    .catch(()=>render(null));
})();