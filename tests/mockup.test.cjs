const {test} = require("node:test");
const assert = require("node:assert/strict");
const {wrapMockupText, fitMockupText} = require("../frontend/mockup.js");

const context = {measureText: text => ({width: text.length * 7})};
const change = {
    region: {left: 0.1, top: 0.2, width: 0.4, height: 0.3},
    style: {font_size: 0.02, bold: false, font_family: "sans-serif"},
    font_scale: 1.2, suggested_text: "A concise and legible poster sentence."
};

test("wrapping keeps the complete content and paragraph breaks", () => {
    const text = "Results were clear.\nEnrollment was 120 participants.";
    const lines = wrapMockupText(context, text, 130);
    assert.equal(lines.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});

test("unbreakable overflow is rejected rather than clipped", () => {
    assert.equal(wrapMockupText(context, "averylongunbreakableword", 20), null);
});

test("an edit stays inside its original region", () => {
    const fit = fitMockupText(context, change, 600, 400);
    assert.ok(fit);
    assert.equal(fit.box.left, 60);
    assert.equal(fit.box.top, 80);
    assert.equal(fit.box.width, 240);
    assert.ok(fit.lines.length * fit.lineHeight <= fit.box.height);
});

test("crowded edits do not shrink the source font or clip content", () => {
    assert.equal(fitMockupText(context, {...change, suggested_text: "Too much text ".repeat(100)}, 600, 400), null);
});
