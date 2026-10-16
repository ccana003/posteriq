/* Guided authoring. Approved text is stable until the author edits it. */
(() => {
    const C = PosterBuilderCore;
    const API = ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:7071/api" : "https://posteriq-api-dme7bwfug7azd9h3.westus3-01.azurewebsites.net/api";
    const $ = id => document.getElementById(id);
    const node = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
    let doc = C.createDocument(), selected = null, db = null, busy = false, saving = false, saveTimer, reviewRevision = null, storageUnsaved = false, backupRevision = -1;
    const images = new Map();
    let articleResult = null;
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
            const remove=node("button","×","builder-remove-step");remove.type="button";remove.setAttribute("aria-label",`Remove ${s.title}`);
            remove.addEventListener("click",()=>removeSection(s.id));
            li.append(button,remove); $("sectionSteps").append(li);
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
        $("showFigureTitle").checked=s.show_title===true;
        $("figureSizing").value=s.image_sizing||"proportional";
        $("figureThumbnail").hidden = !s.imageData;
        if(s.imageData) $("figureThumbnail").src = s.imageData;
        else $("figureThumbnail").removeAttribute("src");
        if(s.kind==="figure" && s.source_filename) $("sectionSources").append(node("p",`Figure source: ${s.source_filename}${s.source_page ? ` · PDF page ${s.source_page}` : ""}. Verify the crop and caption before approving.`));
        if (s.source_excerpts?.length) {
            const evidence = node("details"), heading = node("summary", `Article source: ${s.source_filename || "Uploaded article"}`);
            evidence.append(heading);
            s.source_excerpts.forEach(excerpt => {
                evidence.append(node("strong", `Page ${excerpt.page} · ${excerpt.block_id}`), node("p", excerpt.text));
            });
            $("sectionSources").append(evidence);
        }
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
    function figureMetrics(s, poster, ctx, image, boxWidth) {
        const width=1200, pad=4;
        const font=s.font_size*width/(poster.width_in*72), lineH=font*1.25;
        const headingSize=Math.max(12,font*1.2);
        ctx.font=`bold ${headingSize}px Arial`;
        const heads=s.show_title===true?C.wrap(ctx,s.title,boxWidth-pad*2):[];
        const headH=heads.length?heads.length*headingSize*1.2+pad*2:pad;
        ctx.font=`${font}px Arial`;
        const captions=s.caption.trim()?C.wrap(ctx,s.caption,boxWidth-pad*2):[];
        const captionH=captions.length?captions.length*lineH+pad:0;
        const imageW=Math.max(1,boxWidth-pad*2);
        const imageH=image?.naturalWidth?imageW*image.naturalHeight/image.naturalWidth:0;
        return {pad,font,lineH,headingSize,heads,headH,captions,captionH,imageW,imageH,totalH:headH+imageH+captionH+pad};
    }
    function fitFigureRect(s, requestedWidth=s.rect.w, maxHeight=.8) {
        const image=images.get(s.imageData);if(!image?.naturalWidth)return s.rect;
        const height=1200*doc.height_in/doc.width_in,ctx=canvas.getContext("2d");
        let width=Math.max(.08,Math.min(.95,requestedWidth));
        let metrics=figureMetrics(s,doc,ctx,image,width*1200);
        for(let i=0;i<12&&metrics.totalH>height*maxHeight&&width>.08;i++){
            width=Math.max(.08,width*.9);metrics=figureMetrics(s,doc,ctx,image,width*1200);
        }
        return C.clampRect({...s.rect,w:width,h:Math.min(maxHeight,metrics.totalH/height)});
    }
    function arrangePoster(sections,template) {
        return C.arrange(sections,template).map(s=>s.kind==="figure"&&(s.image_sizing||"proportional")==="proportional"?{...s,rect:fitFigureRect(s,s.rect.w,s.rect.h)}:s);
    }
    function resizeFigure(s,start,dx,dy) {
        if(s.kind!=="figure"||s.image_sizing&&s.image_sizing!=="proportional")return C.clampRect({...start,w:start.w+dx,h:start.h+dy});
        const widthChange=Math.abs(dx/start.w)>=Math.abs(dy/start.h)?dx:dy*start.w/start.h;
        return fitFigureRect({...s,rect:start},start.w+widthChange);
    }
    function drawPoster(target, document) {
        const width = 1200, height = Math.round(width * document.height_in / document.width_in);
        target.width = width; target.height = height;
        const ctx = target.getContext("2d"), issues = [];
        const theme = getComputedStyle(window.document.documentElement);
        const green = theme.getPropertyValue("--brand-green").trim() || "#005030";
        const orange = theme.getPropertyValue("--brand-orange").trim() || "#f47321";
        const tint = theme.getPropertyValue("--brand-tint").trim() || "#f2f7f4";
        const ctsi = /^ctsi-[1-5]$/.test(document.template);
        // Header image is loaded asynchronously; redraw once available.
        const headerArt = window.__ctsiHeaderArt || (window.__ctsiHeaderArt = new Image());
        if (ctsi && !headerArt.src) {
            headerArt.onload = () => { if (canvas.isConnected) renderPoster(); };
            headerArt.src = "../CTSI_Header_Clean_v2.png";
        }
        ctx.fillStyle = ctsi ? green : "white"; ctx.fillRect(0,0,width,height);
        if (!ctsi) {
            ctx.fillStyle = green; ctx.fillRect(0,0,width,height*.155);
            ctx.fillStyle = orange; ctx.fillRect(0,height*.155,width,6);
        }
        if (ctsi && headerArt.complete && headerArt.naturalWidth) {
            ctx.drawImage(headerArt,0,0,width,height*.155);
        }
        // CTSI text occupies the left portion of the artwork, above the first content panels.
        ctx.fillStyle = "white"; ctx.textBaseline = "top";
        const textX = 30, textWidth = ctsi ? width*.61 : width-60;
        const headerLimit = height*.155;
        ctx.save();
        if (ctsi) { ctx.beginPath(); ctx.rect(textX,0,textWidth,headerLimit-5); ctx.clip(); }
        let titleSize = ctsi ? 29 : 32;
        let titles;
        do {
            ctx.font = `bold ${titleSize}px Arial`;
            titles = C.wrap(ctx,document.title || "Your poster title",textWidth);
            if (titles.length <= 2 || titleSize <= 20) break;
            titleSize -= 1;
        } while (true);
        if (titles.length > 2) issues.push("The title is too long for the CTSI header; shorten it before export.");
        const titleY = 18, titleLineHeight = titleSize*1.13;
        titles.slice(0,2).forEach((line,i)=>ctx.fillText(line,textX,titleY+i*titleLineHeight));
        const credits = [document.authors,document.affiliations].filter(Boolean).join(" · ") || "Author names · Affiliations";
        const creditY = ctsi ? Math.max(76,titleY+Math.min(titles.length,2)*titleLineHeight+9) : headerLimit-45;
        const creditSpace = Math.max(0,headerLimit-creditY-10);
        let creditSize = ctsi ? 16 : 17, creditLines;
        do {
            ctx.font = `${creditSize}px Arial`;
            creditLines = C.wrap(ctx,credits,textWidth);
            if (creditLines.length*creditSize*1.2 <= creditSpace || creditSize <= 11) break;
            creditSize -= 1;
        } while (true);
        const maxCreditLines = ctsi ? Math.max(0,Math.floor(creditSpace/(creditSize*1.2))) : 2;
        if (creditLines.length > maxCreditLines) issues.push("Authors and affiliations do not fit in the CTSI header. Shorten the list or adjust the poster.");
        creditLines.slice(0,maxCreditLines).forEach((line,i)=>ctx.fillText(line,textX,creditY+i*creditSize*1.2));
        ctx.restore();
        document.sections.forEach(s => {
            const r = {x:s.rect.x*width,y:s.rect.y*height,w:s.rect.w*width,h:s.rect.h*height};
            ctx.save(); ctx.beginPath(); ctx.rect(r.x,r.y,r.w,r.h); ctx.clip();
            ctx.fillStyle = ctsi ? "#ffffff" : tint;
            if (ctsi) {
                ctx.beginPath(); ctx.roundRect(r.x,r.y,r.w,r.h,Math.min(12,r.w*.04,r.h*.08)); ctx.fill();
            } else ctx.fillRect(r.x,r.y,r.w,r.h);
            if(s.kind==="figure") {
                const image=images.get(s.imageData),m=figureMetrics(s,document,ctx,image,r.w);
                ctx.fillStyle=green;ctx.font=`bold ${m.headingSize}px Arial`;
                m.heads.forEach((line,i)=>ctx.fillText(line,r.x+m.pad,r.y+m.pad+i*m.headingSize*1.2));
                let y=r.y+m.headH;
                if(!s.approved){ctx.font=`${m.font}px Arial`;ctx.fillStyle="#657a83";ctx.fillText("Awaiting author approval",r.x+m.pad,y);ctx.restore();return;}
                const availableH=Math.max(1,r.h-m.headH-m.captionH-m.pad);
                if(image?.complete&&image.naturalWidth){
                    if(m.imageW<80||Math.min(m.imageH,availableH)<60)issues.push(`${s.title}: the figure is too small to inspect comfortably. Enlarge it or free space on the board.`);
                    if(s.image_sizing==="crop"){
                        const scale=Math.max(m.imageW/image.naturalWidth,availableH/image.naturalHeight);
                        const sw=m.imageW/scale,sh=availableH/scale;
                        ctx.drawImage(image,(image.naturalWidth-sw)/2,(image.naturalHeight-sh)/2,sw,sh,r.x+m.pad,y,m.imageW,availableH);
                        y+=availableH;
                    }else if(s.image_sizing==="stretch"){
                        ctx.drawImage(image,r.x+m.pad,y,m.imageW,availableH);y+=availableH;
                    }else{
                        const scale=Math.min(m.imageW/image.naturalWidth,availableH/image.naturalHeight);
                        const iw=image.naturalWidth*scale,ih=image.naturalHeight*scale;
                        ctx.drawImage(image,r.x+(r.w-iw)/2,y,iw,ih);y+=ih;
                        if(iw<m.imageW*.9)issues.push(`${s.title}: the region is too short for a full-width figure. Use Fit section to image.`);
                    }
                }else issues.push(`${s.title}: figure image is unavailable.`);
                if(m.captions.length)y+=m.pad;
                ctx.font=`${m.font}px Arial`;ctx.fillStyle="#253746";
                if(y+m.captions.length*m.lineH>r.y+r.h-m.pad+.5)issues.push(`${s.title}: caption overflows its region.`);
                m.captions.forEach((line,i)=>ctx.fillText(line,r.x+m.pad,y+i*m.lineH));
                ctx.restore();return;
            }
            const pad = 12, headingSize = Math.max(12, s.font_size*1.2*width/(document.width_in*72));
            ctx.fillStyle = ctsi ? "#ffffff" : green; ctx.font = `bold ${headingSize}px Arial`;
            const heads = C.wrap(ctx,s.title,r.w-pad*2), headH=heads.length*(headingSize*1.2)+pad*2;
            if (ctsi) {
                ctx.fillStyle = orange;
                ctx.beginPath(); ctx.roundRect(r.x,r.y,r.w,headH,[10,10,0,0]); ctx.fill();
                ctx.fillStyle = "#ffffff";
            }
            heads.forEach((line,i)=>ctx.fillText(line,r.x+pad,r.y+pad+i*headingSize*1.2));
            if (!ctsi) { ctx.fillStyle = orange; ctx.fillRect(r.x,r.y,4,headH); }
            const font = s.font_size*width/(document.width_in*72), lineH=font*1.25;
            ctx.font = `${font}px Arial`; ctx.fillStyle = "#253746";
            let y = r.y+headH+(ctsi ? Math.max(9,font*.65) : 0);
            if (!s.approved) { ctx.fillStyle = "#657a83"; ctx.fillText("Awaiting author approval",r.x+pad,y); ctx.restore(); return; }
            let body = s.text;
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
    function settleSection(id, rect, quiet=false) {
        const result=C.placeSection(doc.sections,id,rect,doc.template);
        doc.sections=result.sections;
        const active=doc.sections.find(s=>s.id===id);
        if(active?.kind==="figure"&&(active.image_sizing||"proportional")==="proportional"&&images.get(active.imageData)?.naturalWidth)active.figure_fitted=true;
        if(result.mode==="grid")doc.sections=doc.sections.map(s=>s.kind==="figure"&&(s.image_sizing||"proportional")==="proportional"?{...s,rect:fitFigureRect(s,s.rect.w,s.rect.h)}:s);
        if(!quiet&&result.mode==="grid")message("The board returned to template slots to prevent overlap. Wording and font sizes are unchanged; check text fit.");
        else if(!quiet)message("Section placed. Other sections moved as needed to keep the board clear.");
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
                    event.preventDefault(); s.rect=C.clampRect({...s.rect,x:s.rect.x+(event.key==="ArrowRight"?.01:event.key==="ArrowLeft"?-.01:0),y:s.rect.y+(event.key==="ArrowDown"?.01:event.key==="ArrowUp"?-.01:0)}); settleSection(s.id,s.rect); changed(); renderSteps(); renderPoster(); updatePlacement();
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
                    moved=true; s.rect=C.clampRect(resizing?resizeFigure(s,start,dx,dy):{...start,x:start.x+dx,y:start.y+dy});
                    Object.assign(item.style,{left:s.rect.x*100+"%",top:s.rect.y*100+"%",width:s.rect.w*100+"%",height:s.rect.h*100+"%"});
                    drawPoster(canvas,doc); updatePlacement();
                };
                const end=()=>{item.removeEventListener("pointermove",move); item.removeEventListener("pointerup",end); item.removeEventListener("pointercancel",end); if(moved){settleSection(s.id,s.rect);changed();renderSteps();updatePlacement();} renderPoster();};
                item.addEventListener("pointermove",move);item.addEventListener("pointerup",end);item.addEventListener("pointercancel",end);
            });
            $("builderHandles").append(item);
        });
    }
    function preloadImages() {
        doc.sections.filter(s=>s.kind==="figure"&&s.imageData).forEach(s=>{
            if(images.has(s.imageData)){
                if(!s.figure_fitted&&images.get(s.imageData).naturalWidth&&(s.image_sizing||"proportional")==="proportional"){
                    settleSection(s.id,fitFigureRect(s),true);changed();renderSteps();updatePlacement();
                }
                return;
            }
            const image=new Image(); images.set(s.imageData,image); image.onload=()=>{
                const figures=doc.sections.filter(section=>section.kind==="figure"&&!section.figure_fitted&&section.imageData===s.imageData&&(section.image_sizing||"proportional")==="proportional");
                figures.forEach(section=>{settleSection(section.id,fitFigureRect(section),true);doc.sections.find(item=>item.id===section.id).figure_fitted=true;});
                if(figures.length){changed();renderSteps();updatePlacement();}
                renderPoster();
            }; image.onerror=()=>message(`Unable to load ${s.title}. Replace its figure.`,true); image.src=s.imageData;
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
        const buttons=[$("planPoster"),$("draftSection"),$("checkPoster"),$("analyzeArticle")];buttons.forEach(b=>b.disabled=true);
        const actionButton = action === "article" ? $("analyzeArticle") : action === "draft" ? $("draftSection") : action === "plan" ? $("planPoster") : $("checkPoster");
        const buttonLabel = actionButton.textContent;
        actionButton.textContent = action === "article" ? "Reading and drafting article…" : action === "draft" ? "Drafting…" : action === "plan" ? "Creating outline…" : "Reviewing…";
        actionButton.setAttribute("aria-busy", "true");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), action === "article" ? 180000 : 120000);
        try {
            const response=await fetch(`${API}/builder/${action}`,{method:"POST",headers:payload instanceof FormData ? {} : {"Content-Type":"application/json"},body:payload instanceof FormData ? payload : JSON.stringify(payload),signal:controller.signal});
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
        doc.sections=arrangePoster(data.sections.map(sectionDefaults),doc.template);doc.plan_notes=data.notes||[];
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
        const s=current();if(!s)return;s[key]=$(id).value;s.approved=false;
        if(s.kind==="figure"&&key==="caption"&&(s.image_sizing||"proportional")==="proportional")settleSection(s.id,fitFigureRect(s),true);
        changed();approvalStatus();renderSteps();renderPoster();
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
        let rect=C.clampRect({...s.rect,[k]:value/100});
        if(s.kind==="figure"&&(s.image_sizing||"proportional")==="proportional"&&["w","h"].includes(k))rect=fitFigureRect(s,k==="w"?value/100:s.rect.w*(value/100)/s.rect.h);
        settleSection(s.id,rect);changed();updatePlacement();renderSteps();renderPoster();
    }));
    $("sectionFont").addEventListener("change",()=>{const s=current(),value=Number($("sectionFont").value);if(!s||!Number.isFinite(value))return;s.font_size=Math.max(16,Math.min(72,value));if(s.kind==="figure"&&(s.image_sizing||"proportional")==="proportional")settleSection(s.id,fitFigureRect(s),true);changed();renderPoster();});
    function reorder(delta){const i=doc.sections.findIndex(s=>s.id===selected),j=i+delta;if(j<0||j>=doc.sections.length)return;[doc.sections[i],doc.sections[j]]=[doc.sections[j],doc.sections[i]];doc.sections=arrangePoster(doc.sections,doc.template);changed();renderAll();}
    $("moveEarlier").addEventListener("click",()=>reorder(-1));$("moveLater").addEventListener("click",()=>reorder(1));
    function removeSection(id) {
        const index=doc.sections.findIndex(s=>s.id===id),s=doc.sections[index];
        if(!s||!confirm(`Remove ${s.title} and its content? Save an editable draft first if you need a backup.`))return;
        doc.sections=doc.sections.filter(x=>x.id!==s.id);
        if(selected===id)selected=doc.sections[Math.min(index,doc.sections.length-1)]?.id||null;
        changed();syncSetup();renderAll();message(`${s.title} was removed.`);
    }
    $("removeSection").addEventListener("click",()=>removeSection(selected));
    function addSection(kind){
        if(doc.sections.length>=20){message("This poster already has 20 sections.",true);return;}
        const s={...sectionDefaults({id:crypto.randomUUID(),title:kind==="figure"?"Figure":"New section",purpose:kind==="figure"?"Show evidence and connect it to the poster’s message.":"Give this section a distinct purpose.",question:"What information should the reader take away?"}),kind};
        doc.sections=arrangePoster([...doc.sections,s],doc.template);selected=s.id;changed();syncSetup();renderAll();
    }
    $("addTextSection").addEventListener("click",()=>addSection("text"));$("addFigure").addEventListener("click",()=>addSection("figure"));
    $("showFigureTitle").addEventListener("change",()=>{
        const s=current();if(!s)return;s.show_title=$("showFigureTitle").checked;
        if((s.image_sizing||"proportional")==="proportional")settleSection(s.id,fitFigureRect(s));
        changed();renderSteps();renderPoster();updatePlacement();
    });
    $("figureSizing").addEventListener("change",()=>{
        const s=current();if(!s)return;s.image_sizing=$("figureSizing").value;
        if(s.image_sizing==="proportional")settleSection(s.id,fitFigureRect(s));
        changed();renderSteps();renderPoster();updatePlacement();
    });
    $("fitFigure").addEventListener("click",()=>{
        const s=current();if(!s)return;s.image_sizing="proportional";$("figureSizing").value="proportional";
        settleSection(s.id,fitFigureRect(s));changed();renderSteps();renderPoster();updatePlacement();
    });
    $("figureFile").addEventListener("change",async event=>{
        const s=current(),file=event.target.files[0];if(!s||!file)return;
        try {
            if(!["image/png","image/jpeg"].includes(file.type)||file.size>12*1024*1024)throw new Error("Choose a PNG or JPEG up to 12 MB.");
            const bitmap=await createImageBitmap(file);
            const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
            const imageCanvas=document.createElement("canvas");imageCanvas.width=Math.round(bitmap.width*scale);imageCanvas.height=Math.round(bitmap.height*scale);imageCanvas.getContext("2d").drawImage(bitmap,0,0,imageCanvas.width,imageCanvas.height);bitmap.close();
            const data=imageCanvas.toDataURL("image/png");if(data.length>3*1024*1024)throw new Error("This figure is too large after resizing. Use a smaller PNG or JPEG.");
            if(doc.sections.reduce((total,section)=>total+(section===s?0:(section.imageData||"").length),data.length)>8*1024*1024)throw new Error("The poster's figures exceed the editable-draft size limit. Use smaller images before adding this figure.");
            if(!doc.sections.includes(s))return;s.imageData=data;s.figure_fitted=false;s.approved=false;changed();preloadImages();approvalStatus();renderPoster();if(current()===s){$("figureThumbnail").hidden=false;$("figureThumbnail").src=s.imageData;}message("Figure added. Describe what it shows, add its caption, and approve it.");
        }catch(error){message(error.message,true);}finally{event.target.value="";}
    });
    function switchTemplate(name){
        if (!C.TEMPLATES[name]) { message("Unknown poster layout.",true); return; }
        if (doc.template === name) return;
        doc.template=name;
        doc.sections=arrangePoster(doc.sections,name);
        changed();renderAll();
        message("Layout changed. Approved wording and figures are unchanged; check fit and figure sizes.");
    }
    $("builderTemplate").addEventListener("change",()=>switchTemplate($("builderTemplate").value));
    $("builderZoom").addEventListener("change",fitStage);new ResizeObserver(fitStage).observe($("builderViewport"),{box:"border-box"});
    $("compareTemplates").addEventListener("click",()=>{
        $("templateOptions").replaceChildren();
        Object.entries(C.TEMPLATES).filter(([id])=>id.startsWith("ctsi-")).forEach(([id,template])=>{
            const option=node("article"),title=node("h3",template.name),preview=document.createElement("canvas");
            const issues=drawPoster(preview,{...doc,template:id,sections:arrangePoster(doc.sections,id)});
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
    $("articleForm").addEventListener("submit", async event => {
        event.preventDefault();
        const file = $("articleFile").files[0];
        if(!file || file.size>25*1024*1024 || !file.name.toLowerCase().endsWith(".pdf")) {
            $("articleStatus").textContent="Choose a PDF of at most 25 MB."; return;
        }
        const form = new FormData(); form.append("file",file);
        form.append("focus",$("articleFocus").value);form.append("poster_type",doc.poster_type);
        form.append("audience",doc.audience);form.append("event_requirements",doc.event_requirements);
        $("articleStatus").textContent="Reading the article and drafting source-linked sections. This can take a few minutes…";
        $("articleProposals").hidden=true;articleResult=null;
        try {
            const result = await request("article",form);
            articleResult=result;
            $("articleMetadata").textContent=`${result.source_filename} · ${result.page_count} pages. Suggested title: ${result.title}. Suggested article authors: ${result.authors}. Citation: ${result.citation}`;
            $("articleLimitations").replaceChildren(...[...(result.questions||[]).map(q=>`Question: ${q}`),...(result.limitations||[])].map(t=>node("li",t)));
            $("articleSectionChoices").replaceChildren();
            result.sections.forEach((section,index)=>{
                const card=node("article",null,"article-draft");
                const label=node("label",null,"article-checkbox"),check=document.createElement("input");check.type="checkbox";check.checked=true;check.dataset.articleSection=index;
                label.append(check,document.createTextNode(section.title));
                const purpose=node("p",section.purpose),draft=node("pre",section.text);
                const refs=node("details"),summary=node("summary",`Source pages: ${[...new Set(section.source_excerpts.map(e=>e.page))].join(", ")}`);refs.append(summary);
                section.source_excerpts.forEach(e=>refs.append(node("strong",`Page ${e.page} · ${e.block_id}`),node("p",e.text)));
                card.append(label,purpose,draft,refs);$("articleSectionChoices").append(card);
            });
            $("articleFigureChoices").replaceChildren();
            (result.figures||[]).forEach((figure,index)=>{
                const card=node("label",null,"article-figure"),check=document.createElement("input");check.type="checkbox";check.checked=figure.recommended===true;check.dataset.articleFigure=index;
                const img=document.createElement("img");img.src=figure.imageData;img.alt=figure.label;
                card.append(check,node("span",`${figure.label} — ${figure.recommended ? "selected as a draft figure section" : "optional image candidate"}`),img);
                if(figure.caption)card.append(node("p",figure.caption));$("articleFigureChoices").append(card);
            });
            if(!result.figures?.length)$("articleFigureChoices").append(node("p","No suitable embedded image regions were found. Upload figures separately in the builder."));
            $("articleImportMode").value=doc.sections.length?"append":"new";
            $("articleUseMetadata").checked=!doc.sections.length&&!doc.title.trim()&&!doc.authors.trim()&&!doc.affiliations.trim();
            $("articleProposals").hidden=false;
            $("articleStatus").textContent="Drafts ready for review. Nothing has been added to your poster yet.";
        }catch(error){$("articleStatus").textContent=error.message;message(error.message,true);}
    });
    $("applyArticle").addEventListener("click",()=>{
        if(!articleResult)return;
        const drafts=Array.from($("articleSectionChoices").querySelectorAll("input:checked")).map(input=>articleResult.sections[Number(input.dataset.articleSection)]);
        const figures=Array.from($("articleFigureChoices").querySelectorAll("input:checked")).map(input=>articleResult.figures[Number(input.dataset.articleFigure)]);
        const replacing=$("articleImportMode").value==="new";
        if(!drafts.length&&!figures.length){$("articleStatus").textContent="Select at least one draft or image candidate.";return;}
        if((replacing?0:doc.sections.length)+drafts.length+figures.length>20){$("articleStatus").textContent="Choose fewer drafts: a poster supports up to 20 sections.";return;}
        if(doc.sections.length&&replacing&&!confirm("Start a new poster from this article? Save an editable backup first to keep the current poster."))return;
        const oldDoc=doc;
        const additions=drafts.map(draft=>({...sectionDefaults({...draft,id:crypto.randomUUID()}),text:draft.text,notes:draft.notes,source_filename:draft.source_filename,source_excerpts:draft.source_excerpts}));
        figures.forEach(figure=>additions.push({...sectionDefaults({id:crypto.randomUUID(),title:figure.label,purpose:"Show article evidence; verify the original caption.",question:"What does this image show? Supply its caption and confirm it is complete."}),kind:"figure",imageData:figure.imageData,caption:(figure.caption||""),figure_description:(figure.caption||""),source_filename:articleResult.source_filename,source_page:figure.page,source_excerpts:[]}));
        const totalImageSize=[...(replacing?[]:doc.sections),...additions].reduce((n,s)=>n+(s.imageData||"").length,0);
        if(totalImageSize>8*1024*1024){$("articleStatus").textContent="Choose fewer image candidates to keep the editable draft under its size limit.";return;}
        if(replacing)doc={...C.createDocument(),title:oldDoc.title,authors:oldDoc.authors,affiliations:oldDoc.affiliations,poster_type:oldDoc.poster_type,audience:oldDoc.audience,event_requirements:oldDoc.event_requirements,width_in:oldDoc.width_in,height_in:oldDoc.height_in,template:oldDoc.template};
        if($("articleUseMetadata").checked){doc.title=articleResult.title.slice(0,500);doc.authors=articleResult.authors.slice(0,2000);doc.affiliations=articleResult.affiliations.slice(0,3000);}
        const previous=doc.sections;
        const layout=arrangePoster([...previous,...additions],doc.template);
        doc.sections=[...previous,...layout.slice(previous.length)];
        for(const added of additions){
            const s=doc.sections.find(s=>s.id===added.id);
            if(doc.sections.some(other=>other.id!==s.id&&C.intersects(s.rect,other.rect)))settleSection(s.id,s.rect);
        }
        doc.plan_notes=[...doc.plan_notes,`Article source: ${articleResult.source_filename}. Citation: ${articleResult.citation}. Verify poster authorship, source support and applicable requirements.`,...articleResult.limitations].slice(0,20);
        selected=additions[0].id;changed();syncSetup();renderAll();preloadImages();
        $("articleProposals").hidden=true;$("articleImport").open=false;articleResult=null;
        message("Selected article drafts were added unapproved. Review each source excerpt, revise the text, and approve it. Existing sections and their placement were retained when adding to a poster.");
        $("sectionEditor").scrollIntoView({behavior:"smooth"});
    });
    window.addEventListener("beforeunload",event=>{if(saving||(storageUnsaved&&backupRevision!==doc.revision)){event.preventDefault();event.returnValue="";}});
    openSaved();
})();
