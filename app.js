import * as VaultCrypto from "./vault-crypto.js";

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const LEGACY_STORAGE_KEY = "notenest.web.local.v1";
  const VAULT_STORAGE_KEY = "notenest.web.vault.v1";
  const PREFS_STORAGE_KEY = "notenest.web.prefs.v1";
  const state = { notes: [], folders: [], filter: "all", folderId: null, activeId: null, dirty: false, dark: false };
  let vaultKey = null, passwordWrappedKey = null, recoveryWrappedKey = null, saveQueue = Promise.resolve();
  let pendingSetup = null, unlockUsesRecovery = false;
  const fa = new Intl.NumberFormat("fa-IR");
  let saveTimer = null, toastTimer = null;

  function loadPreferences() {
    try { state.dark = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) || "{}").dark === true; } catch { state.dark = false; }
    document.body.classList.toggle("dark", state.dark);
  }
  function toSnapshot() {
    return { schemaVersion: 1, exportedAt: Date.now(),
      folders: state.folders.map(f => ({ syncId:f.id, name:f.name, parentSyncId:f.parentSyncId ?? null, createdAt:f.createdAt, updatedAt:f.updatedAt })),
      notes: state.notes.map(n => ({ syncId:n.id, title:n.title, content:n.content, folderSyncId:n.folderId ?? null, isFavorite:n.favorite===true, createdAt:n.createdAt, updatedAt:n.updatedAt })) };
  }
  function applySnapshot(s) {
    state.folders=s.folders.map(f=>({id:f.syncId,name:f.name,parentSyncId:f.parentSyncId??null,createdAt:f.createdAt,updatedAt:f.updatedAt}));
    state.notes=s.notes.map(n=>({id:n.syncId,title:n.title,content:n.content,folderId:n.folderSyncId??null,favorite:n.isFavorite,createdAt:n.createdAt,updatedAt:n.updatedAt}));
  }
  function importLegacyData() {
    try {
      const old=JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)||"{}");
      const folders=Array.isArray(old.folders)?old.folders:[], notes=Array.isArray(old.notes)?old.notes:[];
      const ids=new Map(folders.map(f=>[f.id,crypto.randomUUID()]));
      state.folders=folders.map(f=>({id:ids.get(f.id),name:String(f.name||"پوشه"),parentSyncId:null,createdAt:Number(f.createdAt)||Date.now(),updatedAt:Number(f.updatedAt)||Date.now()}));
      state.notes=notes.map(n=>({id:crypto.randomUUID(),title:String(n.title||""),content:String(n.content||""),folderId:ids.get(n.folderId)||null,favorite:n.favorite===true,createdAt:Number(n.createdAt)||Date.now(),updatedAt:Number(n.updatedAt)||Date.now()}));
    } catch { state.notes=[];state.folders=[]; }
  }
  async function writeEncryptedVault() {
    if(!vaultKey) throw new Error("خزانه هنوز باز نشده است.");
    const bytes=await VaultCrypto.encryptSnapshotDocument(vaultKey,passwordWrappedKey,recoveryWrappedKey,toSnapshot());
    localStorage.setItem(VAULT_STORAGE_KEY,new TextDecoder().decode(bytes));
  }
  function persist() {
    if(!vaultKey)return;
    $("saveState").textContent="در حال رمزگذاری…";
    saveQueue=saveQueue.then(async()=>{await writeEncryptedVault();$("saveState").textContent="رمزگذاری و ذخیره شد";state.dirty=false;})
      .catch(error=>{$("saveState").textContent="خطا در ذخیره";showToast("ذخیره امن انجام نشد: "+(error?.message||"خطا"));});
    return saveQueue;
  }
  function revealApp(){ $("vaultGate").hidden=true;document.querySelector(".app-shell").hidden=false;setHeading();render(); }
  function gateError(message){$("vaultError").textContent=message;$("vaultError").hidden=false;}
  function showSetup(){ $("vaultSetupForm").hidden=false;$("vaultUnlockForm").hidden=true;$("vaultRecoveryStep").hidden=true;$("vaultGateTitle").textContent="ساخت خزانهٔ امن";$("vaultGateDescription").textContent="رمز عبور و کلید بازیابی بساز. یادداشت‌ها روی این دستگاه رمزگذاری‌شده ذخیره می‌شوند."; }
  function showUnlock(){ $("vaultSetupForm").hidden=true;$("vaultUnlockForm").hidden=false;$("vaultGateTitle").textContent="باز کردن خزانه";$("vaultGateDescription").textContent="برای دسترسی به یادداشت‌ها، رمز عبور یا کلید بازیابی را وارد کن."; }
  async function bootstrap(){
    loadPreferences();
    const stored=localStorage.getItem(VAULT_STORAGE_KEY);
    if(!stored){importLegacyData();showSetup();}
    else {try{pendingSetup=JSON.parse(stored);VaultCrypto.validateEnvelope(pendingSetup);showUnlock();}
      catch{showUnlock();gateError("ساختار خزانه معتبر نیست؛ داده‌ها را حذف نکن.");}}
    if("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }
  async function unlockVault(secret){
    const e=pendingSetup;
    const key=unlockUsesRecovery?await VaultCrypto.unwrapVaultKeyWithRecoveryKey(e.recoveryWrappedKey,secret):await VaultCrypto.unwrapVaultKeyWithPassword(e.passwordWrappedKey,secret);
    try {
      const snapshot=await VaultCrypto.decryptSnapshotDocument(new TextEncoder().encode(JSON.stringify(e)),key);
      vaultKey=key;passwordWrappedKey=e.passwordWrappedKey;recoveryWrappedKey=e.recoveryWrappedKey;applySnapshot(snapshot);
      $("vaultSecret").value="";$("vaultRecoverySecret").value="";revealApp();
    } catch(error) { key.fill(0); throw error; }
  }
  function id() { return crypto.randomUUID(); }
  function dateLabel(ts) {
    try { return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(new Date(ts)); }
    catch { return ""; }
  }
  function showToast(message) {
    $("toast").textContent = message; $("toast").classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200);
  }
  function folderName(folderId) { return state.folders.find(f => f.id === folderId)?.name || "بدون پوشه"; }
  function visibleNotes() {
    let notes = [...state.notes];
    if (state.filter === "favorite") notes = notes.filter(n => n.favorite);
    if (state.filter === "folder") notes = notes.filter(n => n.folderId === state.folderId);
    const q = $("searchInput").value.trim().toLocaleLowerCase();
    if (q) notes = notes.filter(n => (n.title + " " + n.content).toLocaleLowerCase().includes(q));
    const sort = $("sortSelect").value;
    notes.sort((a,b) => sort === "title" ? a.title.localeCompare(b.title, "fa") : sort === "created" ? a.createdAt-b.createdAt : b.updatedAt-a.updatedAt);
    return notes;
  }
  function render() {
    $("allCount").textContent = fa.format(state.notes.length);
    $("favoriteCount").textContent = fa.format(state.notes.filter(n=>n.favorite).length);
    $("folderList").replaceChildren();
    state.folders.forEach(folder => {
      const b = document.createElement("button"); b.className = "folder-item" + (state.filter==="folder" && state.folderId===folder.id ? " active" : "");
      const icon = document.createElement("span"); icon.textContent = "▱";
      const name = document.createElement("span"); name.textContent = folder.name;
      const count = document.createElement("small"); count.className="folder-count"; count.textContent=fa.format(state.notes.filter(n=>n.folderId===folder.id).length);
      b.append(icon,name,count); b.addEventListener("click",()=>{state.filter="folder";state.folderId=folder.id;setHeading();render();closeSidebar();});
      $("folderList").append(b);
    });
    const notes = visibleNotes(); $("notesGrid").replaceChildren();
    $("resultCount").textContent = fa.format(notes.length) + " یادداشت";
    $("emptyState").hidden = notes.length > 0;
    notes.forEach(note => {
      const card=document.createElement("article");card.className="note-card";card.tabIndex=0;card.setAttribute("role","button");card.setAttribute("aria-label","ویرایش "+(note.title||"یادداشت بدون عنوان"));
      const title=document.createElement("h3");title.textContent=note.title||"بدون عنوان";
      const preview=document.createElement("p");preview.className="note-preview";preview.textContent=note.content||"یادداشتی بدون متن";
      const footer=document.createElement("footer");const folder=document.createElement("span");folder.className="note-folder";folder.textContent=folderName(note.folderId);
      const date=document.createElement("time");date.textContent=dateLabel(note.updatedAt);
      const fav=document.createElement("span");fav.textContent=note.favorite?"★":"";
      footer.append(folder,date,fav);card.append(title,preview,footer);
      card.addEventListener("click",()=>openEditor(note.id));card.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();openEditor(note.id);}});
      $("notesGrid").append(card);
    });
  }
  function setHeading() {
    const folder=state.folders.find(f=>f.id===state.folderId);
    $("pageTitle").textContent=state.filter==="favorite"?"علاقه‌مندی‌ها":state.filter==="folder"?(folder?.name||"پوشه"):"همه یادداشت‌ها";
    $("pageSubtitle").textContent=state.filter==="favorite"?"یادداشت‌هایی که نشان‌دار کرده‌ای.":"فکرهایت را اینجا نگه دار.";
    document.querySelectorAll("[data-filter]").forEach(b=>b.classList.toggle("active",b.dataset.filter===state.filter));
  }
  function renderFolderOptions(selected="") {
    const select=$("noteFolder");select.replaceChildren();
    const none=document.createElement("option");none.value="";none.textContent="بدون پوشه";select.append(none);
    state.folders.forEach(f=>{const o=document.createElement("option");o.value=f.id;o.textContent=f.name;select.append(o);});
    select.value=selected||"";
  }
  function openEditor(noteId=null) {
    let note=state.notes.find(n=>n.id===noteId);
    if(!note){const now=Date.now();note={id:id(),title:"",content:"",folderId:state.filter==="folder"?state.folderId:null,favorite:false,createdAt:now,updatedAt:now};state.notes.unshift(note);}
    state.activeId=note.id;$("noteTitle").value=note.title;$("noteContent").value=note.content;
    renderFolderOptions(note.folderId);$("favoriteNote").textContent=note.favorite?"★":"☆";
    $("deleteNote").style.visibility=note.title||note.content?"visible":"hidden";
    $("editorFolderLabel").textContent=folderName(note.folderId);$("editorBackdrop").hidden=false;
    $("saveState").textContent="ذخیره‌شده";updateWordCount();setTimeout(()=>$("noteTitle").focus(),30);
  }
  function closeEditor() {
    commitEditor();$("editorBackdrop").hidden=true;state.activeId=null;render();
  }
  function commitEditor() {
    const note=state.notes.find(n=>n.id===state.activeId);if(!note)return;
    note.title=$("noteTitle").value;note.content=$("noteContent").value;note.folderId=$("noteFolder").value||null;note.updatedAt=Date.now();
    $("editorFolderLabel").textContent=folderName(note.folderId);
    clearTimeout(saveTimer);persist();state.dirty=false;
    $("deleteNote").style.visibility=note.title||note.content?"visible":"hidden";
  }
  function scheduleSave() {
    $("saveState").textContent="در حال ذخیره…";state.dirty=true;clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{commitEditor();render();},350);
    updateWordCount();
  }
  function updateWordCount(){const text=$("noteContent").value.trim();$("wordCount").textContent=fa.format(text?text.split(/\s+/u).length:0)+" کلمه";}
  function askDialog(title,message,placeholder="") {
    $("dialogTitle").textContent=title;$("dialogMessage").textContent=message;
    $("dialogInput").value="";$("dialogInput").placeholder=placeholder;
    $("dialogInput").hidden=!placeholder;
    $("actionDialog").showModal();
    if(placeholder)setTimeout(()=>$("dialogInput").focus(),20);
  }
  function addFolder() {
    askDialog("ساخت پوشه","نامی برای پوشه جدید انتخاب کن.","نام پوشه");
  }
  function deleteActive() {
    const note=state.notes.find(n=>n.id===state.activeId);if(!note)return;
    askDialog("حذف یادداشت","آیا از حذف این یادداشت مطمئنی؟");
  }
  function closeSidebar(){$("sidebar").classList.remove("open");}
  document.querySelectorAll("[data-filter]").forEach(b=>b.addEventListener("click",()=>{state.filter=b.dataset.filter;state.folderId=null;setHeading();render();closeSidebar();}));
  ["newNote","topNewNote","emptyNewNote"].forEach(idName=>$(idName).addEventListener("click",()=>openEditor()));
  $("addFolder").addEventListener("click",addFolder);
  $("actionForm").addEventListener("submit",e=>{
    e.preventDefault();const action=e.submitter?.value;$("actionDialog").close();
    if(action!=="confirm")return;
    if($("dialogInput").hidden){
      const note=state.notes.find(n=>n.id===state.activeId);if(!note)return;
      state.notes=state.notes.filter(n=>n.id!==note.id);persist();$("editorBackdrop").hidden=true;state.activeId=null;render();showToast("یادداشت حذف شد.");
    }else{
      const name=$("dialogInput").value.trim();if(!name)return;
      if(state.folders.some(f=>f.name.trim()===name)){showToast("این پوشه از قبل وجود دارد.");return;}
      const now=Date.now();state.folders.push({id:id(),name,parentSyncId:null,createdAt:now,updatedAt:now});persist();render();showToast("پوشه ساخته شد.");
    }
  });
  $("closeEditor").addEventListener("click",closeEditor);
  $("editorBackdrop").addEventListener("click",e=>{if(e.target===$("editorBackdrop"))closeEditor();});
  $("noteTitle").addEventListener("input",scheduleSave);$("noteContent").addEventListener("input",scheduleSave);
  $("noteFolder").addEventListener("change",scheduleSave);
  $("favoriteNote").addEventListener("click",()=>{const n=state.notes.find(x=>x.id===state.activeId);if(!n)return;n.favorite=!n.favorite;$("favoriteNote").textContent=n.favorite?"★":"☆";commitEditor();render();});
  $("deleteNote").addEventListener("click",deleteActive);
  $("searchInput").addEventListener("input",render);$("sortSelect").addEventListener("change",render);
  $("mobileMenu").addEventListener("click",()=>$("sidebar").classList.toggle("open"));
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("editorBackdrop").hidden)closeEditor();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="n"){e.preventDefault();openEditor();}});
  $("vaultSetupForm").addEventListener("submit",async e=>{
    e.preventDefault();$("vaultError").hidden=true;
    const password=$("vaultPassword").value,confirm=$("vaultPasswordConfirm").value;
    if(password.length<10)return gateError("رمز عبور باید دست‌کم ۱۰ نویسه باشد.");
    if(password!==confirm)return gateError("تکرار رمز عبور یکسان نیست.");
    $("vaultSetupButton").disabled=true;
    try{
      const key=VaultCrypto.createVaultKey(),recovery=VaultCrypto.createRecoveryKey();
      pendingSetup={key,recovery,wrappedPassword:await VaultCrypto.wrapVaultKeyWithPassword(key,password),
        wrappedRecovery:await VaultCrypto.wrapVaultKeyWithRecoveryKey(key,recovery)};
      $("vaultPassword").value="";$("vaultPasswordConfirm").value="";
      $("recoveryCode").textContent=recovery;$("recoveryHint").textContent="برای تأیید، ۶ نویسهٔ پایانی را وارد کن: "+recovery.slice(-6);
      $("vaultSetupForm").hidden=true;$("vaultRecoveryStep").hidden=false;
      $("vaultGateTitle").textContent="کلید بازیابی را نگه دار";
      $("vaultGateDescription").textContent="این کلید فقط یک‌بار نمایش داده می‌شود؛ آن را در جای امنی خارج از این دستگاه نگه دار.";
    }catch(error){gateError("ساخت خزانه ناموفق بود: "+error.message);}
    finally{$("vaultSetupButton").disabled=false;}
  });
  $("confirmRecoveryForm").addEventListener("submit",async e=>{
    e.preventDefault();$("vaultError").hidden=true;
    if($("recoveryConfirmation").value.trim()!==pendingSetup.recovery.slice(-6))return gateError("۶ نویسهٔ پایانی کلید بازیابی درست نیست.");
    $("confirmRecoveryButton").disabled=true;
    try{
      vaultKey=pendingSetup.key;passwordWrappedKey=pendingSetup.wrappedPassword;recoveryWrappedKey=pendingSetup.wrappedRecovery;
      await writeEncryptedVault();pendingSetup=JSON.parse(localStorage.getItem(VAULT_STORAGE_KEY));localStorage.removeItem(LEGACY_STORAGE_KEY);
      $("vaultRecoveryStep").hidden=true;revealApp();showToast("خزانهٔ امن ساخته شد.");
    }catch(error){vaultKey=null;gateError("ذخیرهٔ خزانه انجام نشد: "+error.message);}
    finally{$("confirmRecoveryButton").disabled=false;}
  });
  $("vaultUnlockForm").addEventListener("submit",async e=>{
    e.preventDefault();$("vaultError").hidden=true;
    const secret=unlockUsesRecovery?$("vaultRecoverySecret").value.trim():$("vaultSecret").value;
    if(!secret)return gateError("اطلاعات ورود را وارد کن.");
    $("vaultUnlockButton").disabled=true;
    try{await unlockVault(secret);showToast("خزانه باز شد.");}
    catch{gateError(unlockUsesRecovery?"کلید بازیابی معتبر نیست.":"رمز عبور اشتباه است یا خزانه آسیب دیده.");}
    finally{$("vaultUnlockButton").disabled=false;}
  });
  $("toggleRecoveryUnlock").addEventListener("click",()=>{
    unlockUsesRecovery=!unlockUsesRecovery;$("vaultSecret").hidden=unlockUsesRecovery;$("vaultRecoverySecret").hidden=!unlockUsesRecovery;
    $("toggleRecoveryUnlock").textContent=unlockUsesRecovery?"ورود با رمز عبور":"ورود با کلید بازیابی";
    $("vaultSecret").required=!unlockUsesRecovery;$("vaultRecoverySecret").required=unlockUsesRecovery;
  });
  $("copyRecoveryCode").addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText(pendingSetup.recovery);showToast("کلید بازیابی کپی شد.");}
    catch{gateError("کپی خودکار ممکن نیست؛ کلید را دستی انتخاب و کپی کن.");}
  });
  $("themeToggle").addEventListener("click",()=>{state.dark=!state.dark;document.body.classList.toggle("dark",state.dark);localStorage.setItem(PREFS_STORAGE_KEY,JSON.stringify({dark:state.dark}));});
  $("lockVault").addEventListener("click",async()=>{
    if(!$("editorBackdrop").hidden) closeEditor();
    await saveQueue;
    vaultKey?.fill(0);vaultKey=null;state.notes=[];state.folders=[];
    document.querySelector(".app-shell").hidden=true;$("vaultGate").hidden=false;showUnlock();
    $("vaultSecret").value="";$("vaultRecoverySecret").value="";
  });
  bootstrap();
})();