const API_BASE_URL =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
        ? "http://localhost:7071/api"
        : "https://posteriq-api-dme7bwfug7azd9h3.westus3-01.azurewebsites.net/api";


const recordsContainer = document.getElementById("knowledgeRecords");
const searchInput = document.getElementById("knowledgeSearch");
const areaFilter = document.getElementById("reviewAreaFilter");

let knowledgeRecords = [];
let knowledgeSources = [];
let editingRecord = null;
let authClient = null;
let authConfiguration = null;
let signingIn = false;
const managerStatus = document.getElementById("knowledgeStatus");
const signInButton = document.getElementById("knowledgeSignIn");

function showStatus(message) {
    managerStatus.textContent = message;
}

async function initializeKnowledgeAuth() {
    try {
        const response = await fetch(`${API_BASE_URL}/knowledge/access`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Knowledge editing is unavailable.");
        if (!window.msal) throw new Error("The sign-in library could not load. Refresh to retry.");
        authConfiguration = data;
        authClient = new window.msal.PublicClientApplication({
            auth: {
                clientId: data.client_id,
                authority: `https://login.microsoftonline.com/${data.tenant_id}`,
                redirectUri: new URL("knowledge-auth.html", window.location.href).href
            },
            cache: { cacheLocation: "sessionStorage" }
        });
        await authClient.initialize();
        signInButton.disabled = false;
        showStatus("Viewing guidance. Sign in as a Knowledge Editor to make changes.");
    } catch (error) {
        showStatus(error.message);
    }
}

async function editorToken(interactive = false) {
    if (!authClient) throw new Error("Knowledge editing is not configured or sign-in could not load.");
    const account = authClient.getAllAccounts()[0];
    if (account) {
        try {
            return (await authClient.acquireTokenSilent({
                account, scopes: [authConfiguration.scope]
            })).accessToken;
        } catch (error) {
            if (!interactive) throw new Error("Your sign-in expired. Click Sign in to edit, then retry.");
        }
    } else if (!interactive) {
        throw new Error("Click Sign in to edit before saving or deleting guidance.");
    }
    const result = await authClient.acquireTokenPopup({ scopes: [authConfiguration.scope] });
    return result.accessToken;
}

signInButton.addEventListener("click", async () => {
    if (signingIn) return;
    signingIn = true;
    signInButton.disabled = true;
    try {
        await editorToken(true);
        showStatus("Signed in. Changes require the Knowledge Editor role.");
    } catch (error) {
        showStatus(error.message || "Sign-in was cancelled. Your guidance has not changed.");
    } finally {
        signingIn = false;
        signInButton.disabled = false;
    }
});

async function knowledgeWrite(url, method, payload, record) {
    const token = await editorToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (payload) headers["Content-Type"] = "application/json";
    if (record) {
        if (!record.etag) throw new Error("This guidance has no editable version. Reload the knowledge base.");
        headers["If-Match"] = record.etag;
    }
    const response = await fetch(url, {
        method, headers, body: payload ? JSON.stringify(payload) : undefined
    });
    let data = {};
    try { data = await response.json(); } catch (_) { /* An upstream error may not be JSON. */ }
    if (!response.ok) {
        const fallback = {
            400: "Check the guidance fields and try again.",
            401: "Sign in to edit, then retry your change.",
            403: "Your account needs the Knowledge Editor role. Contact the administrator.",
            409: "This ID already exists or another write is in progress. Review your entry and retry.",
            412: "This document changed. Reload the page before editing or deleting. Your draft is still in the form.",
            428: "Reload the page to obtain the latest guidance version."
        };
        throw new Error(data.error || fallback[response.status] || "Unable to save guidance. Retry shortly.");
    }
    return data;
}


function formatReviewArea(category) {
    return (category || "")
        .replaceAll("_", " ")
        .replace(/\b\w/g, character => character.toUpperCase());
}


function renderRecords(records) {
    recordsContainer.innerHTML = "";

    if (!records.length) {
        recordsContainer.innerHTML = `
            <div class="knowledge-empty">
                No guidance records match your search.
            </div>
        `;
        return;
    }

    records.forEach(record => {
        const card = document.createElement("article");
        card.className = "knowledge-record";

        const heading = document.createElement("div");
        heading.className = "knowledge-record-heading";

        const titleArea = document.createElement("div");

        const category = document.createElement("span");
        category.className = "knowledge-category";
        category.textContent = formatReviewArea(record.category);

        const title = document.createElement("h2");
        title.textContent = record.title || "Untitled guidance";

        titleArea.appendChild(category);
        titleArea.appendChild(title);

        const recordActions = document.createElement("div");
		recordActions.className = "knowledge-record-actions";

		const reference = document.createElement("span");
		reference.className = "knowledge-reference";
		reference.textContent = record.reference_id || "";

		const editButton = document.createElement("button");
		editButton.type = "button";
		editButton.className = "knowledge-edit-button";
		editButton.textContent = "Edit";

		editButton.addEventListener("click", () => {
			openEditGuidanceModal(record);
		});

		const deleteButton = document.createElement("button");
		deleteButton.type = "button";
		deleteButton.className = "knowledge-delete-button";
		deleteButton.textContent = "Delete";

        deleteButton.addEventListener("click", async () => {
            if (deleteButton.disabled || !window.confirm(
                `Delete ${record.reference_id}?\n\nThis guidance will be permanently removed.`)) return;
            deleteButton.disabled = true;
            deleteButton.textContent = "Deleting…";
            try {
                const data = await knowledgeWrite(
                    `${API_BASE_URL}/knowledge/${encodeURIComponent(record.reference_id)}?knowledge_file=${encodeURIComponent(record.knowledge_file)}`,
                    "DELETE", null, record);
                await loadKnowledge();
                showStatus(data.message);
            } catch (error) {
                showStatus(error.message || "Unable to connect to PosterIQ.");
            } finally {
                deleteButton.disabled = false;
                deleteButton.textContent = "Delete";
            }
        });

		recordActions.appendChild(reference);
		recordActions.appendChild(editButton);
		recordActions.appendChild(deleteButton);

		heading.appendChild(titleArea);
		heading.appendChild(recordActions);

        const guidanceText = document.createElement("p");
        guidanceText.className = "knowledge-guidance-text";
        guidanceText.textContent = record.text || "";

        const source = document.createElement("div");
        source.className = "knowledge-source";

        const sourceParts = [
            record.source,
            record.source_section
        ].filter(Boolean);

        source.textContent = sourceParts.join(" • ");

        card.appendChild(heading);
        card.appendChild(guidanceText);
        card.appendChild(source);

        recordsContainer.appendChild(card);
    });
}


function applyFilters() {
    const searchTerm = searchInput.value.trim().toLowerCase();
    const selectedArea = areaFilter.value;

    const filtered = knowledgeRecords.filter(record => {
        const matchesArea =
            !selectedArea ||
            record.category === selectedArea;

        const searchable = [
            record.reference_id,
            record.category,
            record.title,
            record.text,
            record.source,
            record.source_section,
            ...(record.keywords || [])
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

        const matchesSearch =
            !searchTerm ||
            searchable.includes(searchTerm);

        return matchesArea && matchesSearch;
    });

    renderRecords(filtered);
}


function populateReviewAreas() {
    const categories = [
        ...new Set(
            knowledgeRecords
                .map(record => record.category)
                .filter(Boolean)
        )
    ].sort();

    const selected = areaFilter.value;
    areaFilter.replaceChildren(new Option("All review areas", ""));
    categories.forEach(category => {
        const option = document.createElement("option");
        option.value = category;
        option.textContent = formatReviewArea(category);

        areaFilter.appendChild(option);
    });
    areaFilter.value = selected;
}


function updateSummary() {
    const reviewAreas = new Set(
        knowledgeRecords
            .map(record => record.category)
            .filter(Boolean)
    );

    const sources = new Set(
        knowledgeRecords
            .map(record => record.source)
            .filter(Boolean)
    );

    document.getElementById("guidanceCount").textContent =
        knowledgeRecords.length;

    document.getElementById("reviewAreaCount").textContent =
        reviewAreas.size;

    document.getElementById("sourceCount").textContent =
        sources.size;
}

function populateSourceDocuments() {
    const sourceSelect = document.getElementById("guidanceSource");

    sourceSelect.replaceChildren(new Option("Select a source document", ""));
    if (!knowledgeSources.some(source => source.knowledge_file === "posteriq-internal.json")) {
        knowledgeSources.push({ knowledge_file: "posteriq-internal.json", title: "PosterIQ internally developed guidance" });
    }

    knowledgeSources.forEach(source => {
        const option = document.createElement("option");

        option.value = source.knowledge_file;
        option.textContent = source.title;

        sourceSelect.appendChild(option);
    });
}

async function loadKnowledge() {
    try {
        const response = await fetch(`${API_BASE_URL}/knowledge`, { cache: "no-store" });

        if (!response.ok) {
            throw new Error("Knowledge request failed.");
        }

        const data = await response.json();

        knowledgeRecords = data.records || [];
		knowledgeSources = data.sources || [];

		updateSummary();
		populateReviewAreas();
		populateSourceDocuments();
		applyFilters();
        return true;

    } catch (error) {
        console.error(error);

        recordsContainer.innerHTML = `
            <div class="knowledge-empty">
                PosterIQ could not load the knowledge base. Reload the page to retry.
            </div>
        `;
        return false;
    }
}


searchInput.addEventListener("input", applyFilters);
areaFilter.addEventListener("change", applyFilters);

loadKnowledge();
initializeKnowledgeAuth();

const guidanceModal = document.getElementById("guidanceModal");
const addGuidanceButton = document.getElementById("addGuidanceButton");
const closeGuidanceModal = document.getElementById("closeGuidanceModal");
const cancelGuidanceButton = document.getElementById("cancelGuidanceButton");
const guidanceForm = document.getElementById("guidanceForm");
const modalBackdrop = guidanceModal.querySelector(".knowledge-modal-backdrop");


function openGuidanceModal() {
    editingRecord = null;
    document.getElementById("guidanceFormStatus").textContent = "";
    guidanceForm.reset();
    document.getElementById("guidanceSource").disabled = false;
	document.getElementById("guidanceReferenceId").readOnly = false;
	document.getElementById("guidanceModalTitle").textContent =
	    "Add guidance";

    guidanceModal.hidden = false;
    document.body.style.overflow = "hidden";

    document.getElementById("guidanceCategory").focus();
}

function openEditGuidanceModal(record) {
	editingRecord = record;
    document.getElementById("guidanceFormStatus").textContent = "";
    document.getElementById("guidanceSource").disabled = true;
	document.getElementById("guidanceReferenceId").readOnly = true;
	document.getElementById("guidanceModalTitle").textContent =
		"Edit guidance";
	
    document.getElementById("guidanceCategory").value =
        record.category || "";

    document.getElementById("guidanceReferenceId").value =
        record.reference_id || "";

    document.getElementById("guidanceTitle").value =
        record.title || "";

    document.getElementById("guidanceText").value =
        record.text || "";

    document.getElementById("guidanceSource").value =
        record.knowledge_file || "";

    document.getElementById("guidanceSection").value =
        record.source_section || "";

    document.getElementById("guidanceSourcePage").value =
        record.source_page || "";

    document.getElementById("guidanceAppliesTo").value =
        (record.applies_to || []).join(", ");

    document.getElementById("guidanceKeywords").value =
        (record.keywords || []).join(", ");

    guidanceModal.hidden = false;
    document.body.style.overflow = "hidden";

    document.getElementById("guidanceCategory").focus();
}

function hideGuidanceModal() {
    if (guidanceForm.dataset.saving === "true") return;
    guidanceModal.hidden = true;
    document.body.style.overflow = "";
}


addGuidanceButton.addEventListener("click", openGuidanceModal);

closeGuidanceModal.addEventListener("click", hideGuidanceModal);

cancelGuidanceButton.addEventListener("click", hideGuidanceModal);

modalBackdrop.addEventListener("click", hideGuidanceModal);


document.addEventListener("keydown", event => {
    if (
        event.key === "Escape" &&
        !guidanceModal.hidden
    ) {
        hideGuidanceModal();
    }
});


guidanceForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (guidanceForm.dataset.saving === "true") return;
    const formStatus = document.getElementById("guidanceFormStatus");
    const saveButton = guidanceForm.querySelector('[type="submit"]');
    formStatus.textContent = "";
    guidanceForm.dataset.saving = "true";
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";

    const payload = {
        knowledge_file:
            document.getElementById("guidanceSource").value,

        reference_id:
            document.getElementById("guidanceReferenceId").value.trim(),

        category:
            document.getElementById("guidanceCategory").value,

        source_section:
            document.getElementById("guidanceSection").value.trim(),

        source_page:
            document.getElementById("guidanceSourcePage").value
                ? Number(
                    document.getElementById("guidanceSourcePage").value
                )
                : null,

        title:
            document.getElementById("guidanceTitle").value.trim(),

        text:
            document.getElementById("guidanceText").value.trim(),

        applies_to:
            document.getElementById("guidanceAppliesTo").value
                .split(",")
                .map(value => value.trim())
                .filter(Boolean),

        keywords:
            document.getElementById("guidanceKeywords").value
                .split(",")
                .map(value => value.trim())
                .filter(Boolean)
    };

    try {
        const record = editingRecord;
        const requestUrl = record
            ? `${API_BASE_URL}/knowledge/${encodeURIComponent(record.reference_id)}`
            : `${API_BASE_URL}/knowledge`;
        const data = await knowledgeWrite(requestUrl, record ? "PUT" : "POST", payload, record);
        guidanceForm.dataset.saving = "false";
        hideGuidanceModal();
        guidanceForm.reset();
        const refreshed = await loadKnowledge();
        showStatus(data.message + (refreshed ? "" : " Reload the page to see the saved guidance."));
    } catch (error) {
        formStatus.textContent = error.message || "Unable to connect to PosterIQ. Your draft is still in the form.";
    } finally {
        guidanceForm.dataset.saving = "false";
        saveButton.disabled = false;
        saveButton.textContent = "Save guidance";
    }
});
