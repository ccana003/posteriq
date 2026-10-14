/* Editable poster data and shared layout logic. No AI or browser storage here. */
const PosterBuilderCore = (() => {
    const TEMPLATES = {
        three: {name: "Three columns · provisional", columns: 3},
        two: {name: "Two columns · provisional", columns: 2}
    };
    function createDocument() {
        return {version: 1, poster_type: "research", title: "", authors: "", affiliations: "",
            audience: "", event_requirements: "", width_in: 48, height_in: 36,
            template: "three", sections: [], plan_notes: [], revision: 0, review: null};
    }
    function arrange(sections, template) {
        const columns = TEMPLATES[template].columns;
        const rows = Math.max(1, Math.ceil(sections.length / columns));
        const gap = .015, margin = .025, top = .19, bottom = .025;
        const width = (1 - margin * 2 - gap * (columns - 1)) / columns;
        const height = (1 - top - bottom - gap * (rows - 1)) / rows;
        return sections.map((section, index) => ({...section, rect: {
            x: margin + (index % columns) * (width + gap),
            y: top + Math.floor(index / columns) * (height + gap), w: width, h: height}}));
    }
    function clampRect(rect) {
        const w = Math.max(.08, Math.min(.95, rect.w));
        const h = Math.max(.06, Math.min(.8, rect.h));
        return {x: Math.max(0, Math.min(1 - w, rect.x)), y: Math.max(.17, Math.min(1 - h, rect.y)), w, h};
    }
    function intersects(a, b, gap = .008) {
        return a.x < b.x+b.w+gap && a.x+a.w+gap > b.x && a.y < b.y+b.h+gap && a.y+a.h+gap > b.y;
    }
    function placeSection(sections, activeId, desired, template) {
        const active = sections.find(s => s.id === activeId);
        if (!active) return {sections, mode: "unchanged"};
        const anchor = {...active, rect: clampRect(desired)};
        const placed = [anchor], positions = new Map([[activeId, anchor.rect]]);
        const others = sections.filter(s=>s.id!==activeId).sort((a,b)=>b.rect.w*b.rect.h-a.rect.w*a.rect.h);
        for (const section of others) {
            const r = section.rect;
            const xs = new Set([r.x, .025, 1-.025-r.w]);
            const ys = new Set([r.y, .19, 1-.025-r.h]);
            placed.forEach(s=>{
                xs.add(s.rect.x+s.rect.w+.012); xs.add(s.rect.x-r.w-.012);
                ys.add(s.rect.y+s.rect.h+.012); ys.add(s.rect.y-r.h-.012);
            });
            const candidates=[];
            for(const x of xs)for(const y of ys){
                if(x<0||y<.17||x+r.w>1+.000001||y+r.h>1+.000001)continue;
                const candidate={x,y,w:r.w,h:r.h};
                if(!placed.some(s=>intersects(candidate,s.rect)))candidates.push(candidate);
            }
            candidates.sort((a,b)=>(a.x-r.x)**2+(a.y-r.y)**2-((b.x-r.x)**2+(b.y-r.y)**2));
            if(!candidates.length){
                // Full boards cannot always retain custom sizes. Reorder template
                // slots around the drop target rather than leaving items overlapping.
                const target=sections.filter(s=>s.id!==activeId).sort((a,b)=>{
                    const distance=s=>(s.rect.x+s.rect.w/2-anchor.rect.x-anchor.rect.w/2)**2+(s.rect.y+s.rect.h/2-anchor.rect.y-anchor.rect.h/2)**2;
                    return distance(a)-distance(b);
                })[0];
                const ordered=sections.filter(s=>s.id!==activeId);
                const insertion=target?ordered.findIndex(s=>s.id===target.id):0;
                ordered.splice(Math.max(0,insertion),0,anchor);
                return {sections:arrange(ordered,template), mode:"grid"};
            }
            positions.set(section.id,candidates[0]);placed.push({...section,rect:candidates[0]});
        }
        return {sections:sections.map(s=>({...s,rect:positions.get(s.id)})), mode:"packed"};
    }
    function wrap(context, text, width) {
        const lines = [];
        for (const paragraph of text.split(/\r?\n/)) {
            let line = "";
            for (const word of paragraph.split(/\s+/).filter(Boolean)) {
                const next = line ? `${line} ${word}` : word;
                if (line && context.measureText(next).width > width) { lines.push(line); line = word; }
                else line = next;
            }
            lines.push(line);
        }
        return lines;
    }
    function warnings(document) {
        const result = [];
        const approved = document.sections.filter(s => s.approved);
        if (!document.title.trim()) result.push("Add the poster title.");
        if (!document.authors.trim()) result.push("Add the author names.");
        if (!document.affiliations.trim()) result.push("Add affiliations or confirm your organizer's requirements.");
        if (document.sections.some(s => !s.approved)) result.push("Some sections are not approved and are shown as placeholders.");
        if (document.sections.some(s => s.font_size < 24)) result.push("Some body text is below the suggested 24-point starting size; check your applicable guidance.");
        for (const s of document.sections) {
            if(s.kind==="figure"&&s.image_sizing==="crop")result.push(`${s.title}: crop mode can hide axes, labels or legends; inspect before sharing.`);
            if(s.kind==="figure"&&s.image_sizing==="stretch")result.push(`${s.title}: stretch mode distorts image proportions; inspect before sharing.`);
            if (s.kind === "figure" && !s.caption.trim()) result.push(`${s.title}: add a caption.`);
            for (const other of document.sections) {
                if (s.id >= other.id) continue;
                const a = s.rect, b = other.rect;
                if (Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x) > .002 && Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y) > .002)
                    result.push(`${s.title} overlaps ${other.title}.`);
            }
        }
        return result;
    }
    function validateImport(value) {
        if (!value || value.version !== 1 || !["research", "protocol", "case", "narrative"].includes(value.poster_type)
            || !TEMPLATES[value.template] || !Array.isArray(value.sections) || value.sections.length > 20)
            throw new Error("This is not a supported PosterIQ builder draft.");
        const result = createDocument();
        for (const key of ["title", "authors", "affiliations", "audience", "event_requirements"]) {
            if (typeof value[key] !== "string" || value[key].length > 12000) throw new Error("The saved poster contains invalid text.");
            result[key] = value[key];
        }
        for (const key of ["width_in", "height_in"]) {
            if (!Number.isFinite(value[key]) || value[key] < 12 || value[key] > 96) throw new Error("Poster dimensions must be between 12 and 96 inches.");
            result[key] = value[key];
        }
        result.poster_type = value.poster_type; result.template = value.template;
        result.plan_notes = Array.isArray(value.plan_notes) ? value.plan_notes.filter(x => typeof x === "string").slice(0, 20) : [];
        const ids = new Set();
        result.sections = value.sections.map(s => {
            if (!s || typeof s.id !== "string" || !s.id || ids.has(s.id) || !["text", "figure"].includes(s.kind)) throw new Error("A saved section is invalid.");
            ids.add(s.id);
            const section = {id: s.id, kind: s.kind, approved: s.approved === true};
            for (const key of ["title", "purpose", "question", "notes", "text", "caption", "figure_description"]) {
                if (s[key] != null && (typeof s[key] !== "string" || s[key].length > 12000)) throw new Error("A saved section contains invalid text.");
                section[key] = s[key] || "";
            }
            if (!s.rect || !["x","y","w","h"].every(k => Number.isFinite(s.rect[k]))) throw new Error("A saved section has no usable position.");
            section.rect = clampRect(s.rect);
            section.figure_fitted = s.figure_fitted === true;
            section.show_title = s.kind !== "figure" || s.show_title === true;
            section.image_sizing = ["proportional","crop","stretch"].includes(s.image_sizing) ? s.image_sizing : "proportional";
            section.font_size = Number.isFinite(s.font_size) ? Math.max(16,Math.min(72,s.font_size)) : 28;
            section.requirement_level = s.requirement_level === "required" ? "required" : "recommended";
            section.sources = Array.isArray(s.sources) ? s.sources.filter(r => r && ["reference_id","source","text"].every(k => typeof r[k] === "string" || r[k] === null)).slice(0,12) : [];
            section.source_page = Number.isInteger(s.source_page) && s.source_page > 0 && s.source_page <= 40 ? s.source_page : null;
            section.source_filename = typeof s.source_filename === "string" ? s.source_filename.slice(0,200) : "";
            section.source_excerpts = Array.isArray(s.source_excerpts) ? s.source_excerpts.filter(e => e && Number.isInteger(e.page) && e.page > 0 && e.page <= 40 && typeof e.text === "string" && e.text.length <= 12000 && typeof e.block_id === "string").slice(0,12) : [];
            section.imageData = "";
            if (s.kind === "figure" && s.imageData) {
                if (typeof s.imageData !== "string" || s.imageData.length > 3*1024*1024 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s.imageData)) throw new Error("A saved figure must be a small embedded PNG or JPEG.");
                section.imageData = s.imageData;
            }
            if (s.kind === "figure" && !section.imageData) section.approved = false;
            return section;
        });
        return result;
    }
    return {TEMPLATES, createDocument, arrange, clampRect, intersects, placeSection, wrap, warnings, validateImport};
})();
if (typeof module !== "undefined") module.exports = PosterBuilderCore;
