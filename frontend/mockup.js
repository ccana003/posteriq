/* Draw only validated text edits over the original image. Never alter the PDF. */
async function loadMockupImage(imageUrl) {
    // The normal <img> may already have cached this URL without CORS headers.
    // Use a distinct URL and a fresh CORS request before drawing on a canvas.
    const url = new URL(imageUrl, window.location.href);
    url.searchParams.set("mockup", "1");
    const response = await fetch(url.href, {mode: "cors", cache: "no-store"});
    if (!response.ok) {
        throw new Error("The poster image could not be loaded. Try the preview again.");
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    try {
        return await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("The poster image could not be decoded. Try the preview again."));
            image.src = objectUrl;
        });
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function wrapMockupText(context, text, width) {
    const lines = [];
    for (const paragraph of text.split(/\r?\n/)) {
        let line = "";
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            if (context.measureText(word).width > width) return null;
            const candidate = line ? `${line} ${word}` : word;
            if (line && context.measureText(candidate).width > width) {
                lines.push(line);
                line = word;
            } else {
                line = candidate;
            }
        }
        lines.push(line);
    }
    return lines;
}

function fitMockupText(context, change, canvasWidth, canvasHeight) {
    const region = change.region;
    const box = {
        left: region.left * canvasWidth, top: region.top * canvasHeight,
        width: region.width * canvasWidth, height: region.height * canvasHeight
    };
    const baseSize = change.style.font_size * canvasWidth;
    if (!Number.isFinite(baseSize) || baseSize <= 0 || box.width <= 0 || box.height <= 0) return null;
    // Try the proposed size, then the original size. Never shrink below the source.
    for (let scale = change.font_scale; scale >= 1; scale = Math.max(1, scale - 0.05)) {
        const size = baseSize * scale;
        const font = `${change.style.bold ? "bold " : ""}${size}px ${change.style.font_family}`;
        context.font = font;
        const lines = wrapMockupText(context, change.suggested_text, box.width);
        const lineHeight = size * 1.15;
        if (lines && size + (lines.length - 1) * lineHeight <= box.height) {
            return {box, font, lines, lineHeight};
        }
        if (scale === 1) break;
    }
    return null;
}

class PosterMockup {
    constructor() {
        this.button = document.getElementById("mockupButton");
        this.availability = document.getElementById("mockupAvailability");
        this.canvas = document.getElementById("mockupCanvas");
        this.original = document.getElementById("posterPreview");
        this.highlights = document.getElementById("posterHighlights");
        this.editor = document.getElementById("mockupEditor");
        this.status = document.getElementById("mockupStatus");
        this.changesElement = document.getElementById("mockupChanges");
        this.download = document.getElementById("downloadMockup");
        this.viewer = document.getElementById("posterViewer");
        this.largeCanvas = document.getElementById("largePosterCanvas");
        this.viewerStage = document.getElementById("viewerStage");
        this.viewerViewport = document.getElementById("viewerViewport");
        this.modeLabel = document.getElementById("viewerModeLabel");
        this.previewLabel = document.getElementById("previewModeLabel");
        this.downloadStatus = document.getElementById("downloadStatus");
        this.zoom = document.getElementById("posterZoom");
        this.outlineControl = document.getElementById("highlightMockupEdits");
        this.editHighlights = document.getElementById("viewerEditHighlights");
        this.originalMode = document.getElementById("viewerOriginalButton");
        this.mockupMode = document.getElementById("viewerMockupButton");
        document.getElementById("viewerSidebar").appendChild(this.editor);
        document.getElementById("viewerDownloadMount").appendChild(this.download);
        document.getElementById("closePosterViewer").addEventListener("click", () => this.viewer.close());
        this.viewer.addEventListener("close", () => document.body.classList.remove("poster-viewer-open"));
        this.zoom.addEventListener("change", () => this.renderViewer());
        this.outlineControl.addEventListener("change", () => this.renderViewer());
        this.originalMode.addEventListener("click", () => {
            this.viewerMode = "original";
            this.renderViewer();
        });
        this.mockupMode.addEventListener("click", () => {
            this.viewerMode = "mockup";
            this.renderViewer();
        });
        document.getElementById("viewPosterButton").addEventListener("click", () => this.enlarge());
        this.viewerResize = new ResizeObserver(() => { if (this.viewer.open) this.renderViewer(); });
        // Poster overflow must not trigger another fit calculation when scrollbars change.
        this.viewerResize.observe(this.viewerViewport, {box: "border-box"});
        this.generation = 0;
        this.button.addEventListener("click", () => {
            if (this.open) this.showOriginal();
            else this.showMockup();
        });
        this.download.addEventListener("click", () => this.downloadImage());
        this.reset();
    }

    reset() {
        this.generation += 1;
        this.changes = [];
        this.image = null;
        this.imagePromise = null;
        this.imageUrl = "";
        this.button.disabled = true;
        this.availability.textContent = "";
        this.download.disabled = true;
        this.downloading = false;
        this.download.textContent = "Download mockup PNG";
        this.download.removeAttribute("aria-busy");
        this.downloadStatus.textContent = "";
        this.appliedChanges = [];
        this.zoom.value = "1";
        this.canvas.width = 0;
        this.canvas.height = 0;
        this.largeCanvas.width = 0;
        this.largeCanvas.height = 0;
        this.changesElement.replaceChildren();
        this.status.textContent = "";
        this.showOriginal();
    }

    setReview(review, imageUrl) {
        this.reset();
        this.imageUrl = imageUrl;
        if (!review.mockup) {
            this.availability.textContent = "Suggested layouts are available for new poster reviews.";
            return;
        }
        this.changes = (review.mockup.changes || []).map(change => ({...change, enabled: true}));
        this.omittedCount = review.mockup.omitted_count || 0;
        this.button.disabled = false;
        this.findingCount = review.findings?.length || 0;
        this.hasFindings = Boolean(this.findingCount);
        this.coveredFindingCount = new Set(this.changes.map(change => change.finding_index)).size;
        this.availability.textContent = this.changes.length
            ? `${this.changes.length} draft edits address ${this.coveredFindingCount} of ${this.findingCount} recommendations. The mockup is a partial preview; review every recommendation separately.`
            : this.hasFindings
                ? "These recommendations need author edits; no safe automatic layout changes were identified."
                : "No clear issues identified. Preview keeps your original poster.";
        if (review.mockup.manual_drafts?.length) {
            this.availability.textContent += ` ${review.mockup.manual_drafts.length} additional rewrites are available as text drafts for manual placement.`;
        }
        this.renderEditors(review);
    }

    showOriginal() {
        if (this.viewer.open) this.viewer.close();
        this.open = false;
        this.canvas.classList.add("hidden");
        this.original.classList.remove("hidden");
        this.highlights.classList.remove("hidden");
        this.editor.classList.add("hidden");
        this.button.textContent = "Preview suggested layout";
        this.button.setAttribute("aria-expanded", "false");
        this.previewLabel.textContent = "Original poster";
    }

    openViewer(mode) {
        this.viewerMode = mode;
        if (!this.viewer.open) this.viewer.showModal();
        document.body.classList.add("poster-viewer-open");
        this.renderViewer();
    }

    async enlarge() {
        if (!this.imageUrl) return;
        if (this.open) {
            this.openViewer("mockup");
            return;
        }
        const generation = this.generation;
        this.openViewer("original");
        this.modeLabel.textContent = "Loading original poster…";
        try {
            this.imagePromise ||= loadMockupImage(this.imageUrl);
            const image = await this.imagePromise;
            if (generation !== this.generation) return;
            this.image = image;
            this.renderViewer();
        } catch {
            if (generation !== this.generation) return;
            this.imagePromise = null;
            this.modeLabel.textContent = "The poster could not be loaded. Close this preview and try again.";
        }
    }

    renderViewer() {
        const mockup = this.viewerMode === "mockup";
        this.originalMode.setAttribute("aria-pressed", String(!mockup));
        this.mockupMode.setAttribute("aria-pressed", String(mockup));
        this.mockupMode.disabled = !this.open;
        this.editor.classList.toggle("hidden", !mockup);
        this.viewer.classList.toggle("viewer-original", !mockup);
        this.download.disabled = this.downloading || !this.image || !mockup;
        if (!this.image || (mockup && !this.canvas.width)) {
            this.download.disabled = true;
            return;
        }
        this.modeLabel.textContent = mockup
            ? `Suggested layout · ${this.appliedChanges.length} draft ${this.appliedChanges.length === 1 ? "edit" : "edits"} applied${this.appliedChanges.length ? "" : " — original retained"}`
            : "Original poster · no suggested edits applied";
        const source = mockup ? this.canvas : this.image;
        const sourceWidth = mockup ? this.canvas.width : this.image.naturalWidth;
        const sourceHeight = mockup ? this.canvas.height : this.image.naturalHeight;
        const scale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
        this.largeCanvas.width = Math.round(sourceWidth * scale);
        this.largeCanvas.height = Math.round(sourceHeight * scale);
        this.largeCanvas.getContext("2d").drawImage(source, 0, 0, this.largeCanvas.width, this.largeCanvas.height);
        const fitWidth = Math.max(100, this.viewerViewport.clientWidth - 32);
        const fitHeight = Math.max(100, this.viewerViewport.clientHeight - 32);
        const ratio = this.largeCanvas.width / this.largeCanvas.height;
        const width = Math.min(fitWidth, fitHeight * ratio) * Number(this.zoom.value);
        this.viewerStage.style.width = `${width}px`;
        this.viewerStage.style.height = `${width / ratio}px`;
        this.editHighlights.replaceChildren();
        this.outlineControl.disabled = !mockup || !this.appliedChanges.length;
        document.getElementById("outlineStatus").textContent = !mockup
            ? "Switch to Suggested layout to see changed areas."
            : !this.appliedChanges.length
                ? "No edits are currently shown to outline."
                : this.outlineControl.checked
                    ? `${this.appliedChanges.length} changed areas highlighted`
                    : "Changed-area outlines hidden";
        if (mockup && this.outlineControl.checked) {
            this.appliedChanges.forEach(change => {
                const marker = document.createElement("div");
                marker.className = "viewer-edit-highlight";
                const badge = document.createElement("span");
                badge.className = "viewer-edit-badge";
                badge.textContent = `Edit ${this.changes.indexOf(change) + 1}`;
                marker.appendChild(badge);
                const {left, top, width, height} = change.region;
                Object.assign(marker.style, {left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%`});
                this.editHighlights.appendChild(marker);
            });
        }
    }

    async showMockup() {
        const generation = this.generation;
        this.open = true;
        this.editor.classList.remove("hidden");
        this.button.textContent = "Show original poster";
        this.button.setAttribute("aria-expanded", "true");
        this.status.textContent = "Preparing your suggested layout…";
        this.download.disabled = true;
        this.openViewer("mockup");
        this.modeLabel.textContent = "Preparing suggested layout…";
        try {
            if (!this.imagePromise) {
                this.imagePromise = loadMockupImage(this.imageUrl);
            }
            const image = await this.imagePromise;
            if (generation !== this.generation || !this.open) return;
            this.image = image;
            this.original.classList.add("hidden");
            this.highlights.classList.add("hidden");
            this.canvas.classList.remove("hidden");
            this.paint();
        } catch (error) {
            if (generation !== this.generation || !this.open) return;
            this.imagePromise = null;
            this.status.textContent = error instanceof TypeError
                ? "The mockup image request was blocked or could not connect. Confirm the preview website is allowed in the Function App's CORS settings, then try again."
                : error.message;
            this.modeLabel.textContent = "Suggested layout image unavailable";
        }
    }

    renderEditors(review) {
        const covered = new Set(this.changes.map(change => change.finding_index));
        const uncovered = (review.findings || []).filter((finding, index) => !covered.has(index));
        if (uncovered.length) {
            const section = document.createElement("details");
            section.className = "mockup-change";
            const heading = document.createElement("summary");
            heading.textContent = `${uncovered.length} recommendations without a preview edit`;
            const explanation = document.createElement("p");
            explanation.textContent = "These recommendations are not reflected in the poster image. Review any text-only rewrites below and apply them in your source poster; other recommendations need manual editing.";
            const list = document.createElement("ul");
            uncovered.forEach(finding => {
                const item = document.createElement("li");
                item.textContent = finding.finding;
                list.appendChild(item);
            });
            section.append(heading, explanation, list);
            this.changesElement.appendChild(section);
        }
        this.changes.forEach((change, index) => {
            const card = document.createElement("div");
            card.className = "mockup-change";
            if (change.section_name) {
                const heading = document.createElement("h3");
                heading.textContent = change.section_name;
                const purpose = document.createElement("p");
                purpose.textContent = change.section_purpose || "";
                card.append(heading, purpose);
            }
            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = true;
            checkbox.addEventListener("change", () => {
                change.enabled = checkbox.checked;
                change.fitRejected = false;
                this.paint();
            });
            change.checkbox = checkbox;
            label.append(checkbox, document.createTextNode(` Include draft edit ${index + 1}`));
            const reason = document.createElement("p");
            reason.textContent = change.reason;
            const finding = document.createElement("p");
            finding.className = "mockup-help";
            finding.textContent = `Addresses: ${review.findings[change.finding_index]?.finding || "Poster recommendation"}`;
            const original = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "Original text";
            const source = document.createElement("p");
            source.textContent = change.original_text;
            original.append(summary, source);
            const textLabel = document.createElement("label");
            textLabel.htmlFor = `mockupText${index}`;
            textLabel.textContent = "Draft replacement text";
            const text = document.createElement("textarea");
            text.id = textLabel.htmlFor;
            text.value = change.suggested_text;
            text.rows = 5;
            text.maxLength = 5000;
            text.addEventListener("input", () => {
                change.suggested_text = text.value;
                if (change.fitRejected) {
                    change.enabled = true;
                    change.checkbox.checked = true;
                    change.fitRejected = false;
                }
                this.paint();
            });
            change.note = document.createElement("p");
            change.note.className = "mockup-edit-status";
            change.note.setAttribute("role", "status");
            card.append(label, reason, finding, original, textLabel, text, change.note);
            this.changesElement.appendChild(card);
        });
        (review.mockup.manual_drafts || []).forEach(draft => {
            const card = document.createElement("div");
            card.className = "mockup-change";
            const heading = document.createElement("h3");
            heading.textContent = `${draft.section_name || "Section rewrite"} · text draft only`;
            const purpose = document.createElement("p");
            purpose.textContent = draft.section_purpose || draft.reason;
            const limitation = document.createElement("p");
            limitation.className = "mockup-edit-status";
            limitation.textContent = `Not applied to the poster. ${draft.limitation}`;
            const original = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "Original text";
            const source = document.createElement("p");
            source.textContent = draft.original_text;
            original.append(summary, source);
            const label = document.createElement("p");
            label.textContent = "Suggested section rewrite — select and copy into your source poster";
            const text = document.createElement("textarea");
            text.value = draft.suggested_text;
            text.readOnly = true;
            text.rows = 8;
            text.setAttribute("aria-label", `${draft.section_name || "Section"} rewrite for manual placement`);
            card.append(heading, purpose, limitation, original, label, text);
            this.changesElement.appendChild(card);
        });
    }

    paint() {
        if (!this.image) return;
        // Bound memory while retaining the poster's original aspect ratio.
        const scale = Math.min(1, 2400 / Math.max(this.image.naturalWidth, this.image.naturalHeight));
        this.canvas.width = Math.round(this.image.naturalWidth * scale);
        this.canvas.height = Math.round(this.image.naturalHeight * scale);
        const context = this.canvas.getContext("2d");
        context.drawImage(this.image, 0, 0, this.canvas.width, this.canvas.height);
        let applied = 0;
        this.appliedChanges = [];
        this.changes.forEach(change => {
            change.note.textContent = "";
            if (!change.enabled) {
                change.note.textContent = change.fitRejected
                    ? "Not applied: this draft does not fit. Shorten its text to try again; the original is retained."
                    : "Not applied: this draft is turned off.";
                return;
            }
            const layout = change.suggested_text.trim()
                ? fitMockupText(context, change, this.canvas.width, this.canvas.height) : null;
            if (!layout) {
                change.enabled = false;
                change.fitRejected = true;
                change.checkbox.checked = false;
                change.note.textContent = "Not applied: this draft does not fit. Shorten its text to try again; the original is retained.";
                return;
            }
            const {box, font, lines, lineHeight} = layout;
            context.save();
            context.beginPath();
            context.rect(box.left, box.top, box.width, box.height);
            context.clip();
            context.fillStyle = change.style.background;
            context.fillRect(box.left, box.top, box.width, box.height);
            context.font = font;
            context.fillStyle = change.style.color;
            context.textBaseline = "top";
            lines.forEach((line, index) => context.fillText(line, box.left, box.top + index * lineHeight));
            context.restore();
            applied += 1;
            this.appliedChanges.push(change);
            change.note.textContent = "Shown in the mockup. Check this draft against your source poster.";
        });
        this.status.textContent = this.changes.length
            ? `${applied} of ${this.changes.length} draft edits shown, addressing ${new Set(this.appliedChanges.map(change => change.finding_index)).size} of ${this.findingCount} recommendations. ${this.changes.filter(change => change.fitRejected).length} drafts could not fit; ${this.changes.filter(change => !change.enabled && !change.fitRejected).length} edits turned off. All other areas retain the original design.`
            : this.hasFindings
                ? "Original design retained. Apply the recommendations manually where new content or graphic changes are needed."
                : "No clear issues identified. Your original poster is preserved.";
        if (this.omittedCount) {
            this.status.textContent += " Some proposed edits could not safely preserve the original design and were left out.";
        }
        this.previewLabel.textContent = `Suggested layout · ${applied} draft edits applied`;
        this.renderViewer();
    }

    downloadImage() {
        if (this.downloading || !this.image || this.viewerMode !== "mockup") return;
        const generation = this.generation;
        this.downloading = true;
        this.download.disabled = true;
        this.download.textContent = "Preparing PNG…";
        this.download.setAttribute("aria-busy", "true");
        this.downloadStatus.textContent = "Preparing your mockup PNG. Please wait…";
        const finish = message => {
            if (generation !== this.generation) return;
            this.downloading = false;
            this.download.textContent = "Download mockup PNG";
            this.download.removeAttribute("aria-busy");
            this.downloadStatus.textContent = message;
            this.renderViewer();
        };
        try {
            this.canvas.toBlob(blob => {
                if (generation !== this.generation) return;
                if (!blob) {
                    finish("The PNG could not be prepared. Please try again.");
                    return;
                }
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "posteriq-suggested-layout.png";
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 30000);
                finish("Download started: posteriq-suggested-layout.png. Check your browser’s downloads.");
            }, "image/png");
        } catch {
            finish("Download is unavailable. Check that the API allows requests from this frontend.");
        }
    }
}

if (typeof module !== "undefined") module.exports = {wrapMockupText, fitMockupText};
