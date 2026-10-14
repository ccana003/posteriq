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
        for (const s of approved) {
            if (s.kind === "figure" && !s.caption.trim()) result.push(`${s.title}: add a caption.`);
            for (const other of approved) {
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
            section.font_size = Number.isFinite(s.font_size) ? Math.max(16,Math.min(72,s.font_size)) : 28;
            section.requirement_level = s.requirement_level === "required" ? "required" : "recommended";
            section.sources = Array.isArray(s.sources) ? s.sources.filter(r => r && ["reference_id","source","text"].every(k => typeof r[k] === "string" || r[k] === null)).slice(0,12) : [];
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
    return {TEMPLATES, createDocument, arrange, clampRect, wrap, warnings, validateImport};
})();
if (typeof module !== "undefined") module.exports = PosterBuilderCore;
