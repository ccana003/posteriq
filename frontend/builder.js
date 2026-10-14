/* Guided authoring. Approved text is stable until the author edits it. */
(() => {
    const C = PosterBuilderCore;
    const API = ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:7071/api" : "https://posteriq-api-dme7bwfug7azd9h3.westus3-01.azurewebsites.net/api";
    const $ = id => document.getElementById(id);
    const node = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
    let doc = C.createDocument(), selected = null, db = null, busy = false, saving = false, saveTimer, reviewRevision = null, storageUnsaved = false, backupRevision = -1;
    const images = new Map();
    const canvas = $("builderCanvas"), stage = $("builderStage");
    function message(text, error = false) {
        for (const id of ["builderMessage", "draftStatus", "planStatus"]) {
            const target = $(id);
            target.textContent = text;
            target.classList.toggle("error", error);
        }
    }
    function current() { return doc.sections.find(s => s.id === selected); }
    function changed() {
        doc.revision++;
        if (doc.review) $("reviewStale").textContent = "The poster changed after this review. Run the review again before relying on it.";
        scheduleSave();
    }
    function scheduleSave() {
        clearTimeout(saveTimer); saving = true; storageUnsaved = true; $("saveStatus").textContent = "Saving on this device…";
        saveTimer = setTimeout(async () => {
            try {
                if (!db) throw new Error("Storage unavailable");
                const snapshot = structuredClone(doc);
                await new Promise((resolve, reject) => {
                    const tx = db.transaction("drafts", "readwrite"); tx.objectStore("drafts").put(snapshot, "current");
                    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
                });
                if (snapshot.revision === doc.revision) { saving = false; storageUnsaved = false; $("saveStatus").textContent = "Saved on this browser and device"; }
            } catch { saving = false; $("saveStatus").textContent = "Browser save unavailable — save an editable draft file"; }
        }, 100);
    }
    async function openSaved() {
        try {
            db = await new Promise((resolve, reject) => {
                const request = indexedDB.open("posteriq-builder", 1);
                request.onupgradeneeded = () => request.result.createObjectStore("drafts");
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            const saved = await new Promise((resolve, reject) => {
                const request = db.transaction("drafts").objectStore("drafts").get("current");
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            if (saved) { doc = C.validateImport(saved); selected = doc.sections[0]?.id || null; }
            $("saveStatus").textContent = saved ? "Draft restored from this device" : "Drafts save on this browser and device";
        } catch { $("saveStatus").textContent = "Browser storage unavailable — use Save editable draft"; }
        syncSetup(); renderAll(); preloadImages();
    }
    function syncSetup() {
        const fields = {posterTitle:"title", posterAuthors:"authors", posterAffiliations:"affiliations", posterAudience:"audience", organizerRequirements:"event_requirements", posterType:"poster_type", posterWidth:"width_in", posterHeight:"height_in", builderTemplate:"template"};
        Object.entries(fields).forEach(([id,key]) => $(id).value = doc[key]);
        $("posterType").disabled = Boolean(doc.sections.length);
        $("planPoster").textContent = doc.sections.length ? "Save details and return to sections" : "Create guided outline";
        $("manualOutline").hidden = Boolean(doc.sections.length);
    }
    function renderSteps() {
        $("sectionSteps").replaceChildren();
        doc.sections.forEach((s, i) => {
            const li = node("li"), button = node("button", `${s.approved ? "✓" : "○"} ${i+1}. ${s.title}`);
            button.type = "button"; if (s.id === selected) button.setAttribute("aria-current", "step");
            button.addEventListener("click", () => { selected = s.id; renderAll(); $("sectionEditor").scrollIntoView({behavior:"smooth", block:"start"}); });
            li.append(button); $("sectionSteps").append(li);
        });
    }
    function renderEditor() {
        const s = current();
        $("setupForm").hidden = Boolean(s); $("sectionEditor").hidden = !s;
        if (!s) return;
        $("sectionTitle").textContent = s.title;
        $("sectionPurpose").textContent = s.purpose;
        $("sectionQuestion").textContent = s.question || "What should this section communicate? Provide the source information below.";
        const values = {sectionPurposeInput:"purpose", sectionName:"title", sectionNotes:"notes", sectionText:"text", figureDescription:"figure_description", figureCaption:"caption", sectionFont:"font_size"};
        Object.entries(values).forEach(([id,key]) => $(id).value = s[key] || "");
        $("textEditor").hidden = s.kind === "figure"; $("figureEditor").hidden = s.kind !== "figure";
        $("sectionSources").replaceChildren();
        const source = node("p", s.requirement_level === "required" ? "Required by the cited guidance (check applicability)." : "Suggested section — adapt it to your poster.", "builder-sources");
        $("sectionSources").append(source);
        (s.sources || []).forEach(r => $("sectionSources").append(node("p", `${r.reference_id} · ${r.source || "Guidance"}: ${r.text || ""}`, "builder-sources")));
        $("figureThumbnail").hidden = !s.imageData;
        if(s.imageData) $("figureThumbnail").src = s.imageData;
        else $("figureThumbnail").removeAttribute("src");
        $("draftQuestions").replaceChildren();
        $("draftStatus").textContent = busy ? "An AI step is in progress. Please wait…" : "";
        updatePlacement(); approvalStatus();
    }
    function approvalStatus() {
        const s = current(); if (!s) return;
        $("approvalStatus").textContent = s.approved ? "Approved and placed on the poster. Editing its wording or figure removes approval." : "Draft — review the wording, source facts and citations before approving.";
        $("approveSection").textContent = s.approved ? "Approved · keep on poster" : "Approve and place on poster";
    }
    function updatePlacement() {
        const s = current(); if (!s) return;
        for (const k of ["x","y","w","h"]) $("section"+k.toUpperCase()).value = Math.round(s.rect[k]*1000)/10;
    }
    function renderAll() {
        $("builderTemplate").value = doc.template;
        renderSteps(); renderEditor(); renderPoster();
        $("planNotes").hidden = !doc.plan_notes.length;
        $("planNoteList").replaceChildren(...doc.plan_notes.map(t => node("li",t)));
    }
    function drawPoster(target, document) {
        const width = 1200, height = Math.round(width * document.height_in / document.width_in);
        target.width = width; target.height = height;
        const ctx = target.getContext("2d"), issues = [];
        const theme = getComputedStyle(window.document.documentElement);
        const green = theme.getPropertyValue("--brand-green").trim() || "#005030";
        const orange = theme.getPropertyValue("--brand-orange").trim() || "#f47321";
        const tint = theme.getPropertyValue("--brand-tint").trim() || "#f2f7f4";
        ctx.fillStyle = "white"; ctx.fillRect(0,0,width,height);
        ctx.fillStyle = green; ctx.fillRect(0,0,width,height*.155);
        ctx.fillStyle = orange; ctx.fillRect(0,height*.155,width,6);
        ctx.fillStyle = "white"; ctx.font = "bold 32px Arial"; ctx.textBaseline = "top";
        const titles = C.wrap(ctx, document.title || "Your poster title", width-60);
        if (titles.length > 2) issues.push("The title overflows its header. Shorten it before export.");
        titles.slice(0,2).forEach((line,i) => ctx.fillText(line,30,18+i*35));
        ctx.font = "17px Arial";
        const credits = `${document.authors || "Author names"} · ${document.affiliations || "Affiliations"}`;
        const creditLines = C.wrap(ctx,credits,width-60);
        if (creditLines.length > 2) issues.push("Author details overflow the header. Shorten them or adjust poster dimensions.");
        creditLines.slice(0,2).forEach((line,i) => ctx.fillText(line,30,height*.155-45+i*20));
        document.sections.forEach(s => {
            const r = {x:s.rect.x*width,y:s.rect.y*height,w:s.rect.w*width,h:s.rect.h*height};
            ctx.save(); ctx.beginPath(); ctx.rect(r.x,r.y,r.w,r.h); ctx.clip();
            ctx.fillStyle = tint; ctx.fillRect(r.x,r.y,r.w,r.h);
            const pad = 12, headingSize = Math.max(12, s.font_size*1.2*width/(document.width_in*72));
            ctx.fillStyle = green; ctx.font = `bold ${headingSize}px Arial`;
            const heads = C.wrap(ctx,s.title,r.w-pad*2), headH=heads.length*(headingSize*1.2)+pad*2;
            heads.forEach((line,i)=>ctx.fillText(line,r.x+pad,r.y+pad+i*headingSize*1.2));
            ctx.fillStyle = orange; ctx.fillRect(r.x,r.y,4,headH);
            const font = s.font_size*width/(document.width_in*72), lineH=font*1.25;
            ctx.font = `${font}px Arial`; ctx.fillStyle = "#253746";
            let y = r.y+headH;
            if (!s.approved) { ctx.fillStyle = "#657a83"; ctx.fillText("Awaiting author approval",r.x+pad,y); ctx.restore(); return; }
            let body = s.text;
            if (s.kind === "figure") {
                const image = images.get(s.imageData);
                const capLines = C.wrap(ctx,s.caption,r.w-pad*2);
                const imageH = Math.max(0,r.h-headH-capLines.length*lineH-pad*2);
                if (image?.complete && image.naturalWidth) {
                    const factor = Math.min((r.w-pad*2)/image.naturalWidth,imageH/image.naturalHeight);
                    const iw=image.naturalWidth*factor, ih=image.naturalHeight*factor;
                    ctx.drawImage(image,r.x+(r.w-iw)/2,y,iw,ih);
                    if (iw < 80 || ih < 60) issues.push(`${s.title}: the figure is too small to inspect comfortably.`);
                } else { issues.push(`${s.title}: figure image is unavailable.`); }
                y += imageH+pad; body = s.caption;
            }
            const lines = C.wrap(ctx,body,r.w-pad*2);
            if (lines.some(line=>ctx.measureText(line).width>r.w-pad*2) || y+lines.length*lineH>r.y+r.h-pad+.5)
                issues.push(`${s.title}: text overflows its region. Shorten it or enlarge its area; the mockup clips overflow.`);
            lines.forEach((line,i)=>ctx.fillText(line,r.x+pad,y+i*lineH));
            ctx.restore();
        });
        return issues;
    }
    function renderPoster() {
        const issues = [...C.warnings(doc), ...drawPoster(canvas,doc)];
        $("layoutWarnings").replaceChildren(...(issues.length?issues:["No layout warnings detected. Check the poster at full size before sharing."]).map(t=>node("li",t)));
        $("layoutCheckCount").textContent = `· ${issues.length} warnings`;
        stage.style.aspectRatio = `${canvas.width}/${canvas.height}`;
        fitStage(); renderHandles();
    }
    function fitStage() {
        const zoom = $("builderZoom").value;
        stage.style.width = `${zoom === "fit" ? Math.min(1200, Math.max(100,$("builderViewport").clientWidth-32), Math.max(100,$("builderViewport").clientHeight-32)*canvas.width/canvas.height) : 1200*Number(zoom)}px`;
    }
    function renderHandles() {
        $("builderHandles").replaceChildren();
        doc.sections.forEach(s => {
            const item = node("div",null,"builder-section-handle"+(s.id===selected?" selected":""));
            Object.assign(item.style,{left:s.rect.x*100+"%",top:s.rect.y*100+"%",width:s.rect.w*100+"%",height:s.rect.h*100+"%"});
            item.tabIndex=0; item.setAttribute("role","button"); item.setAttribute("aria-label", `Select or move ${s.title}`);
            item.dataset.sectionId=s.id;
            const resize=node("span",null,"resize-handle"); resize.setAttribute("aria-hidden","true"); item.append(resize);
            item.addEventListener("keydown",event=>{
                if (["Enter"," "].includes(event.key)) { event.preventDefault(); selected=s.id; renderAll(); }
                else if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) {
                    event.preventDefault(); s.rect=C.clampRect({...s.rect,x:s.rect.x+(event.key==="ArrowRight"?.01:event.key==="ArrowLeft"?-.01:0),y:s.rect.y+(event.key==="ArrowDown"?.01:event.key==="ArrowUp"?-.01:0)}); changed(); renderPoster(); updatePlacement();
                    $("builderHandles").querySelector(`[data-section-id="${CSS.escape(s.id)}"]`)?.focus();
                }
            });
            item.addEventListener("pointerdown",event=>{
                if (event.button!==0) return;
                event.preventDefault(); selected=s.id; renderSteps(); renderEditor();
                $("builderHandles").querySelectorAll(".selected").forEach(e=>e.classList.remove("selected")); item.classList.add("selected");
                const resizing=event.target===resize, start={...s.rect}, x=event.clientX,y=event.clientY, bounds=stage.getBoundingClientRect();
                item.setPointerCapture(event.pointerId);
                let moved=false;
                const move=e=>{
                    const dx=(e.clientX-x)/bounds.width,dy=(e.clientY-y)/bounds.height;
                    if (Math.abs(dx)+Math.abs(dy)<.002) return;
                    moved=true; s.rect=C.clampRect(resizing?{...start,w:start.w+dx,h:start.h+dy}:{...start,x:start.x+dx,y:start.y+dy});
                    Object.assign(item.style,{left:s.rect.x*100+"%",top:s.rect.y*100+"%",width:s.rect.w*100+"%",height:s.rect.h*100+"%"});
                    drawPoster(canvas,doc); updatePlacement();
                };
                const end=()=>{item.removeEventListener("pointermove",move); item.removeEventListener("pointerup",end); item.removeEventListener("pointercancel",end); if(moved)changed(); renderPoster();};
                item.addEventListener("pointermove",move);item.addEventListener("pointerup",end);item.addEventListener("pointercancel",end);
            });
            $("builderHandles").append(item);
        });
    }
    function preloadImages() {
        doc.sections.filter(s=>s.kind==="figure"&&s.imageData).forEach(s=>{
            if(images.has(s.imageData))return;
            const image=new Image(); images.set(s.imageData,image); image.onload=()=>renderPoster(); image.onerror=()=>message(`Unable to load ${s.title}. Replace its figure.`,true); image.src=s.imageData;
        });
    }
    function aiDocument() {
        // Figures are sent only as the rendered poster in the final visual review.
        // Source images and previous review responses are not needed for drafting.
        const {review, sections, ...metadata} = doc;
        return {...metadata, sections: sections.map(({imageData, sources, ...section}) => section)};
    }
    async function request(action, payload) {
        if(busy)throw new Error("Please wait for the current AI step to finish.");
        busy=true; const revision=doc.revision; const generation=doc;
        message(action==="draft"?"Drafting concise text from your source notes. Please wait…":action==="review"?"Reviewing the assembled poster, figures and captions…":"Working from your supplied information…");
        const buttons=[$("planPoster"),$("draftSection"),$("checkPoster")];buttons.forEach(b=>b.disabled=true);
        const actionButton = action === "draft" ? $("draftSection") : action === "plan" ? $("planPoster") : $("checkPoster");
        const buttonLabel = actionButton.textContent;
        actionButton.textContent = action === "draft" ? "Drafting…" : action === "plan" ? "Creating outline…" : "Reviewing…";
        actionButton.setAttribute("aria-busy", "true");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);
        try {
            const response=await fetch(`${API}/builder/${action}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:controller.signal});
            if(response.status===404)throw new Error("The builder API is not deployed yet. Deploy the latest Function App ZIP, then retry this step.");
            let data;
            try { data=await response.json(); } catch { throw new Error("The builder received an unexpected server response. Your saved draft is unchanged."); }
            if(!response.ok)throw new Error(data.error||"The AI step could not be completed.");
            if(doc!==generation||doc.revision!==revision||(action==="draft"&&selected!==payload.section_id))throw new Error("Your poster changed while the AI was working. The response was not applied; retry using your latest content.");
            return data;
        } catch(error) {
            if(error.name === "AbortError")throw new Error("The AI step took too long. Your draft is unchanged. Please retry in a moment.");
            if(error instanceof TypeError)throw new Error("Could not reach the AI builder. Check the Function App deployment and its CORS entry for this website. Your draft is unchanged.");
            throw error;
        } finally {
            clearTimeout(timeout);
            actionButton.textContent = buttonLabel;
            actionButton.removeAttribute("aria-busy");
            busy=false;buttons.forEach(b=>b.disabled=false);
        }
    }
    function sectionDefaults(s) {return {...s,kind:"text",notes:"",text:"",caption:"",figure_description:"",font_size:28,approved:false,imageData:"",sources:s.sources||[]};}
    function acceptPlan(data) {
        doc.sections=C.arrange(data.sections.map(sectionDefaults),doc.template);doc.plan_notes=data.notes||[];
        selected=doc.sections[0]?.id; changed();syncSetup();renderAll();message("Outline ready. Answer the first section’s question, then draft and approve its wording.");
    }
    $("setupForm").addEventListener("submit",async event=>{
        event.preventDefault();
        if(doc.sections.length){selected=doc.sections[0].id;renderAll();message("Poster details saved.");return;}
        try {const data=await request("plan",{poster_type:doc.poster_type,audience:doc.audience,event_requirements:doc.event_requirements});acceptPlan(data);}
        catch(error){message(error.message,true);}
    });
    $("manualOutline").addEventListener("click",()=>{
        if(!$("setupForm").reportValidity())return;
        const plans={research:["Background","Methods","Results","Conclusion","References and acknowledgments"],protocol:["Background and purpose","Study design","Planned analysis","Expected contribution and limitations","References and acknowledgments"],case:["Background","Case or model","Observations","Discussion and takeaway","References and acknowledgments"],narrative:["Scope and purpose","Background","Evidence and approach","Synthesis and takeaway","References and acknowledgments"]};
        acceptPlan({sections:plans[doc.poster_type].map((title,i)=>({id:`section-${i+1}`,title,purpose:`State the distinct contribution of ${title.toLowerCase()}.`,question:`What information and supporting references belong in ${title.toLowerCase()}?`,requirement_level:"recommended",sources:[]})),notes:["This is a suggested outline. Curated institutional requirements have not been checked. Paste organizer requirements into poster details and verify them before sharing."]});
    });
    const metadata={posterTitle:"title",posterAuthors:"authors",posterAffiliations:"affiliations",posterAudience:"audience",organizerRequirements:"event_requirements",posterType:"poster_type",posterWidth:"width_in",posterHeight:"height_in"};
    Object.entries(metadata).forEach(([id,key])=>$(id).addEventListener("input",()=>{
        if(key.endsWith("_in")){const value=Number($(id).value);if(!Number.isFinite(value)||value<12||value>96)return;doc[key]=value;}
        else doc[key]=$(id).value;
        changed();renderPoster();
    }));
    $("editSetup").addEventListener("click",()=>{syncSetup();$("setupForm").hidden=false;$("sectionEditor").hidden=true;});
    const edits={sectionPurposeInput:"purpose",sectionName:"title",sectionNotes:"notes",sectionText:"text",figureDescription:"figure_description",figureCaption:"caption"};
    Object.entries(edits).forEach(([id,key])=>$(id).addEventListener("input",()=>{
        const s=current();if(!s)return;s[key]=$(id).value;s.approved=false;changed();approvalStatus();renderSteps();renderPoster();
        if(key==="title")$("sectionTitle").textContent=s.title;
        if(key==="purpose")$("sectionPurpose").textContent=s.purpose;
    }));
    $("draftSection").addEventListener("click",async()=>{
        const s=current();if(!s)return;
        if (!s.notes.trim()) {
            message("Add source notes above first. Paste the facts or paragraph you want condensed, then click Draft concise poster text.", true);
            $("sectionNotes").focus();
            return;
        }
        try {
            const data=await request("draft",{document:aiDocument(),section_id:s.id});
            if(data.text){s.text=data.text;s.approved=false;changed();$("sectionText").value=s.text;approvalStatus();renderSteps();renderPoster();}
            $("draftQuestions").replaceChildren(...[...(data.questions||[]).map(t=>node("p",`Question: ${t}`)),...(data.editorial_notes||[]).map(t=>node("p",t))]);
            message(data.text?"Draft ready. Check it against your notes, edit if needed, then approve it.":"More source information is needed. Answer the questions and try again.");
        } catch(error){message(error.message,true);}
    });
    $("approveSection").addEventListener("click",()=>{
        const s=current();if(!s)return;
        if(s.kind==="figure"?(!s.imageData||!s.caption.trim()||!s.figure_description.trim()):!s.text.trim()){message(s.kind==="figure"?"Add a figure, description and caption before approving.":"Add poster wording before approving.",true);return;}
        s.approved=true;changed();approvalStatus();renderSteps();renderPoster();message(`${s.title} is approved and placed on the poster.`);
    });
    $("nextSection").addEventListener("click",()=>{const i=doc.sections.findIndex(s=>s.id===selected);selected=doc.sections[(i+1)%doc.sections.length]?.id;renderAll();});
    ["x","y","w","h"].forEach(k=>$("section"+k.toUpperCase()).addEventListener("change",()=>{
        const s=current(),value=Number($("section"+k.toUpperCase()).value);if(!s||!Number.isFinite(value))return;
        s.rect=C.clampRect({...s.rect,[k]:value/100});changed();updatePlacement();renderPoster();
    }));
    $("sectionFont").addEventListener("change",()=>{const s=current(),value=Number($("sectionFont").value);if(!s||!Number.isFinite(value))return;s.font_size=Math.max(16,Math.min(72,value));changed();renderPoster();});
    function reorder(delta){const i=doc.sections.findIndex(s=>s.id===selected),j=i+delta;if(j<0||j>=doc.sections.length)return;[doc.sections[i],doc.sections[j]]=[doc.sections[j],doc.sections[i]];doc.sections=C.arrange(doc.sections,doc.template);changed();renderAll();}
    $("moveEarlier").addEventListener("click",()=>reorder(-1));$("moveLater").addEventListener("click",()=>reorder(1));
    $("removeSection").addEventListener("click",()=>{const s=current();if(!s||!confirm(`Remove ${s.title} and its content? Save an editable draft first if you need a backup.`))return;doc.sections=doc.sections.filter(x=>x.id!==s.id);selected=doc.sections[0]?.id||null;changed();syncSetup();renderAll();});
    function addSection(kind){
        if(doc.sections.length>=20){message("This poster already has 20 sections.",true);return;}
        const s={...sectionDefaults({id:crypto.randomUUID(),title:kind==="figure"?"Figure":"New section",purpose:kind==="figure"?"Show evidence and connect it to the poster’s message.":"Give this section a distinct purpose.",question:"What information should the reader take away?"}),kind};
        doc.sections=C.arrange([...doc.sections,s],doc.template);selected=s.id;changed();syncSetup();renderAll();
    }
    $("addTextSection").addEventListener("click",()=>addSection("text"));$("addFigure").addEventListener("click",()=>addSection("figure"));
    $("figureFile").addEventListener("change",async event=>{
        const s=current(),file=event.target.files[0];if(!s||!file)return;
        try {
            if(!["image/png","image/jpeg"].includes(file.type)||file.size>12*1024*1024)throw new Error("Choose a PNG or JPEG up to 12 MB.");
            const bitmap=await createImageBitmap(file);
            const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
            const imageCanvas=document.createElement("canvas");imageCanvas.width=Math.round(bitmap.width*scale);imageCanvas.height=Math.round(bitmap.height*scale);imageCanvas.getContext("2d").drawImage(bitmap,0,0,imageCanvas.width,imageCanvas.height);bitmap.close();
            const data=imageCanvas.toDataURL("image/png");if(data.length>3*1024*1024)throw new Error("This figure is too large after resizing. Use a smaller PNG or JPEG.");
            if(doc.sections.reduce((total,section)=>total+(section===s?0:(section.imageData||"").length),data.length)>8*1024*1024)throw new Error("The poster's figures exceed the editable-draft size limit. Use smaller images before adding this figure.");
            if(!doc.sections.includes(s))return;s.imageData=data;s.approved=false;changed();preloadImages();approvalStatus();renderPoster();if(current()===s){$("figureThumbnail").hidden=false;$("figureThumbnail").src=s.imageData;}message("Figure added. Describe what it shows, add its caption, and approve it.");
        }catch(error){message(error.message,true);}finally{event.target.value="";}
    });
    function switchTemplate(name){doc.template=name;doc.sections=C.arrange(doc.sections,name);changed();renderAll();message("Layout changed. Approved wording is unchanged; check fit and figure sizes.");}
    $("builderTemplate").addEventListener("change",()=>switchTemplate($("builderTemplate").value));
    $("builderZoom").addEventListener("change",fitStage);new ResizeObserver(fitStage).observe($("builderViewport"),{box:"border-box"});
    $("compareTemplates").addEventListener("click",()=>{
        $("templateOptions").replaceChildren();
        Object.entries(C.TEMPLATES).forEach(([id,template])=>{
            const option=node("article"),title=node("h3",template.name),preview=document.createElement("canvas");
            const issues=drawPoster(preview,{...doc,template:id,sections:C.arrange(doc.sections,id)});
            const warnings=node("p",issues.length?`${issues.length} fit warnings — inspect before choosing.`:"No text overflow detected in this layout.");
            const choose=node("button","Use this layout");choose.type="button";choose.addEventListener("click",()=>{switchTemplate(id);$("templateDialog").close();});
            option.append(title,preview,warnings,choose);$("templateOptions").append(option);
        });$("templateDialog").showModal();
    });
    $("closeTemplateDialog").addEventListener("click",()=>$("templateDialog").close());
    function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
    $("backupDraft").addEventListener("click",()=>{download(new Blob([JSON.stringify(doc,null,2)],{type:"application/json"}),"posteriq-editable-draft.json");backupRevision=doc.revision;message("Editable draft download started. It includes your source notes and figures.");});
    function figureImagesReady() {
        return doc.sections.filter(s=>s.kind==="figure"&&s.approved).every(s=>{
            const image=images.get(s.imageData);return image?.complete&&image.naturalWidth;
        });
    }
    $("downloadPoster").addEventListener("click",()=>{
        const button=$("downloadPoster");if(button.disabled)return;
        if(!figureImagesReady()){message("Wait for the figure images to load, or replace an unavailable figure before export.",true);return;}
        renderPoster();const issues=[...C.warnings(doc),...drawPoster(canvas,doc)];
        if(issues.length&&!confirm(`${issues.length} layout/completion warnings remain. Download this draft mockup anyway?`))return;
        button.disabled=true;button.textContent="Preparing PNG…";message("Preparing the poster mockup PNG…");
        canvas.toBlob(blob=>{button.disabled=false;button.textContent="Download mockup PNG";if(!blob){message("The PNG could not be prepared. Try again.",true);return;}download(blob,"posteriq-built-poster-mockup.png");message("Mockup PNG download started. Check your browser’s downloads.");},"image/png");
    });
    $("importDraft").addEventListener("change",async event=>{
        const file=event.target.files[0];if(!file)return;
        try{if(file.size>10*1024*1024)throw new Error("The draft file must be under 10 MB.");const candidate=C.validateImport(JSON.parse(await file.text()));
            if(doc.sections.length&&!confirm("Replace the current poster with this draft? Save a backup first if needed."))return;
            doc=candidate;selected=doc.sections[0]?.id||null;images.clear();changed();syncSetup();renderAll();preloadImages();$("consistencyResults").hidden=true;message("Editable draft opened.");
        }catch(error){message(error.message,true);}finally{event.target.value="";}
    });
    $("newPoster").addEventListener("click",()=>{if(!confirm("Start a new poster? Save an editable draft first to keep your current work."))return;doc=C.createDocument();selected=null;images.clear();changed();syncSetup();renderAll();$("consistencyResults").hidden=true;message("New poster started.");});
    $("checkPoster").addEventListener("click",async()=>{
        if(!doc.sections.length||doc.sections.some(s=>!s.approved)){message("Approve each section (or remove unused ones) before reviewing the assembled poster.",true);return;}
        if(!figureImagesReady()){message("Wait for the figure images to load, or replace an unavailable figure before review.",true);return;}
        renderPoster();
        try{const result=await request("review",{document:aiDocument(),poster_image:canvas.toDataURL("image/png")});doc.review=result;reviewRevision=doc.revision;renderReview(result);scheduleSave();message("Consistency review ready. Suggested changes need your review and approval.");$("consistencyResults").scrollIntoView({behavior:"smooth"});}
        catch(error){message(error.message,true);}
    });
    function renderReview(result){
        $("consistencyResults").hidden=false;$("reviewStale").textContent="";
        const content=$("consistencyContent");content.replaceChildren(node("p",result.overview));
        for(const [title,items] of [["Strengths",result.strengths],["Questions to resolve",result.questions],["Limits of this review",result.limitations]]){
            if(!items?.length)continue;content.append(node("h3",title));const ul=node("ul");items.forEach(t=>ul.append(node("li",t)));content.append(ul);
        }
        if(!result.findings?.length)content.append(node("p","No clear consistency issues were identified. This does not certify scientific accuracy or publication readiness."));
        (result.findings||[]).forEach(finding=>{
            const article=node("article");article.append(node("h3",finding.issue),node("p",`Evidence: ${finding.evidence}`),node("p",finding.recommendation));
            if(finding.source_reference_ids?.length)article.append(node("p",`Guidance: ${finding.source_reference_ids.join(", ")}`));
            if(finding.suggested_text){
                article.append(node("pre",finding.suggested_text));
                if(finding.section_ids?.length===1){const use=node("button","Use as an unapproved draft");use.type="button";use.addEventListener("click",()=>{
                    if(doc.revision!==reviewRevision){message("This review is out of date. Run it again before applying a suggestion.",true);return;}
                    const s=doc.sections.find(s=>s.id===finding.section_ids[0]);if(!s||s.kind!=="text")return;
                    s.text=finding.suggested_text;s.approved=false;selected=s.id;changed();renderAll();message("Suggestion placed in the editor. Review it and approve before it returns to the poster.");$("sectionEditor").scrollIntoView({behavior:"smooth"});
                });article.append(use);}
            }content.append(article);
        });
    }
    window.addEventListener("beforeunload",event=>{if(saving||(storageUnsaved&&backupRevision!==doc.revision)){event.preventDefault();event.returnValue="";}});
    openSaved();
})();
