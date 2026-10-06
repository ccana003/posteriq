/* Draw only validated text edits over the original image. Never alter the PDF. */
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
        this.hasFindings = Boolean(review.findings?.length);
        this.availability.textContent = this.changes.length
            ? `${this.changes.length} targeted draft ${this.changes.length === 1 ? "edit" : "edits"}; the surrounding design is preserved.`
            : this.hasFindings
                ? "These recommendations need author edits; no safe automatic layout changes were identified."
                : "No clear issues identified. Preview keeps your original poster.";
        this.renderEditors(review);
    }

    showOriginal() {
        this.open = false;
        this.canvas.classList.add("hidden");
        this.original.classList.remove("hidden");
        this.highlights.classList.remove("hidden");
        this.editor.classList.add("hidden");
        this.button.textContent = "Preview suggested layout";
        this.button.setAttribute("aria-expanded", "false");
    }

    async showMockup() {
        const generation = this.generation;
        this.open = true;
        this.editor.classList.remove("hidden");
        this.button.textContent = "Show original poster";
        this.button.setAttribute("aria-expanded", "true");
        this.status.textContent = "Preparing your suggested layout…";
        this.download.disabled = true;
        try {
            if (!this.imagePromise) {
                this.imagePromise = new Promise((resolve, reject) => {
                    const image = new Image();
                    image.crossOrigin = "anonymous";
                    image.onload = () => resolve(image);
                    image.onerror = () => reject(new Error("The poster image could not be loaded. Check the API connection and try again."));
                    image.src = this.imageUrl;
                });
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
            this.status.textContent = error.message;
        }
    }

    renderEditors(review) {
        this.changes.forEach((change, index) => {
            const card = document.createElement("div");
            card.className = "mockup-change";
            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = true;
            checkbox.addEventListener("change", () => {
                change.enabled = checkbox.checked;
                this.paint();
            });
            label.append(checkbox, document.createTextNode(` Apply edit ${index + 1}`));
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
                this.paint();
            });
            change.note = document.createElement("p");
            change.note.className = "mockup-edit-status";
            change.note.setAttribute("role", "status");
            card.append(label, reason, finding, original, textLabel, text, change.note);
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
        this.changes.forEach(change => {
            change.note.textContent = "";
            if (!change.enabled) return;
            const layout = change.suggested_text.trim()
                ? fitMockupText(context, change, this.canvas.width, this.canvas.height) : null;
            if (!layout) {
                change.note.textContent = "Original text kept: this edit does not fit. Shorten the draft or turn off this edit.";
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
            change.note.textContent = "Shown in the mockup. Check this draft against your source poster.";
        });
        this.status.textContent = this.changes.length
            ? `${applied} of ${this.changes.length} draft edits shown. All other areas retain the original design.`
            : this.hasFindings
                ? "Original design retained. Apply the recommendations manually where new content or graphic changes are needed."
                : "No clear issues identified. Your original poster is preserved.";
        if (this.omittedCount) {
            this.status.textContent += " Some proposed edits could not safely preserve the original design and were left out.";
        }
        this.download.disabled = false;
    }

    downloadImage() {
        const generation = this.generation;
        try {
            this.canvas.toBlob(blob => {
                if (!blob || generation !== this.generation) return;
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "posteriq-suggested-layout.png";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }, "image/png");
        } catch {
            this.status.textContent = "Download is unavailable. Check that the API allows requests from this frontend.";
        }
    }
}

if (typeof module !== "undefined") module.exports = {wrapMockupText, fitMockupText};
