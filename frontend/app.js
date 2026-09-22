const API_BASE_URL =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
        ? "http://localhost:7071/api"
        : "https://posteriq-api-dme7bwfug7azd9h3.westus3-01.azurewebsites.net/api";

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const selectedFile = document.getElementById("selectedFile");
const fileName = document.getElementById("fileName");
const fileSize = document.getElementById("fileSize");
const removeFile = document.getElementById("removeFile");
const reviewButton = document.getElementById("reviewButton");

const analysisStatus = document.getElementById("analysisStatus");
const statusTitle = document.getElementById("statusTitle");
const statusMessage = document.getElementById("statusMessage");
const errorMessage = document.getElementById("errorMessage");

const resultsSection = document.getElementById("resultsSection");
const reviewOverview = document.getElementById("reviewOverview");
const reviewStrengths = document.getElementById("reviewStrengths");
const reviewPriorities = document.getElementById("reviewPriorities");
const findingsList = document.getElementById("findingsList");
const findingCount = document.getElementById("findingCount");
const categoryFilters = document.getElementById("categoryFilters");
const newReviewButton = document.getElementById("newReviewButton");

const MAX_FILE_SIZE = 25 * 1024 * 1024;

let currentFile = null;
let currentReview = null;


/* =========================================================
   FILE HELPERS
========================================================= */

function formatFileSize(bytes) {
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


function formatCategory(category) {
    const labels = {
        scientific_content: "Scientific content",
        statistics: "Statistics",
        visual_design: "Visual design",
        readability: "Readability",
        accessibility: "Accessibility",
        required_elements: "Required elements"
    };

    return labels[category] || category || "Feedback";
}


function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.remove("hidden");
}


function clearError() {
    errorMessage.textContent = "";
    errorMessage.classList.add("hidden");
}


function setStatus(title, message) {
    statusTitle.textContent = title;
    statusMessage.textContent = message;
    analysisStatus.classList.remove("hidden");
}


function clearStatus() {
    analysisStatus.classList.add("hidden");
}


function resetFile() {
    currentFile = null;
    fileInput.value = "";

    selectedFile.classList.add("hidden");

    fileName.textContent = "";
    fileSize.textContent = "";

    reviewButton.disabled = true;

    clearError();
    clearStatus();
}


function resetReview() {
    currentReview = null;

    reviewOverview.textContent = "";
    reviewStrengths.innerHTML = "";
    reviewPriorities.innerHTML = "";
    findingsList.innerHTML = "";
    findingCount.textContent = "";

    resultsSection.classList.add("hidden");

    document
        .querySelectorAll(".filter-button")
        .forEach((button) => {
            button.classList.toggle(
                "active",
                button.dataset.category === "all"
            );
        });
}


function selectFile(file) {
    clearError();
    clearStatus();
    resetReview();

    if (!file) {
        return;
    }

    const isPdf =
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
        resetFile();
        showError("PosterIQ currently accepts PDF files only.");
        return;
    }

    if (file.size > MAX_FILE_SIZE) {
        resetFile();
        showError("The selected PDF exceeds the 25 MB upload limit.");
        return;
    }

    currentFile = file;

    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    selectedFile.classList.remove("hidden");
    reviewButton.disabled = false;
}


/* =========================================================
   FILE SELECTION
========================================================= */

dropZone.addEventListener("click", () => {
    fileInput.click();
});


dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        fileInput.click();
    }
});


fileInput.addEventListener("change", () => {
    selectFile(fileInput.files[0]);
});


dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
});


dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});


dropZone.addEventListener("drop", (event) => {
    event.preventDefault();

    dropZone.classList.remove("drag-over");

    const file = event.dataTransfer.files[0];

    selectFile(file);
});


removeFile.addEventListener("click", () => {
    resetFile();
    resetReview();
});


/* =========================================================
   API
========================================================= */

async function uploadPoster() {
    const formData = new FormData();

    formData.append("file", currentFile);

    const response = await fetch(
        `${API_BASE_URL}/posters`,
        {
            method: "POST",
            body: formData
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.error || "PosterIQ could not upload the poster."
        );
    }

    return data;
}


async function reviewPoster(posterId) {
    const response = await fetch(
        `${API_BASE_URL}/posters/${posterId}/review`,
        {
            method: "POST"
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.error || "PosterIQ could not review the poster."
        );
    }

    return data;
}


/* =========================================================
   SUMMARY
========================================================= */

function createSummaryItem(text) {
    const item = document.createElement("p");

    item.className = "summary-item";
    item.textContent = text;

    return item;
}


function renderSummary(summary) {
    reviewOverview.textContent =
        summary?.overview || "Poster review completed.";

    reviewStrengths.innerHTML = "";
    reviewPriorities.innerHTML = "";

    const strengths = summary?.strengths || [];
    const priorities = summary?.top_priorities || [];

    if (strengths.length === 0) {
        reviewStrengths.appendChild(
            createSummaryItem(
                "No specific strengths were returned."
            )
        );
    } else {
        strengths.forEach((strength) => {
            reviewStrengths.appendChild(
                createSummaryItem(strength)
            );
        });
    }

    if (priorities.length === 0) {
        reviewPriorities.appendChild(
            createSummaryItem(
                "No priority recommendations were returned."
            )
        );
    } else {
        priorities.forEach((priority) => {
            reviewPriorities.appendChild(
                createSummaryItem(priority)
            );
        });
    }
}


/* =========================================================
   FINDINGS
========================================================= */

function createFindingSection(label, text) {
    const section = document.createElement("div");
    section.className = "finding-section";

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "finding-section-label";
    sectionLabel.textContent = label;

    const paragraph = document.createElement("p");
    paragraph.textContent = text;

    section.appendChild(sectionLabel);
    section.appendChild(paragraph);

    return section;
}


function createFindingCard(finding) {
    const card = document.createElement("article");

    card.className = "finding-card";
    card.dataset.category = finding.category || "";

    const main = document.createElement("div");
    main.className = "finding-main";


    /* META */

    const meta = document.createElement("div");
    meta.className = "finding-meta";

    const category = document.createElement("span");
    category.className = "finding-category";
    category.textContent = formatCategory(finding.category);

    const priority = document.createElement("span");

    const priorityValue =
        finding.priority || "low";

    priority.className =
        `priority-badge priority-${priorityValue}`;

    priority.textContent =
        `${priorityValue} priority`;

    meta.appendChild(category);
    meta.appendChild(priority);

    main.appendChild(meta);


    /* FINDING */

    const title = document.createElement("h4");
    title.className = "finding-title";
    title.textContent =
        finding.finding || "Poster feedback";

    main.appendChild(title);


    /* EVIDENCE */

    if (finding.evidence?.description) {
        main.appendChild(
            createFindingSection(
                "Evidence",
                finding.evidence.description
            )
        );
    }


    /* LOCATION */

    const locationParts = [];

    if (finding.evidence?.section) {
        locationParts.push(
            `Section: ${finding.evidence.section}`
        );
    }

    if (finding.evidence?.page_number) {
        locationParts.push(
            `Page ${finding.evidence.page_number}`
        );
    }
    

    if (locationParts.length > 0) {
        main.appendChild(
            createFindingSection(
                "Poster location",
                locationParts.join(" • ")
            )
        );
    }


    /* RECOMMENDATION */

    if (finding.recommendation) {
        main.appendChild(
            createFindingSection(
                "Recommendation",
                finding.recommendation
            )
        );
    }

    card.appendChild(main);


    /* GUIDANCE / PROVENANCE */

    const guidance = finding.guidance || {};

    const sourceArea = document.createElement("div");
    sourceArea.className = "guidance-source";

    const sourceText = document.createElement("div");

    const sourceTitle = document.createElement("strong");
    const sourceDetail = document.createElement("span");

    const guidanceType =
        guidance.type === "curated_standard"
            ? "curated_standard"
            : "general_suggestion";

    if (guidanceType === "curated_standard") {
        sourceTitle.textContent =
            "Supported by curated guidance";

        const details = [];

        if (guidance.source) {
            details.push(guidance.source);
        }

        if (guidance.section) {
            details.push(guidance.section);
        }

        if (guidance.reference_id) {
            details.push(guidance.reference_id);
        }

        sourceDetail.textContent =
            details.join(" • ");
    } else {
        sourceTitle.textContent =
            "General suggestion";

        sourceDetail.textContent =
            "This recommendation is not tied to a supplied curated standard.";
    }

    sourceText.appendChild(sourceTitle);
    sourceText.appendChild(sourceDetail);


    const typeBadge = document.createElement("span");

    typeBadge.className =
        guidanceType === "curated_standard"
            ? "guidance-type"
            : "guidance-type general";

    typeBadge.textContent =
        guidanceType === "curated_standard"
            ? "Curated standard"
            : "General suggestion";

    sourceArea.appendChild(sourceText);
    sourceArea.appendChild(typeBadge);

    card.appendChild(sourceArea);

    return card;
}


function renderFindings(findings, category = "all") {
    findingsList.innerHTML = "";

    const filteredFindings =
        category === "all"
            ? findings
            : findings.filter(
                (finding) =>
                    finding.category === category
            );

    findingCount.textContent =
        `${filteredFindings.length} ${
            filteredFindings.length === 1
                ? "finding"
                : "findings"
        }`;

    if (filteredFindings.length === 0) {
        const emptyCard = document.createElement("div");

        emptyCard.className = "finding-card";

        const emptyMain = document.createElement("div");
        emptyMain.className = "finding-main";

        const emptyTitle = document.createElement("h4");
        emptyTitle.className = "finding-title";
        emptyTitle.textContent =
            "No findings in this category";

        const emptyText = document.createElement("p");
        emptyText.textContent =
            "PosterIQ did not return specific feedback for this category.";

        emptyText.style.color = "var(--muted)";

        emptyMain.appendChild(emptyTitle);
        emptyMain.appendChild(emptyText);

        emptyCard.appendChild(emptyMain);
        findingsList.appendChild(emptyCard);

        return;
    }

    filteredFindings.forEach((finding) => {
        findingsList.appendChild(
            createFindingCard(finding)
        );
    });
}


/* =========================================================
   COMPLETE REVIEW
========================================================= */

function renderReview(review) {
    currentReview = review;

    renderSummary(review.summary || {});
    renderFindings(review.findings || []);

    resultsSection.classList.remove("hidden");

    resultsSection.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}


/* =========================================================
   FILTERS
========================================================= */

categoryFilters.addEventListener("click", (event) => {
    const button = event.target.closest(
        ".filter-button"
    );

    if (!button || !currentReview) {
        return;
    }

    document
        .querySelectorAll(".filter-button")
        .forEach((filterButton) => {
            filterButton.classList.remove("active");
        });

    button.classList.add("active");

    renderFindings(
        currentReview.findings || [],
        button.dataset.category
    );
});


/* =========================================================
   NEW REVIEW
========================================================= */

newReviewButton.addEventListener("click", () => {
    resetFile();
    resetReview();

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
});


/* =========================================================
   RUN POSTER REVIEW
========================================================= */

reviewButton.addEventListener("click", async () => {
    if (!currentFile) {
        return;
    }

    clearError();
    resetReview();

    reviewButton.disabled = true;

    try {
        setStatus(
            "Uploading your poster",
            "Securely preparing the PDF for analysis."
        );

        const uploadResult = await uploadPoster();

        setStatus(
            "Analyzing your poster",
            "Reviewing the content, structure, and visual presentation."
        );

        const reviewResult = await reviewPoster(
            uploadResult.poster_id
        );

        /*
         * The review is finished.
         * Remove the processing state entirely rather than
         * displaying the spinner as a completion indicator.
         */
        clearStatus();

        renderReview(reviewResult);

    } catch (error) {
        clearStatus();

        showError(
            error.message ||
            "Something went wrong while reviewing the poster."
        );

        reviewButton.disabled = false;
    }
});

