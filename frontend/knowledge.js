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
			const confirmed = window.confirm(
				`Delete ${record.reference_id}?\n\nThis guidance will be permanently removed.`
			);

			if (!confirmed) {
				return;
			}

			try {
				const response = await fetch(
					`${API_BASE_URL}/knowledge/${encodeURIComponent(record.reference_id)}?knowledge_file=${encodeURIComponent(record.knowledge_file)}`,
					{
						method: "DELETE"
					}
				);

				const data = await response.json();

				if (!response.ok) {
					alert(data.error || "Unable to delete guidance.");
					return;
				}

				await loadKnowledge();
				alert(data.message);

			} catch (error) {
				console.error(error);
				alert("Unable to connect to PosterIQ.");
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

    categories.forEach(category => {
        const option = document.createElement("option");
        option.value = category;
        option.textContent = formatReviewArea(category);

        areaFilter.appendChild(option);
    });
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

    sourceSelect.innerHTML = `
        <option value="">
            Select a source document
        </option>
    `;

    knowledgeSources.forEach(source => {
        const option = document.createElement("option");

        option.value = source.knowledge_file;
        option.textContent = source.title;

        sourceSelect.appendChild(option);
    });
}

async function loadKnowledge() {
    try {
        const response = await fetch(`${API_BASE_URL}/knowledge`);

        if (!response.ok) {
            throw new Error("Knowledge request failed.");
        }

        const data = await response.json();

        knowledgeRecords = data.records || [];
		knowledgeSources = data.sources || [];

		updateSummary();
		populateReviewAreas();
		populateSourceDocuments();
		renderRecords(knowledgeRecords);

    } catch (error) {
        console.error(error);

        recordsContainer.innerHTML = `
            <div class="knowledge-empty">
                PosterIQ could not load the knowledge base.
            </div>
        `;
    }
}


searchInput.addEventListener("input", applyFilters);
areaFilter.addEventListener("change", applyFilters);

loadKnowledge();

const guidanceModal = document.getElementById("guidanceModal");
const addGuidanceButton = document.getElementById("addGuidanceButton");
const closeGuidanceModal = document.getElementById("closeGuidanceModal");
const cancelGuidanceButton = document.getElementById("cancelGuidanceButton");
const guidanceForm = document.getElementById("guidanceForm");
const modalBackdrop = guidanceModal.querySelector(".knowledge-modal-backdrop");


function openGuidanceModal() {
    editingRecord = null;
    guidanceForm.reset();
	document.getElementById("guidanceReferenceId").readOnly = false;
	document.getElementById("guidanceModalTitle").textContent =
	    "Add guidance";

    guidanceModal.hidden = false;
    document.body.style.overflow = "hidden";

    document.getElementById("guidanceCategory").focus();
}

function openEditGuidanceModal(record) {
	editingRecord = record;
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
        const requestUrl = editingRecord
			? `${API_BASE_URL}/knowledge/${encodeURIComponent(editingRecord.reference_id)}`
			: `${API_BASE_URL}/knowledge`;

		const requestMethod = editingRecord
			? "PUT"
			: "POST";

		const response = await fetch(
			requestUrl,
			{
				method: requestMethod,
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify(payload)
			}
		);

        const data = await response.json();

        if (!response.ok) {
            alert(data.error || "Unable to validate guidance.");
            return;
        }

        guidanceForm.reset();
		hideGuidanceModal();
		await loadKnowledge();

		alert(data.message);

    } catch (error) {
        console.error(error);
        alert("Unable to connect to PosterIQ.");
    }
});