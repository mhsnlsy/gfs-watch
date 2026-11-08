const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const state={page:"/",selected:null,history:[],future:[],drafts:{}};
const preview=$("#preview"), canvas=$("#canvas"), inspector=$("#inspector"), codeBox=$("#codeBox"), status=$("#status");
function toast(t){const x=$("#toast");x.textContent=t;x.classList.add("show");clearTimeout(x._t);x._t=setTimeout(()=>x.classList.remove("show"),1800)}
function key(){return "iha-editor:"+state.page}
function loadDraft(){const d=localStorage.getItem(key());return d?JSON.parse(d):null}
function saveDraft(){if(!preview.contentDocument)return;localStorage.setItem(key(),JSON.stringify({html:preview.contentDocument.documentElement.outerHTML,ts:Date.now()}));toast("Taslak tarayıcıya kaydedildi");status.textContent="Taslak kaydedildi"}
function pushHistory(){if(!preview.contentDocument)return;state.history.push(preview.contentDocument.documentElement.outerHTML);if(state.history.length>30)state.history.shift();state.future=[]}
function restore(html){preview.srcdoc=html; setTimeout(bindPreview,80)}
function bindPreview(){
 const doc=preview.contentDocument;if(!doc)return;
 doc.querySelectorAll("[data-iha-editor]").forEach(e=>e.removeAttribute("data-iha-editor"));
 doc.addEventListener("click",onPreviewClick,true);
 doc.addEventListener("mouseover",e=>{const el=e.target.closest("body *");if(el&&el!==doc.body)el.style.outline="1px dashed #2d7ff9"},true);
 doc.addEventListener("mouseout",e=>{const el=e.target.closest("body *");if(el&&el!==doc.body&&el!==state.selected)el.style.outline=""},true);
 renderList();
}
function onPreviewClick(e){e.preventDefault();e.stopPropagation();pushHistory();state.selected=e.target;selectElement(e.target)}
function selectElement(el){
 state.selected=el;el.setAttribute("data-iha-editor","selected");el.style.outline="2px solid #2d7ff9";
 const cs=preview.contentWindow.getComputedStyle(el);
 inspector.innerHTML=`
 <div class="group"><label>Etiket</label><input id="tag" value="${el.tagName.toLowerCase()}" disabled></div>
 <div class="group"><label>Metin</label><input id="text" value="${(el.children.length?el.innerText:el.textContent).trim().replace(/"/g,"&quot;")}"></div>
 <div class="group"><div class="row"><div><label>Genişlik</label><input id="width" value="${cs.width}"></div><div><label>Yükseklik</label><input id="height" value="${cs.height}"></div></div></div>
 <div class="group"><div class="row"><div><label>Font</label><input id="font" value="${cs.fontSize}"></div><div><label>Radius</label><input id="radius" value="${cs.borderRadius}"></div></div></div>
 <div class="group"><label>Arka plan</label><input id="bg" value="${cs.backgroundColor}"></div>`;
 ["text","width","height","font","radius","bg"].forEach(id=>$("#"+id)?.addEventListener("change",applyInspector));
 codeBox.value=el.outerHTML;
}
function applyInspector(){
 const el=state.selected;if(!el)return;
 pushHistory();
 if($("#text"))el.textContent=$("#text").value;
 if($("#width"))el.style.width=$("#width").value;
 if($("#height"))el.style.height=$("#height").value;
 if($("#font"))el.style.fontSize=$("#font").value;
 if($("#radius"))el.style.borderRadius=$("#radius").value;
 if($("#bg"))el.style.background=$("#bg").value;
 codeBox.value=el.outerHTML;status.textContent="Taslak değiştirildi";
}
function renderList(){const list=$("#elementList");list.innerHTML="";if(!state.selected){list.innerHTML='<div class="hint">Önizlemedeki bir öğeye tıklayın.</div>';return}let el=state.selected;let i=0;while(el&&el!==preview.contentDocument.body&&i<5){const b=document.createElement("div");b.className="element selected";b.textContent=el.tagName.toLowerCase()+(el.id?" #"+el.id:"")+(el.className&&typeof el.className==="string"?" ."+el.className.split(" ")[0]:"");b.onclick=()=>selectElement(el);list.appendChild(b);el=el.parentElement;i++}}
function loadPage(){
 state.page=$(".page.active")?.dataset.page||"/";
 const d=loadDraft();
 if(d?.html){restore(d.html);status.textContent="Yerel taslak yüklendi";return}
 preview.src=state.page;
 preview.onload=bindPreview;
}
$$(".page").forEach(b=>b.onclick=()=>{$$(".page").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.selected=null;loadPage()});
$$("[data-device]").forEach(b=>b.onclick=()=>{$$("[data-device]").forEach(x=>x.classList.remove("active"));b.classList.add("active");canvas.className="canvas "+b.dataset.device});
$("#saveBtn").onclick=saveDraft;
$("#previewBtn").onclick=()=>{preview.contentWindow.location.reload();toast("Canlı önizleme yenilendi")};
$("#applyCode").onclick=()=>{if(!state.selected)return;pushHistory();const t=document.createElement("template");t.innerHTML=codeBox.value.trim();const n=t.content.firstElementChild;if(n){state.selected.replaceWith(n);state.selected=n;selectElement(n);status.textContent="HTML uygulandı"}};
$("#undoBtn").onclick=()=>{if(!state.history.length)return;state.future.push(preview.contentDocument.documentElement.outerHTML);restore(state.history.pop());toast("Geri alındı")};
$("#redoBtn").onclick=()=>{if(!state.future.length)return;state.history.push(preview.contentDocument.documentElement.outerHTML);restore(state.future.pop());toast("İleri alındı")};
$("#publishBtn").onclick=async()=>{
 saveDraft();
 const d=loadDraft(); if(!d)return;
 if(!location.origin.includes("istanbulunhavasi.com")){toast("Yayın endpoint'i canlı alan adında etkinleştirilmeli");return}
 try{const r=await fetch("/api/publish",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({page:state.page,html:d.html})});if(!r.ok)throw new Error(await r.text());toast("Yayın isteği gönderildi");status.textContent="Yayın kuyruğuna alındı"}catch(e){toast("Yayın başarısız: "+e.message)}};
loadPage();
